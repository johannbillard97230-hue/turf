"""Phase 2 reliability tests for TurfMetrics Pro.

Covers:
- warnings[0] headline format
- citations 0 vs None (N/D) distinction + no horse has None when source OK
- sexe_age regex ^[FHM]\\d+$ (never '?' prefix anymore)
- performances structure (position/type/year), alignment with last3
- year markers (YY) coherence (first perf is current year 2026)
- win_rate uses courses (not perf length)
- strict desc sort by valeur, None last
- save→get: performances persisted
- 3 sources all 'ok'
"""
from __future__ import annotations

import os
import re
import pathlib
from datetime import datetime

import pytest
import requests

_BU = os.environ.get("REACT_APP_BACKEND_URL")
if not _BU:
    env_path = pathlib.Path("/app/frontend/.env")
    for line in env_path.read_text().splitlines():
        if line.startswith("REACT_APP_BACKEND_URL="):
            _BU = line.split("=", 1)[1].strip()
            break
BASE_URL = (_BU or "").rstrip("/")
API = f"{BASE_URL}/api"
TIMEOUT = 60
CURRENT_YEAR = datetime.utcnow().year  # expected 2026


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def current(session):
    r = session.get(f"{API}/analysis/current", timeout=TIMEOUT)
    assert r.status_code == 200, r.text[:400]
    return r.json()


# ---------------------------------------------------------------
# Warnings headline
# ---------------------------------------------------------------
class TestHeadline:
    def test_headline_format(self, current):
        w = current["warnings"]
        assert w and isinstance(w, list)
        head = w[0]
        # Expected: "N chevaux analysés — X sans citation (0) — Y citations N/D — E erreur(s) de récupération"
        pat = re.compile(
            r"^(\d+)\s+chevaux analysés\s+—\s+(\d+)\s+sans citation\s+\(0\)\s+—\s+(\d+)\s+citations\s+N/D\s+—\s+(\d+)\s+erreur\(s\)\s+de récupération$"
        )
        assert pat.match(head), f"headline mismatch: {head!r}"
        n = int(pat.match(head).group(1))
        assert n == len(current["horses"])


# ---------------------------------------------------------------
# Citations 0 vs N/D
# ---------------------------------------------------------------
class TestCitations:
    def test_no_none_when_source_ok(self, current):
        if current["sources"]["pronostics_citations"]["status"] != "ok":
            pytest.skip("citations source not ok")
        for h in current["horses"]:
            assert h["citations"] is not None, f"horse #{h['number']} citations is None but source ok"
            assert isinstance(h["citations"], int) and h["citations"] >= 0

    def test_zero_is_integer_not_none(self, current):
        # Just type-check: anywhere citations == 0 must be int (never null)
        for h in current["horses"]:
            if h["citations"] == 0:
                assert isinstance(h["citations"], int)


# ---------------------------------------------------------------
# Sexe/Âge format (no '?')
# ---------------------------------------------------------------
class TestSexeAge:
    def test_regex(self, current):
        pat = re.compile(r"^[FHM]\d+$")
        for h in current["horses"]:
            sa = h.get("sexe_age")
            if sa is None:
                continue
            assert pat.match(sa), f"bad sexe_age {sa!r} on horse #{h['number']}"
            assert "?" not in sa


# ---------------------------------------------------------------
# Performances structure & alignment with last3
# ---------------------------------------------------------------
class TestPerformances:
    def test_performances_present_when_musique(self, current):
        checked = 0
        for h in current["horses"]:
            if h.get("musique"):
                perfs = h.get("performances")
                assert isinstance(perfs, list), f"performances must be list for #{h['number']}"
                assert len(perfs) > 0, f"empty performances for #{h['number']} despite musique"
                for p in perfs:
                    assert "position" in p and "type" in p and "year" in p
                checked += 1
        assert checked > 0, "no horse had musique to validate"

    def test_last3_matches_performances(self, current):
        for h in current["horses"]:
            l3 = h.get("last3")
            perfs = h.get("performances") or []
            if not l3:
                continue
            expected = " - ".join(f"{p['position']}{p['type']}" for p in perfs[:3])
            assert l3 == expected, f"#{h['number']} last3={l3!r} vs perfs[:3]={expected!r}"

    def test_first_perf_is_current_year(self, current):
        found = 0
        for h in current["horses"]:
            perfs = h.get("performances") or []
            if not perfs:
                continue
            # First is the most recent
            y = perfs[0].get("year")
            assert y == CURRENT_YEAR, f"#{h['number']} first perf year={y}, expected {CURRENT_YEAR}"
            found += 1
        assert found > 0

    def test_year_markers_coherent(self, current):
        """When musique contains '(YY)' markers, perfs after that marker (chronologically) must have year 2000+YY."""
        marker_re = re.compile(r"\((\d{2})\)")
        checked = 0
        for h in current["horses"]:
            musique = h.get("musique") or ""
            years_in_order = [2000 + int(m.group(1)) for m in marker_re.finditer(musique)]
            if not years_in_order:
                continue
            perfs = h.get("performances") or []
            # The set of distinct years in perfs (after the current year prefix) must include the marker years.
            perf_years = [p["year"] for p in perfs]
            for y in years_in_order:
                assert y in perf_years, f"#{h['number']} marker year {y} missing from perf years {perf_years} (musique={musique!r})"
            checked += 1
        # Not fatal if no horse has markers today, but inform.
        if checked == 0:
            pytest.skip("no (YY) markers in today's musique strings")


# ---------------------------------------------------------------
# win_rate uses courses, not perf length
# ---------------------------------------------------------------
class TestWinRateUsesCourses:
    def test_perflen_not_equal_courses_for_some(self, current):
        diff = 0
        checked = 0
        for h in current["horses"]:
            c = h.get("courses")
            perfs = h.get("performances") or []
            if c is None:
                continue
            checked += 1
            if len(perfs) != c:
                diff += 1
        assert checked > 0
        # Musique strings are short (max ~15 perfs) while courses can be dozens.
        assert diff > 0, "expected at least one horse where len(performances) != courses"

    def test_formula(self, current):
        """win_rate must equal round((V+P)/C*100,1)."""
        for h in current["horses"]:
            v, p, c, wr = h.get("victoires"), h.get("places"), h.get("courses"), h.get("win_rate")
            if v is not None and p is not None and c is not None and c > 0:
                assert wr == round((v + p) / c * 100, 1), f"#{h['number']} wr={wr} V={v} P={p} C={c}"


# ---------------------------------------------------------------
# Strict sort
# ---------------------------------------------------------------
class TestSort:
    def test_strict_desc_none_last(self, current):
        horses = current["horses"]
        seen_none = False
        prev = None
        for h in horses:
            v = h.get("valeur")
            if v is None:
                seen_none = True
            else:
                assert not seen_none, "non-None valeur appears after None"
                if prev is not None:
                    assert v <= prev
                prev = v


# ---------------------------------------------------------------
# Save → GET round trip (performances persisted)
# ---------------------------------------------------------------
class TestPersistPerformances:
    def test_save_and_reload_preserves_performances(self, session):
        r = session.post(f"{API}/analysis/save", timeout=TIMEOUT)
        assert r.status_code == 200, r.text[:300]
        saved = r.json()
        sid = saved["id"]
        # pick a horse with non-empty performances
        pick = next((h for h in saved["horses"] if h.get("performances")), None)
        assert pick, "saved doc had no horse with performances"
        g = session.get(f"{API}/analysis/{sid}", timeout=TIMEOUT)
        assert g.status_code == 200
        doc = g.json()
        assert "_id" not in doc
        got_horse = next(h for h in doc["horses"] if h["number"] == pick["number"])
        assert got_horse["performances"] == pick["performances"], "performances not persisted intact"
        # also sexe_age/citations preserved
        assert got_horse["sexe_age"] == pick["sexe_age"]
        assert got_horse["citations"] == pick["citations"]


# ---------------------------------------------------------------
# Three sources all ok
# ---------------------------------------------------------------
class TestSources:
    def test_all_three_ok(self, current):
        src = current["sources"]
        for k in ("pronostics_valeur", "pronostics_citations", "paris_turf"):
            assert src[k]["status"] == "ok", f"source {k} status={src[k]['status']} msg={src[k].get('message')}"
