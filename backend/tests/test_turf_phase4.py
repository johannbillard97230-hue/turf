"""Phase 4 tests — cote evolution tracking (BAISSE/HAUSSE/STABLE/NOUVEAU) + idempotence."""
from __future__ import annotations

import os
import pathlib
import re
from datetime import datetime, timedelta, timezone

import pytest
import requests
from pymongo import MongoClient

# --- Config ---------------------------------------------------------------
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

# Mongo direct access for seeding cote_snapshots
be_env = pathlib.Path("/app/backend/.env").read_text().splitlines()
_env_map = {}
for line in be_env:
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1)
        _env_map[k.strip()] = v.strip().strip('"')
MONGO_URL = _env_map["MONGO_URL"]
DB_NAME = _env_map["DB_NAME"]


# --- Fixtures -------------------------------------------------------------
@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def mongo():
    cli = MongoClient(MONGO_URL)
    return cli[DB_NAME]


@pytest.fixture(scope="module")
def current(session):
    r = session.get(f"{API}/analysis/current", timeout=TIMEOUT)
    assert r.status_code == 200, r.text[:400]
    return r.json()


# --- 1. race_id + cote shape ---------------------------------------------
class TestRaceIdAndCoteShape:
    def test_race_id_hex16(self, current):
        rid = current["race"].get("race_id")
        assert isinstance(rid, str)
        assert re.fullmatch(r"[0-9a-f]{16}", rid), f"bad race_id={rid}"

    def test_race_id_stable(self, session, current):
        r2 = session.get(f"{API}/analysis/current", timeout=TIMEOUT)
        assert r2.status_code == 200
        assert r2.json()["race"]["race_id"] == current["race"]["race_id"]

    def test_each_horse_has_cote_object(self, current):
        for h in current["horses"]:
            assert "cote" in h and isinstance(h["cote"], dict)
            for k in (
                "cote", "cote_num", "previous_cote", "previous_cote_num",
                "delta", "pct_change", "direction", "is_first_sighting",
                "last_update", "previous_update",
            ):
                assert k in h["cote"], f"missing {k} in horse #{h['number']}"

    def test_cote_format_fr(self, current):
        pat = re.compile(r"^\d+(?:,\d)?/1$")
        for h in current["horses"]:
            c = h["cote"]
            if c.get("cote") is not None:
                assert pat.match(c["cote"]), f"#{h['number']} bad cote fmt {c['cote']}"
                assert isinstance(c["cote_num"], (int, float))

    def test_direction_in_allowed(self, current):
        allowed = {"BAISSE", "HAUSSE", "STABLE", "NOUVEAU", None}
        for h in current["horses"]:
            assert h["cote"]["direction"] in allowed


# --- 2. Seed-driven direction scenarios -----------------------------------
@pytest.fixture(scope="module")
def race_id_today(current):
    return current["race"]["race_id"]


@pytest.fixture(scope="module")
def horses_with_cote(current):
    return [h for h in current["horses"] if h["cote"].get("cote_num") is not None]


def _purge(mongo, race_id, horse_number):
    mongo.cote_snapshots.delete_many(
        {"race_id": race_id, "horse_number": horse_number}
    )


def _insert_snapshot(mongo, race_id, horse_number, cote_num, when):
    mongo.cote_snapshots.insert_one({
        "race_id": race_id,
        "horse_number": horse_number,
        "cote_num": cote_num,
        "cote_raw": f"{cote_num}/1",
        "created_at": when.isoformat(),
    })


def _get_horse(session, horse_number, retries=3):
    """GET /current with retries, returning the row for horse_number.
    Retries if the scraper flakes and returns no cote."""
    last = None
    for _ in range(retries):
        r = session.get(f"{API}/analysis/current", timeout=TIMEOUT)
        assert r.status_code == 200
        last = next((h for h in r.json()["horses"] if h["number"] == horse_number), None)
        if last and last.get("cote", {}).get("cote_num") is not None:
            return last, r.json()
    return last, (r.json() if r else None)


class TestDirectionScenarios:

    def test_baisse(self, session, mongo, race_id_today, horses_with_cote):
        if not horses_with_cote:
            pytest.skip("no cote today")
        target = horses_with_cote[0]
        n = target["number"]
        current_cote = float(target["cote"]["cote_num"])
        _purge(mongo, race_id_today, n)
        old_when = datetime.now(timezone.utc) - timedelta(hours=1)
        prev = max(current_cote * 10, current_cote + 26)
        _insert_snapshot(mongo, race_id_today, n, prev, old_when)

        horse, _ = _get_horse(session, n)
        c = (horse or {}).get("cote", {})
        if c.get("cote_num") is None:
            pytest.skip("scraper returned no cote (flaky scrape)")
        assert c["direction"] == "BAISSE", c
        assert c["delta"] < 0
        assert c["pct_change"] < 0
        assert c["previous_cote_num"] == pytest.approx(prev)


    def test_hausse(self, session, mongo, race_id_today, horses_with_cote):
        if len(horses_with_cote) < 2:
            pytest.skip("need 2 horses")
        target = horses_with_cote[1]
        n = target["number"]
        current_cote = float(target["cote"]["cote_num"])
        if current_cote <= 1:
            pytest.skip("current cote too low to seed HAUSSE")
        _purge(mongo, race_id_today, n)
        prev = max(0.5, current_cote / 2.0 - 0.1)
        if prev >= current_cote:
            prev = current_cote - 0.5
        _insert_snapshot(mongo, race_id_today, n, prev,
                               datetime.now(timezone.utc) - timedelta(hours=1))
        horse, _ = _get_horse(session, n)
        c = (horse or {}).get("cote", {})
        if c.get("cote_num") is None:
            pytest.skip("scraper returned no cote (flaky scrape)")
        assert c["direction"] == "HAUSSE", c
        assert c["delta"] > 0
        assert c["pct_change"] > 0


    def test_stable(self, session, mongo, race_id_today, horses_with_cote):
        if len(horses_with_cote) < 3:
            pytest.skip("need 3 horses")
        target = horses_with_cote[2]
        n = target["number"]
        current_cote = float(target["cote"]["cote_num"])
        _purge(mongo, race_id_today, n)
        _insert_snapshot(mongo, race_id_today, n, current_cote,
                               datetime.now(timezone.utc) - timedelta(hours=1))
        horse, _ = _get_horse(session, n)
        c = (horse or {}).get("cote", {})
        if c.get("cote_num") is None:
            pytest.skip("scraper returned no cote (flaky scrape)")
        assert c["direction"] == "STABLE", c
        assert c["previous_cote"] is None
        assert c["delta"] is None


    def test_nouveau(self, session, mongo, race_id_today, horses_with_cote):
        if len(horses_with_cote) < 4:
            pytest.skip("need 4 horses")
        target = horses_with_cote[3]
        n = target["number"]
        _purge(mongo, race_id_today, n)
        horse, _ = _get_horse(session, n)
        c = (horse or {}).get("cote", {})
        if c.get("cote_num") is None:
            pytest.skip("scraper returned no cote this time (flaky scrape)")
        assert c["direction"] == "NOUVEAU", c
        assert c["is_first_sighting"] is True


# --- 3. Idempotence (critical for StrictMode) -----------------------------
class TestIdempotence:

    def test_two_consecutive_identical(self, session, mongo, race_id_today, horses_with_cote):
        """After a BAISSE/HAUSSE is observed, a second /current without real
        cote change must still return the same direction (no drift to STABLE)."""
        if not horses_with_cote:
            pytest.skip("no cote today")
        target = horses_with_cote[0]
        n = target["number"]
        current_cote = float(target["cote"]["cote_num"])
        _purge(mongo, race_id_today, n)
        _insert_snapshot(mongo, race_id_today, n, current_cote * 5 + 1,
                               datetime.now(timezone.utc) - timedelta(hours=2))

        horse1, _ = _get_horse(session, n)
        c1 = (horse1 or {}).get("cote", {})
        if c1.get("cote_num") is None:
            pytest.skip("scraper flaky")
        horse2, _ = _get_horse(session, n)
        c2 = (horse2 or {}).get("cote", {})
        if c2.get("cote_num") is None:
            pytest.skip("scraper flaky")
        assert c1["direction"] == c2["direction"] == "BAISSE"
        assert c1["delta"] == c2["delta"]
        assert c1["pct_change"] == c2["pct_change"]
        assert c1["previous_cote_num"] == c2["previous_cote_num"]


# --- 4. History endpoint --------------------------------------------------
class TestCoteHistory:
    def test_unknown_horse_empty_list(self, session, race_id_today):
        r = session.get(f"{API}/cotes/history/{race_id_today}/9999", timeout=TIMEOUT)
        assert r.status_code == 200
        assert r.json() == []


    def test_timeline_enriched(self, session, mongo, race_id_today, horses_with_cote):
        if not horses_with_cote:
            pytest.skip("no cote today")
        n = horses_with_cote[0]["number"]
        _purge(mongo, race_id_today, n)
        base = datetime.now(timezone.utc) - timedelta(hours=3)
        _insert_snapshot(mongo, race_id_today, n, 10.0, base)
        _insert_snapshot(mongo, race_id_today, n, 5.0, base + timedelta(minutes=10))
        _insert_snapshot(mongo, race_id_today, n, 7.0, base + timedelta(minutes=20))

        r = session.get(f"{API}/cotes/history/{race_id_today}/{n}", timeout=TIMEOUT)
        assert r.status_code == 200
        items = r.json()
        assert len(items) >= 3
        assert items[0]["direction"] == "NOUVEAU"
        assert items[0]["delta"] is None
        # second must be BAISSE (10 -> 5)
        assert items[1]["direction"] == "BAISSE"
        assert items[1]["delta"] == -5.0
        assert items[1]["pct_change"] == -50.0
        # third must be HAUSSE (5 -> 7)
        assert items[2]["direction"] == "HAUSSE"
        assert items[2]["delta"] == 2.0
        assert items[2]["pct_change"] == 40.0


# --- 5. Persistence of cote object via /save ------------------------------
class TestPersistCote:
    def test_save_reload_keeps_cote(self, session):
        r = session.post(f"{API}/analysis/save", timeout=TIMEOUT)
        assert r.status_code == 200
        saved = r.json()
        sid = saved["id"]
        g = session.get(f"{API}/analysis/{sid}", timeout=TIMEOUT)
        assert g.status_code == 200
        doc = g.json()
        assert "_id" not in doc
        for s_h, d_h in zip(saved["horses"], doc["horses"]):
            assert s_h["number"] == d_h["number"]
            assert s_h["cote"] == d_h["cote"], f"#{s_h['number']} cote mismatch"


# --- 6. Sort still by valeur DESC regardless of cote ---------------------
class TestSortLock:
    def test_order_by_valeur_desc(self, current):
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
