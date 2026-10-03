"""Phase 5 tests — PMU.fr official cote source (replacing Paris-Turf cote probable)."""
from __future__ import annotations

import os
import pathlib
import re
from datetime import datetime

import pytest
import requests
from pymongo import MongoClient

# --- Config ---------------------------------------------------------------
_BU = os.environ.get("REACT_APP_BACKEND_URL")
if not _BU:
    for line in pathlib.Path("/app/frontend/.env").read_text().splitlines():
        if line.startswith("REACT_APP_BACKEND_URL="):
            _BU = line.split("=", 1)[1].strip()
            break
BASE_URL = (_BU or "").rstrip("/")
API = f"{BASE_URL}/api"
TIMEOUT = 90

be_env = {}
for line in pathlib.Path("/app/backend/.env").read_text().splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1)
        be_env[k.strip()] = v.strip().strip('"')
MONGO_URL = be_env["MONGO_URL"]
DB_NAME = be_env["DB_NAME"]


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def mongo():
    return MongoClient(MONGO_URL)[DB_NAME]


@pytest.fixture(scope="module")
def current(session):
    r = session.get(f"{API}/analysis/current", timeout=TIMEOUT)
    assert r.status_code == 200, r.text[:400]
    return r.json()


# --- 1. New PMU cote source status ---------------------------------------
class TestPmuCotesSource:
    def test_pmu_cotes_present_in_sources(self, current):
        assert "pmu_cotes" in current["sources"]

    def test_pmu_cotes_status_ok(self, current):
        assert current["sources"]["pmu_cotes"]["status"] == "ok"

    def test_pmu_cotes_url_shape(self, current):
        url = current["sources"]["pmu_cotes"].get("url") or ""
        assert "offline.turfinfo.api.pmu.fr" in url
        assert "/participants" in url


# --- 2. Per-horse cote object source metadata ----------------------------
class TestPerHorseCoteSource:
    def test_horses_with_cote_have_source_pmu(self, current):
        horses = [h for h in current["horses"] if h["cote"].get("cote_num") is not None]
        assert len(horses) >= 1
        for h in horses:
            c = h["cote"]
            assert c.get("source") == "PMU.fr", f"#{h['number']} source={c.get('source')}"

    def test_source_url_shape(self, current):
        for h in current["horses"]:
            c = h["cote"]
            if c.get("cote_num") is None:
                continue
            assert "offline.turfinfo.api.pmu.fr" in (c.get("source_url") or "")

    def test_type_rapport_valid(self, current):
        for h in current["horses"]:
            c = h["cote"]
            if c.get("cote_num") is None:
                continue
            assert c.get("type_rapport") in {"DIRECT", "REFERENCE"}, \
                f"#{h['number']} type_rapport={c.get('type_rapport')}"

    def test_cote_time_iso_datetime(self, current):
        for h in current["horses"]:
            c = h["cote"]
            if c.get("cote_num") is None:
                continue
            ct = c.get("cote_time")
            assert isinstance(ct, str) and len(ct) >= 19
            # parseable
            datetime.fromisoformat(ct.replace("Z", "+00:00"))


# --- 3. Cote #3 cohérent avec PMU direct ---------------------------------
class TestHorse3CoherenceWithPmu:
    def test_horse3_matches_pmu_api(self, current):
        h3 = next((h for h in current["horses"] if h["number"] == 3), None)
        if not h3 or h3["cote"].get("cote_num") is None:
            pytest.skip("horse #3 not in current race or no cote")

        url = current["sources"]["pmu_cotes"]["url"]
        pmu = requests.get(url, timeout=30, headers={
            "User-Agent": "Mozilla/5.0", "Accept": "application/json"
        }).json()
        p3 = next((p for p in pmu.get("participants", []) if p.get("numPmu") == 3), None)
        assert p3 is not None
        rd = p3.get("dernierRapportDirect") or {}
        rr = p3.get("dernierRapportReference") or {}
        src = rd if rd.get("rapport") is not None else rr
        expected = float(src["rapport"])
        got = float(h3["cote"]["cote_num"])
        # Allow tiny drift (market can move between our request and theirs).
        # If more than one tick off, still require it to NOT be the old 52 paris-turf value.
        assert abs(got - expected) < 5.0, \
            f"cote #3 drifted too much: got {got} vs PMU {expected}"

    def test_horse3_not_52(self, current):
        h3 = next((h for h in current["horses"] if h["number"] == 3), None)
        if not h3 or h3["cote"].get("cote_num") is None:
            pytest.skip("no horse #3 or cote")
        assert h3["cote"]["cote_num"] != 52.0


# --- 4. Snapshot documents enriched with source fields --------------------
class TestSnapshotDocFields:
    def test_latest_snapshot_has_new_fields(self, current, mongo):
        rid = current["race"]["race_id"]
        # Take any horse with cote
        hwith = [h for h in current["horses"] if h["cote"].get("cote_num") is not None]
        assert hwith
        n = hwith[0]["number"]
        doc = mongo.cote_snapshots.find_one(
            {"race_id": rid, "horse_number": n},
            sort=[("created_at", -1)],
        )
        assert doc is not None
        for k in ("source", "source_url", "type_rapport",
                  "trend", "trend_pct", "cote_time", "created_at"):
            assert k in doc, f"missing {k}"
        assert doc["source"] == "PMU.fr"
        assert "offline.turfinfo.api.pmu.fr" in (doc["source_url"] or "")


# --- 5. /cotes/history returns new entries -------------------------------
class TestCotesHistoryEndpoint:
    def test_history_horse3(self, session, current):
        rid = current["race"]["race_id"]
        r = session.get(f"{API}/cotes/history/{rid}/3", timeout=TIMEOUT)
        assert r.status_code == 200
        data = r.json()
        # May be empty if #3 has no cote; otherwise should have entries
        h3 = next((h for h in current["horses"] if h["number"] == 3), None)
        if h3 and h3["cote"].get("cote_num") is not None:
            assert len(data) >= 1
            last = data[-1]
            for k in ("cote", "cote_num", "created_at", "direction"):
                assert k in last


# --- 6. Idempotence: two consecutive /current do not drift ----------------
class TestIdempotence:
    def test_two_calls_same_direction(self, session):
        r1 = session.get(f"{API}/analysis/current", timeout=TIMEOUT).json()
        r2 = session.get(f"{API}/analysis/current", timeout=TIMEOUT).json()
        m1 = {h["number"]: h["cote"] for h in r1["horses"]}
        m2 = {h["number"]: h["cote"] for h in r2["horses"]}
        for n, c1 in m1.items():
            c2 = m2.get(n)
            if not c2 or c1.get("cote_num") is None or c2.get("cote_num") is None:
                continue
            if c1["cote_num"] == c2["cote_num"]:
                # direction/delta/pct must be identical on no-change
                assert c1.get("direction") == c2.get("direction"), f"#{n}"
                assert c1.get("delta") == c2.get("delta"), f"#{n}"
                assert c1.get("pct_change") == c2.get("pct_change"), f"#{n}"


# --- 7. Ordering by valeur DESC unchanged ---------------------------------
class TestOrdering:
    def test_valeur_desc(self, current):
        vals = [h.get("valeur") for h in current["horses"]]
        non_null = [v for v in vals if v is not None]
        assert non_null == sorted(non_null, reverse=True)


# --- 8. Format FR of cote --------------------------------------------------
class TestCoteFrFormat:
    def test_format(self, current):
        pat = re.compile(r"^\d+(?:,\d)?/1$")
        for h in current["horses"]:
            c = h["cote"].get("cote")
            if c is None:
                continue
            assert pat.match(c), f"#{h['number']} bad format: {c}"
