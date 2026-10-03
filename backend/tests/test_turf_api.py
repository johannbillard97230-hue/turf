"""Backend tests for TurfMetrics Pro API.

Endpoints:
  GET  /api/analysis/current  - live scrape
  POST /api/analysis/save     - persist
  GET  /api/analysis/history  - list
  GET  /api/analysis/{id}     - fetch one (404 if unknown)
"""
import os
import re
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/") if os.environ.get("REACT_APP_BACKEND_URL") else None
if not BASE_URL:
    # Fallback: read frontend/.env
    import pathlib
    env_path = pathlib.Path("/app/frontend/.env")
    for line in env_path.read_text().splitlines():
        if line.startswith("REACT_APP_BACKEND_URL="):
            BASE_URL = line.split("=", 1)[1].strip().rstrip("/")
            break

API = f"{BASE_URL}/api"
TIMEOUT = 60  # scraping can be slow


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def current_analysis(session):
    r = session.get(f"{API}/analysis/current", timeout=TIMEOUT)
    assert r.status_code == 200, f"status={r.status_code} body={r.text[:300]}"
    return r.json()


# ----- GET /api/analysis/current -----
class TestCurrentAnalysis:
    def test_status_and_shape(self, current_analysis):
        d = current_analysis
        for key in ("race", "horses", "sources", "warnings"):
            assert key in d, f"missing key {key}"
        assert isinstance(d["horses"], list)
        assert isinstance(d["sources"], dict)
        assert isinstance(d["warnings"], list)

    def test_sources_three_keys(self, current_analysis):
        src = current_analysis["sources"]
        for k in ("pronostics_valeur", "pronostics_citations", "paris_turf"):
            assert k in src, f"missing source {k}"
            assert src[k]["status"] in ("ok", "partial", "error")

    def test_horses_sorted_desc_by_valeur_none_last(self, current_analysis):
        horses = current_analysis["horses"]
        assert len(horses) > 0, "no horses returned"
        # Build sort key: (valeur is None, -valeur or 0)
        prev = None
        seen_none = False
        for h in horses:
            v = h.get("valeur")
            if v is None:
                seen_none = True
            else:
                # No non-None valeur should appear after a None
                assert not seen_none, "horse with valeur appears after a None valeur"
                if prev is not None:
                    assert v <= prev, f"not desc: prev={prev} current={v}"
                prev = v

    def test_horse_fields_present(self, current_analysis):
        horses = current_analysis["horses"]
        required = {"number", "name", "valeur", "citations", "sexe_age",
                    "age", "courses", "victoires", "places", "win_rate",
                    "musique", "last3", "jockey", "entraineur"}
        for h in horses:
            missing = required - set(h.keys())
            assert not missing, f"horse missing fields {missing}: {h}"
            assert isinstance(h["number"], int)

    def test_win_rate_computation(self, current_analysis):
        """win_rate = (victoires + places) / courses * 100 rounded 1 decimal."""
        checked = 0
        for h in current_analysis["horses"]:
            v, p, c, wr = h.get("victoires"), h.get("places"), h.get("courses"), h.get("win_rate")
            if v is not None and p is not None and c is not None and c > 0:
                expected = round((v + p) / c * 100, 1)
                assert wr == expected, f"horse #{h['number']}: expected {expected} got {wr}"
                checked += 1
            else:
                assert wr is None, f"horse #{h['number']}: win_rate should be None"
        assert checked > 0, "no horse had enough data to check win_rate"

    def test_sexe_age_format(self, current_analysis):
        """sexe_age must be F/H/M + digits, or ?N (unknown sex), or None."""
        pattern = re.compile(r"^([FHM?])\d+$")
        for h in current_analysis["horses"]:
            sa = h.get("sexe_age")
            if sa is not None:
                assert pattern.match(sa), f"bad sexe_age format: {sa}"

    def test_last3_format(self, current_analysis):
        """last3 is 'Xp - Xp - Xp' pattern (type letter one of amhspco) when present."""
        for h in current_analysis["horses"]:
            l3 = h.get("last3")
            if l3 is not None:
                parts = l3.split(" - ")
                assert 1 <= len(parts) <= 3, f"bad last3 parts: {l3}"
                for p in parts:
                    assert re.match(r"^.+[amhspco]$", p), f"bad part '{p}' in last3='{l3}'"

    def test_race_has_partants_field(self, current_analysis):
        race = current_analysis["race"]
        # Should at least contain some meta
        assert isinstance(race, dict)


# ----- POST /api/analysis/save & history flow -----
class TestSaveAndHistory:
    saved_id = None

    def test_save(self, session):
        r = session.post(f"{API}/analysis/save", timeout=TIMEOUT)
        assert r.status_code == 200, r.text[:300]
        doc = r.json()
        assert "id" in doc and doc["id"]
        assert "horses" in doc
        assert "sources" in doc
        TestSaveAndHistory.saved_id = doc["id"]

    def test_history_contains_saved(self, session):
        assert TestSaveAndHistory.saved_id, "save test must run first"
        r = session.get(f"{API}/analysis/history", timeout=TIMEOUT)
        assert r.status_code == 200
        items = r.json()
        assert isinstance(items, list) and len(items) > 0
        ids = [it["id"] for it in items]
        assert TestSaveAndHistory.saved_id in ids
        # Verify sort desc by created_at
        created = [it["created_at"] for it in items if it.get("created_at")]
        assert created == sorted(created, reverse=True)
        # Expect summary fields
        first = items[0]
        for k in ("id", "created_at", "race", "nb_horses", "sources"):
            assert k in first

    def test_get_by_id(self, session):
        assert TestSaveAndHistory.saved_id
        r = session.get(f"{API}/analysis/{TestSaveAndHistory.saved_id}", timeout=TIMEOUT)
        assert r.status_code == 200
        doc = r.json()
        assert doc["id"] == TestSaveAndHistory.saved_id
        assert "horses" in doc
        # Must not leak Mongo _id
        assert "_id" not in doc

    def test_get_unknown_id_returns_404(self, session):
        r = session.get(f"{API}/analysis/does-not-exist-xyz", timeout=TIMEOUT)
        assert r.status_code == 404
