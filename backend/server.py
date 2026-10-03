from fastapi import FastAPI, APIRouter, HTTPException
from fastapi.encoders import jsonable_encoder
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import hashlib
import os
import logging
import asyncio
import uuid
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field, ConfigDict

from scrapers import (
    scrape_partants_valeur,
    scrape_citations,
    scrape_paris_turf,
    scrape_pmu_cotes,
    compute_win_rate,
)

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

app = FastAPI(title="TurfMetrics Pro API")
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


# -----------------------------
# Models
# -----------------------------
class Performance(BaseModel):
    model_config = ConfigDict(extra="ignore")
    position: str
    type: str
    year: int | None = None
    hippodrome: str | None = None
    distance: str | None = None
    date: str | None = None


class CoteEvolution(BaseModel):
    """Movement of the cote between the previous snapshot and the current one."""
    model_config = ConfigDict(extra="ignore")
    cote: str | None = None                 # formatted current cote (e.g. "2/1")
    cote_num: float | None = None           # numeric value
    previous_cote: str | None = None        # formatted previous cote
    previous_cote_num: float | None = None
    delta: float | None = None              # cote_num - previous_cote_num
    pct_change: float | None = None         # (cote - prev) / prev * 100, 1 decimal
    direction: Literal["BAISSE", "HAUSSE", "STABLE", "NOUVEAU"] | None = None
    is_first_sighting: bool = False
    last_update: datetime | None = None     # when this cote was observed (our fetch time)
    previous_update: datetime | None = None
    # Source tracking (added in V1.4 — official PMU API)
    source: str | None = None               # "PMU.fr" | "Paris-Turf" | None
    source_url: str | None = None
    cote_time: datetime | None = None       # timestamp reported BY the source
    type_rapport: str | None = None         # "DIRECT" | "REFERENCE"
    trend: str | None = None                # '+' | '-' | None (source-reported trend)
    trend_pct: float | None = None          # source-reported %


class HorseRow(BaseModel):
    model_config = ConfigDict(extra="ignore")
    number: int
    name: str | None = None
    valeur: int | None = None
    citations: int | None = None
    corde: int | None = None
    # corde_status: "ok" (number present), "na" (discipline without corde), "nd" (should be there but missing)
    corde_status: str | None = None
    sexe_age: str | None = None
    age: int | None = None
    courses: int | None = None
    victoires: int | None = None
    places: int | None = None
    win_rate: float | None = None
    musique: str | None = None
    last3: str | None = None
    performances: list[Performance] = Field(default_factory=list)
    days_since_last: int | None = None
    jockey: str | None = None
    entraineur: str | None = None
    cote: CoteEvolution = Field(default_factory=CoteEvolution)


SourceStatus = Literal["ok", "partial", "error"]


class SourceStatusInfo(BaseModel):
    status: SourceStatus
    message: str | None = None
    url: str | None = None


class RaceAnalysis(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    race: dict[str, Any]
    horses: list[HorseRow]
    sources: dict[str, SourceStatusInfo]
    warnings: list[str] = Field(default_factory=list)
    # Derived aggregates (for UI hints — never for sorting)
    stats: dict[str, Any] = Field(default_factory=dict)


# Disciplines that use a numéro de corde / stall number.
_CORDE_DISCIPLINES = {"plat", "haie", "haies", "steeple", "steeple-chase", "cross", "obstacle"}


def _corde_applicable(race_type: str | None) -> bool:
    if not race_type:
        return True  # unknown → assume applicable, missing data will show as N/D
    rt = race_type.strip().lower()
    # Trot: attelé / monté → no corde
    if "attel" in rt or "mont" in rt:
        return False
    return any(d in rt for d in _CORDE_DISCIPLINES)


# -----------------------------
# Cote tracking helpers
# -----------------------------
def _format_cote(cote_num: float | None) -> str | None:
    """Format a numeric cote back to the display form "N/1" or "N.M/1"."""
    if cote_num is None:
        return None
    if abs(cote_num - round(cote_num)) < 1e-6:
        return f"{int(round(cote_num))}/1"
    return f"{cote_num:.1f}".replace(".", ",") + "/1"


def _race_id(race_meta: dict) -> str | None:
    """Compute a stable race identifier from name + date so cotes can be grouped."""
    name = race_meta.get("name") or race_meta.get("paris_turf_title")
    date = race_meta.get("date")
    if not name or not date:
        return None
    raw = f"{name.strip().lower()}|{date}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


# Minimum time between two snapshots of the SAME cote value (seconds).
# Below this, redundant snapshots are not persisted but comparison still happens.
def _round_cote(x: float | None) -> float | None:
    """Round cote to 2 decimals — stored and compared value, to avoid float drift."""
    return round(float(x), 2) if x is not None else None


async def _track_cote(
    race_id: str,
    horse_number: int,
    cote_num: float | None,
    cote_raw: str | None,
    now: datetime,
    *,
    source: str | None = None,
    source_url: str | None = None,
    cote_time: datetime | None = None,
    type_rapport: str | None = None,
    trend: str | None = None,
    trend_pct: float | None = None,
) -> CoteEvolution:
    """Compare the new cote to the last DISTINCT cote and insert a snapshot only when the
    cote actually changed. This keeps the "last movement" visible across identical
    consecutive refreshes (and plays well with React StrictMode double-mount).

    Each snapshot is tagged with its source so historical records can be audited."""
    if cote_num is None:
        return CoteEvolution()
    cote_num = _round_cote(cote_num)

    # Latest snapshot overall (same source, could be same cote as now)
    base_query = {"race_id": race_id, "horse_number": horse_number}
    if source:
        base_query["source"] = source
    latest = await db.cote_snapshots.find_one(base_query, sort=[("created_at", -1)])
    # Latest snapshot whose cote differs from the current one (same source)
    diff_query = {**base_query, "cote_num": {"$ne": cote_num}}
    latest_diff = await db.cote_snapshots.find_one(diff_query, sort=[("created_at", -1)])

    formatted_now = _format_cote(cote_num)

    def _snapshot_doc() -> dict:
        return {
            "race_id": race_id,
            "horse_number": horse_number,
            "cote_num": cote_num,
            "cote_raw": cote_raw,
            "source": source,
            "source_url": source_url,
            "type_rapport": type_rapport,
            "trend": trend,
            "trend_pct": trend_pct,
            "cote_time": cote_time.isoformat() if cote_time else None,
            "created_at": now.isoformat(),
        }

    base_fields = dict(
        cote=formatted_now,
        cote_num=cote_num,
        source=source,
        source_url=source_url,
        cote_time=cote_time,
        type_rapport=type_rapport,
        trend=trend,
        trend_pct=trend_pct,
        last_update=now,
    )

    if latest is None:
        await db.cote_snapshots.insert_one(_snapshot_doc())
        return CoteEvolution(
            direction="NOUVEAU",
            is_first_sighting=True,
            **base_fields,
        )

    cote_changed = abs(float(latest.get("cote_num", 0)) - cote_num) > 1e-6
    if cote_changed:
        await db.cote_snapshots.insert_one(_snapshot_doc())

    if latest_diff is None:
        return CoteEvolution(
            direction="STABLE",
            is_first_sighting=False,
            **base_fields,
        )

    prev_num = float(latest_diff.get("cote_num"))
    prev_dt_raw = latest_diff.get("created_at")
    prev_dt = datetime.fromisoformat(prev_dt_raw) if isinstance(prev_dt_raw, str) else prev_dt_raw

    delta = round(cote_num - prev_num, 2)
    pct_change = round((cote_num - prev_num) / prev_num * 100, 1) if prev_num > 0 else None
    if delta < 0:
        direction = "BAISSE"
    elif delta > 0:
        direction = "HAUSSE"
    else:
        direction = "STABLE"

    return CoteEvolution(
        previous_cote=_format_cote(prev_num),
        previous_cote_num=prev_num,
        delta=delta,
        pct_change=pct_change,
        direction=direction,
        is_first_sighting=False,
        previous_update=prev_dt,
        **base_fields,
    )


# -----------------------------
# Core analysis logic
# -----------------------------
async def _run_scrapers() -> tuple[dict, dict, dict, dict]:
    """Run three content scrapers in parallel. Return (partants_result, citations_result, pt_result, status_dict).

    Note: PMU cote scraping is run AFTER these three in _build_analysis because it needs
    the race metadata (date, hippodrome, partants) resolved from pronostics-turf first.
    """
    results = await asyncio.gather(
        scrape_partants_valeur(),
        scrape_citations(),
        scrape_paris_turf(),
        return_exceptions=True,
    )

    def _ok(r):
        return not isinstance(r, Exception) and r

    statuses: dict[str, SourceStatusInfo] = {}

    p_res = results[0] if _ok(results[0]) else None
    statuses["pronostics_valeur"] = SourceStatusInfo(
        status="ok" if p_res and p_res.get("horses") else "error",
        message=None if p_res else f"{type(results[0]).__name__}: {results[0]}",
        url="https://www.pronostics-turf.info/presse-partants-pmu.php",
    )

    c_res = results[1] if _ok(results[1]) else {}
    statuses["pronostics_citations"] = SourceStatusInfo(
        status="ok" if c_res else "error",
        message=None if c_res else f"{type(results[1]).__name__}: {results[1]}",
        url="https://www.pronostics-turf.info/",
    )

    pt_res = results[2] if _ok(results[2]) else None
    statuses["paris_turf"] = SourceStatusInfo(
        status="ok" if pt_res and pt_res.get("horses") else "error",
        message=None if pt_res else f"{type(results[2]).__name__}: {results[2]}",
        url="https://www.paris-turf.com/quinte/aujourdhui",
    )

    return p_res or {}, c_res or {}, pt_res or {}, statuses


def _merge_horses(
    partants: dict,
    citations: dict,
    paris_turf: dict,
    citations_ok: bool,
    corde_applicable: bool,
) -> list[HorseRow]:
    horses_src = partants.get("horses", []) or []
    pt_horses = paris_turf.get("horses", {}) or {}

    def _corde_fields(pt: dict) -> tuple[int | None, str]:
        if not corde_applicable:
            return None, "na"
        c = pt.get("corde") if pt else None
        if c is None:
            return None, "nd"
        return c, "ok"

    rows: list[HorseRow] = []
    for h in horses_src:
        number = h["number"]
        pt = pt_horses.get(number, {})

        # Sexe/âge: ONLY from Paris-Turf. Never infer from name or mix sources.
        sexe_age = pt.get("sexe_age")

        # Citations:
        #   - source OK and horse present  -> real value
        #   - source OK and horse absent   -> 0 (horse was not cited)
        #   - source failed                -> None (will render as N/D)
        if citations_ok:
            citations_value = citations.get(number, 0)
        else:
            citations_value = citations.get(number)  # may be None

        perfs = [Performance(**p) for p in pt.get("performances", [])]
        corde, corde_status = _corde_fields(pt)

        row = HorseRow(
            number=number,
            name=h.get("name"),
            valeur=h.get("valeur"),
            citations=citations_value,
            corde=corde,
            corde_status=corde_status,
            sexe_age=sexe_age,
            age=h.get("age"),
            courses=h.get("courses"),
            victoires=h.get("victoires"),
            places=h.get("places"),
            win_rate=compute_win_rate(h),
            musique=pt.get("musique"),
            last3=pt.get("last3"),
            performances=perfs,
            days_since_last=pt.get("days_since_last"),
            jockey=h.get("jockey"),
            entraineur=h.get("entraineur"),
        )
        rows.append(row)

    # Edge case: horses present on Paris-Turf but not on Pronostics-Turf
    existing_numbers = {r.number for r in rows}
    for num, pt in pt_horses.items():
        if num in existing_numbers:
            continue
        perfs = [Performance(**p) for p in pt.get("performances", [])]
        corde, corde_status = _corde_fields(pt)
        rows.append(HorseRow(
            number=num,
            name=pt.get("name_pt"),
            sexe_age=pt.get("sexe_age"),
            corde=corde,
            corde_status=corde_status,
            citations=(citations.get(num, 0) if citations_ok else citations.get(num)),
            musique=pt.get("musique"),
            last3=pt.get("last3"),
            performances=perfs,
            days_since_last=pt.get("days_since_last"),
        ))

    # Sort by valeur desc, None last.
    rows.sort(key=lambda r: (r.valeur is None, -(r.valeur or 0)))
    return rows


def _derive_warnings(rows: list[HorseRow], statuses: dict[str, SourceStatusInfo]) -> list[str]:
    warnings: list[str] = []

    nb_horses = len(rows)
    errors = [k for k, v in statuses.items() if v.status == "error"]
    missing_val = sum(1 for r in rows if r.valeur is None)
    uncited = sum(1 for r in rows if r.citations == 0)
    nd_citations = sum(1 for r in rows if r.citations is None)
    missing_sa = sum(1 for r in rows if r.sexe_age is None)
    missing_last3 = sum(1 for r in rows if not r.last3)
    missing_rate = sum(1 for r in rows if r.win_rate is None)

    # Headline summary (always first)
    headline = (
        f"{nb_horses} chevaux analysés — "
        f"{uncited} sans citation (0) — "
        f"{nd_citations} citations N/D — "
        f"{len(errors)} erreur(s) de récupération"
    )
    warnings.append(headline)

    for key in errors:
        warnings.append(f"Source indisponible : {key}")
    if missing_val:
        warnings.append(f"{missing_val} cheval(aux) sans valeur disponible")
    if missing_sa:
        warnings.append(f"{missing_sa} cheval(aux) sans Sexe/Âge (Paris-Turf)")
    if missing_last3:
        warnings.append(f"{missing_last3} cheval(aux) sans musique exploitable")
    if missing_rate:
        warnings.append(f"{missing_rate} cheval(aux) sans statistiques courses/victoires/places")

    return warnings


async def _build_analysis() -> RaceAnalysis:
    partants, citations, paris_turf, statuses = await _run_scrapers()
    citations_ok = statuses["pronostics_citations"].status == "ok"

    race_meta = partants.get("race", {}) or {}
    if paris_turf.get("race", {}).get("title"):
        race_meta["paris_turf_title"] = paris_turf["race"]["title"]

    corde_applicable = _corde_applicable(race_meta.get("type"))
    race_meta["corde_applicable"] = corde_applicable
    race_id = _race_id(race_meta)
    race_meta["race_id"] = race_id

    rows = _merge_horses(partants, citations, paris_turf, citations_ok, corde_applicable)

    # Attach cote evolution per horse (reads previous snapshot + persists new one).
    # Cote is fetched from the official PMU.fr public API (not from Paris-Turf's "cote
    # probable" estimate anymore).
    if race_id is not None:
        now = datetime.now(timezone.utc)
        pmu_cotes_result: dict = {}
        try:
            pmu_cotes_result = await scrape_pmu_cotes(race_meta)
        except Exception as e:
            logger.warning("PMU cotes scrape failed: %s", e)
            pmu_cotes_result = {"source": "PMU.fr", "horses": {}, "error": str(e)}

        statuses["pmu_cotes"] = SourceStatusInfo(
            status="ok" if pmu_cotes_result.get("horses") else "error",
            message=pmu_cotes_result.get("error"),
            url=pmu_cotes_result.get("race_url") or "https://www.pmu.fr/",
        )
        pmu_horses = pmu_cotes_result.get("horses", {}) or {}
        source_label = pmu_cotes_result.get("source") or "PMU.fr"
        source_url = pmu_cotes_result.get("race_url")

        for row in rows:
            pmu = pmu_horses.get(row.number) or {}
            cote_time_raw = pmu.get("cote_update")
            cote_time = (
                datetime.fromisoformat(cote_time_raw)
                if isinstance(cote_time_raw, str)
                else None
            )
            evo = await _track_cote(
                race_id=race_id,
                horse_number=row.number,
                cote_num=pmu.get("cote_num"),
                cote_raw=pmu.get("cote_raw"),
                now=now,
                source=source_label,
                source_url=source_url,
                cote_time=cote_time,
                type_rapport=pmu.get("type_rapport"),
                trend=pmu.get("trend"),
                trend_pct=pmu.get("trend_pct"),
            )
            row.cote = evo

    # Per-source status refinement based on merged content
    if statuses["pronostics_valeur"].status == "ok" and not any(r.valeur for r in rows):
        statuses["pronostics_valeur"].status = "partial"
    if statuses["paris_turf"].status == "ok" and not any(r.sexe_age or r.last3 for r in rows):
        statuses["paris_turf"].status = "partial"

    # Derived aggregates — purely informative, never used for sorting.
    vict_values = [r.victoires for r in rows if r.victoires is not None]
    stats = {
        "max_victoires": max(vict_values) if vict_values else None,
    }

    warnings = _derive_warnings(rows, statuses)

    return RaceAnalysis(
        race=race_meta,
        horses=rows,
        sources=statuses,
        warnings=warnings,
        stats=stats,
    )


# -----------------------------
# Routes
# -----------------------------
@api_router.get("/")
async def root():
    return {"service": "TurfMetrics Pro API", "status": "ok"}


@api_router.get("/analysis/current")
async def get_current_analysis():
    """Scrape all 3 sources and return the live analysis (not persisted)."""
    try:
        analysis = await _build_analysis()
    except Exception as e:
        logger.exception("Failed to build live analysis")
        raise HTTPException(status_code=502, detail=f"Scraping failure: {e}")
    return jsonable_encoder(analysis.model_dump())


@api_router.post("/analysis/save")
async def save_analysis():
    """Scrape + persist to MongoDB. Returns the saved analysis."""
    analysis = await _build_analysis()
    doc = jsonable_encoder(analysis.model_dump())
    doc["created_at"] = analysis.created_at.isoformat()
    await db.race_analyses.insert_one({**doc, "_pk": analysis.id})
    return doc


@api_router.get("/analysis/history")
async def list_history(limit: int = 30):
    cursor = db.race_analyses.find({}, {"_id": 0}).sort("created_at", -1).limit(limit)
    items = await cursor.to_list(length=limit)
    # Return trimmed summary
    out = []
    for it in items:
        out.append({
            "id": it.get("id"),
            "created_at": it.get("created_at"),
            "race": it.get("race"),
            "nb_horses": len(it.get("horses", [])),
            "sources": it.get("sources"),
        })
    return out


@api_router.get("/analysis/{analysis_id}")
async def get_analysis(analysis_id: str):
    doc = await db.race_analyses.find_one({"id": analysis_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Analysis not found")
    return doc


@api_router.get("/cotes/history/{race_id}/{horse_number}")
async def get_cote_history(race_id: str, horse_number: int, limit: int = 200):
    """Full timeline of cote snapshots for a given horse in a given race."""
    cursor = (
        db.cote_snapshots.find(
            {"race_id": race_id, "horse_number": horse_number},
            {"_id": 0},
        )
        .sort("created_at", 1)
        .limit(limit)
    )
    items = await cursor.to_list(length=limit)
    enriched = []
    prev_num: float | None = None
    prev_dt: str | None = None
    for it in items:
        num = float(it.get("cote_num"))
        ts = it.get("created_at")
        delta = round(num - prev_num, 2) if prev_num is not None else None
        pct = (
            round((num - prev_num) / prev_num * 100, 1)
            if prev_num is not None and prev_num > 0
            else None
        )
        if delta is None:
            direction = "NOUVEAU"
        elif delta < 0:
            direction = "BAISSE"
        elif delta > 0:
            direction = "HAUSSE"
        else:
            direction = "STABLE"
        enriched.append({
            "horse_number": horse_number,
            "race_id": race_id,
            "cote": _format_cote(num),
            "cote_num": num,
            "cote_raw": it.get("cote_raw"),
            "created_at": ts,
            "previous_cote_num": prev_num,
            "previous_update": prev_dt,
            "delta": delta,
            "pct_change": pct,
            "direction": direction,
        })
        prev_num = num
        prev_dt = ts
    return enriched


app.include_router(api_router)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
