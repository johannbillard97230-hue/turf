"""Phase 3 tests for TurfMetrics Pro — corde column + max_victoires highlight."""
from __future__ import annotations

import os
import pathlib

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


class TestStatsMaxVictoires:
    def test_max_victoires_present(self, current):
        assert "stats" in current
        assert "max_victoires" in current["stats"]

    def test_max_victoires_equals_actual_max(self, current):
        vs = [h["victoires"] for h in current["horses"] if h.get("victoires") is not None]
        expected = max(vs) if vs else None
        assert current["stats"]["max_victoires"] == expected


class TestCordeApplicable:
    def test_flag_present(self, current):
        assert "corde_applicable" in current["race"]

    def test_flag_matches_type(self, current):
        rt = (current["race"].get("type") or "").lower()
        flag = current["race"]["corde_applicable"]
        if "attel" in rt or "mont" in rt:
            assert flag is False
        elif any(d in rt for d in ("plat", "haie", "steeple", "cross", "obstacle")):
            assert flag is True


class TestHorseCordeFields:
    def test_each_horse_has_corde_status(self, current):
        allowed = {"ok", "nd", "na"}
        for h in current["horses"]:
            assert h.get("corde_status") in allowed, f"#{h['number']} status={h.get('corde_status')}"

    def test_plat_never_na(self, current):
        if not current["race"].get("corde_applicable"):
            pytest.skip("not a corde-applicable race today")
        for h in current["horses"]:
            assert h["corde_status"] in {"ok", "nd"}, f"#{h['number']} unexpected na in plat race"

    def test_corde_int_when_ok(self, current):
        for h in current["horses"]:
            if h.get("corde_status") == "ok":
                assert isinstance(h.get("corde"), int)
            else:
                assert h.get("corde") is None

    def test_at_least_some_corde_ok_today(self, current):
        """For today's known Plat race, we expect most horses to have a corde value from PT."""
        if not current["race"].get("corde_applicable"):
            pytest.skip("not corde-applicable")
        ok = sum(1 for h in current["horses"] if h["corde_status"] == "ok")
        assert ok > 0, "expected at least one horse to have scraped corde value"


class TestSortUnchanged:
    def test_desc_by_valeur(self, current):
        prev = None
        seen_none = False
        for h in current["horses"]:
            v = h.get("valeur")
            if v is None:
                seen_none = True
            else:
                assert not seen_none
                if prev is not None:
                    assert v <= prev
                prev = v


class TestPersistCordeAndStats:
    def test_save_and_reload(self, session):
        r = session.post(f"{API}/analysis/save", timeout=TIMEOUT)
        assert r.status_code == 200
        saved = r.json()
        sid = saved["id"]
        g = session.get(f"{API}/analysis/{sid}", timeout=TIMEOUT)
        assert g.status_code == 200
        doc = g.json()
        assert "_id" not in doc
        # stats persisted
        assert doc["stats"]["max_victoires"] == saved["stats"]["max_victoires"]
        # race.corde_applicable persisted
        assert doc["race"]["corde_applicable"] == saved["race"]["corde_applicable"]
        # horse corde fields persisted
        for s_h, d_h in zip(saved["horses"], doc["horses"]):
            assert s_h["number"] == d_h["number"]
            assert s_h["corde"] == d_h["corde"]
            assert s_h["corde_status"] == d_h["corde_status"]
