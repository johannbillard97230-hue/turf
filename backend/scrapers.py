"""Scrapers for PMU horse racing data via r.jina.ai markdown proxy.

Three sources:
- Pronostics-Turf partants (/presse-partants-pmu.php) → valeur, âge, courses/victoires/places
- Pronostics-Turf home (/) → nombre de citations
- Paris-Turf (quinte/aujourdhui) → sexe/âge, musique
"""
import re
import asyncio
import logging
from typing import Any
import httpx

logger = logging.getLogger(__name__)

# Baseline Jina Reader headers (minimal UA, raw HTML parsing by Jina).
JINA_HEADERS_BASE = {
    "User-Agent": "curl/8.4.0",
    "Accept": "*/*",
}
# For sites protected by Cloudflare (paris-turf), ask Jina to render via headless browser.
JINA_HEADERS_RENDERED = {
    **JINA_HEADERS_BASE,
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    "X-Return-Format": "markdown",
    "X-Timeout": "30",
}
TIMEOUT = httpx.Timeout(45.0, connect=10.0)


async def _fetch(url: str, rendered: bool = False, retries: int = 2) -> str:
    headers = JINA_HEADERS_RENDERED if rendered else JINA_HEADERS_BASE
    last_exc: Exception | None = None
    for attempt in range(retries + 1):
        try:
            async with httpx.AsyncClient(
                headers=headers, timeout=TIMEOUT, follow_redirects=True, http2=False
            ) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                body = resp.text
                if "Just a moment" in body[:400] and len(body) < 2000:
                    raise httpx.HTTPError("Jina upstream Cloudflare stub")
                return body
        except Exception as e:
            last_exc = e
            if attempt < retries:
                await asyncio.sleep(1.5 * (attempt + 1))
    assert last_exc is not None
    raise last_exc


def _jina(target: str) -> str:
    return f"https://r.jina.ai/{target}"


# ---------------------------------------------------------------------------
# Source 1 — Pronostics-Turf partants (valeur, âge, courses/vict/places)
# ---------------------------------------------------------------------------
async def scrape_partants_valeur() -> dict[str, Any]:
    url = "https://www.pronostics-turf.info/presse-partants-pmu.php"
    md = await _fetch(_jina(url))

    race: dict[str, Any] = {}

    # Race name: "## Prix ..."
    m = re.search(r"^##\s+(Prix[^\n]+)", md, re.MULTILINE)
    if m:
        race["name"] = m.group(1).strip()

    # Hippodrome + date: "### à XXXX Samedi le DD - MM - YYYY"
    m = re.search(
        r"###\s+à\s+([A-ZÉÈÀÂÊÎÔÛÇ'’\- ]+?)\s+\w+\s+le\s+(\d{1,2}\s*-\s*\d{1,2}\s*-\s*\d{4})",
        md,
    )
    if m:
        race["hippodrome"] = m.group(1).strip().title()
        race["date"] = m.group(2).replace(" ", "")

    # Distance / allocation / discipline
    m = re.search(
        r"Distance:\s*(\d+)\s*mètres\s*-\s*Allocation:\s*(\d+)\s*euros\s*»\s*(\w+)",
        md,
    )
    if m:
        race["distance"] = f"{m.group(1)}m"
        race["allocation"] = f"{int(m.group(2)):,}€".replace(",", " ")
        race["type"] = m.group(3)

    # Partants count
    m = re.search(r"(\d+)\s+PARTANTS", md)
    if m:
        race["partants"] = int(m.group(1))

    # Horses — split on bold horse headers:
    # **N » Name (sa valeur: VVVV)**
    horses: list[dict[str, Any]] = []
    horse_re = re.compile(r"\*\*(\d+)\s*»\s*(.+?)\s*\(sa valeur:\s*(\d+)\)\*\*")

    matches = list(horse_re.finditer(md))
    for i, m in enumerate(matches):
        number = int(m.group(1))
        name = m.group(2).strip()
        valeur = int(m.group(3))

        # Take the chunk until the next horse header (or end)
        end = matches[i + 1].start() if i + 1 < len(matches) else min(m.end() + 1200, len(md))
        chunk = md[m.end() : end]

        age = _re_int(r"Age:\s*(\d+)", chunk)
        courses = _re_int(r"Courses:\s*(\d+)", chunk)
        victoires = _re_int(r"Victoires:\s*(\d+)", chunk)
        places = _re_int(r"Places:\s*(\d+)", chunk)
        jockey = _re_str(r"Jockey/Driver:\s*([^-\n]+?)\s*-\s*Entraîneur", chunk)
        entraineur = _re_str(r"Entraîneur:\s*([^-\n]+?)\s*-\s*Gains", chunk)
        if not entraineur:
            entraineur = _re_str(r"Entraîneur:\s*([^-\n]+)", chunk)

        horses.append({
            "number": number,
            "name": name,
            "age": age,
            "valeur": valeur,
            "courses": courses,
            "victoires": victoires,
            "places": places,
            "jockey": jockey,
            "entraineur": entraineur,
        })

    # De-dup by number (keep first occurrence)
    seen: dict[int, dict[str, Any]] = {}
    for h in horses:
        seen.setdefault(h["number"], h)
    horses = list(seen.values())

    return {"race": race, "horses": horses, "source_url": url}


def _re_int(pattern: str, text: str) -> int | None:
    m = re.search(pattern, text)
    return int(m.group(1)) if m else None


def _re_str(pattern: str, text: str) -> str | None:
    m = re.search(pattern, text)
    return m.group(1).strip() if m else None


# ---------------------------------------------------------------------------
# Source 2 — Pronostics-Turf home (citations)
# ---------------------------------------------------------------------------
async def scrape_citations() -> dict[int, int]:
    url = "https://www.pronostics-turf.info/"
    md = await _fetch(_jina(url))

    citations: dict[int, int] = {}

    # Lines like: "![Image N: Pronostic K](...pronostic-K.gif)A B" where A=horse number, B=citations.
    # Or multi-line variant. Use a tolerant pattern.
    pattern = re.compile(
        r"pronostic-(\d+)\.gif\)[^\n]*?\s*(\d+)\s+(\d+)",
        re.IGNORECASE,
    )
    for m in pattern.finditer(md):
        horse_num = int(m.group(2))
        count = int(m.group(3))
        # Keep first occurrence (positions 1..17 are ordered from top)
        citations.setdefault(horse_num, count)

    return citations


# ---------------------------------------------------------------------------
# Source 3 — Paris-Turf (sexe/âge + musique)
# ---------------------------------------------------------------------------
async def scrape_paris_turf(include_cote: bool = False) -> dict[str, Any]:
    """Paris-Turf scraper (sexe/âge + corde + musique).

    NOTE: cote is NOT read from Paris-Turf anymore. Their table displays the
    "cote probable" (static estimate), which drifts from the real live PMU cote
    by several points. Live cotes now come from the PMU.fr official API
    (`scrape_pmu_cotes`). `include_cote=True` keeps the legacy behavior for tests.
    """
    target = "https://www.paris-turf.com/quinte/aujourdhui"
    md = await _fetch(_jina(target), rendered=True)

    race: dict[str, Any] = {}
    m = re.search(r"^Title:\s*(.+)$", md, re.MULTILINE)
    if m:
        race["title"] = m.group(1).strip()

    horses_map: dict[int, dict[str, Any]] = {}

    row_re = re.compile(r"^\|\s*\[(\d+)\s.*?\]\([^)]+\)\s*\|(.+)\|\s*$", re.MULTILINE)

    def _cell_text(cell: str) -> str:
        txt = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", cell)
        txt = re.sub(r"!\[[^\]]*\]", "", txt)
        return txt.strip()

    for match in row_re.finditer(md):
        number = int(match.group(1))
        rest = match.group(2)
        cells = [c.strip() for c in rest.split("|")]
        if len(cells) < 3:
            continue
        name = _cell_text(cells[0]) if cells else ""

        # Find SA cell (F|H|M + digits) and remember its index so we can look up Corde right after.
        sexe_age = None
        sa_idx = None
        for i, c in enumerate(cells):
            txt = _cell_text(c)
            m2 = re.match(r"^([FHM])\s*(\d+)$", txt)
            if m2:
                sexe_age = f"{m2.group(1)}{m2.group(2)}"
                sa_idx = i
                break

        # Corde (numéro de stalle). On Paris-Turf, the "Cor." column sits right after "SA" for
        # disciplines that have one (Plat). For Trot/Obstacle it is absent → the cell either
        # does not exist or is empty.
        corde = None
        if sa_idx is not None and sa_idx + 1 < len(cells):
            cor_txt = _cell_text(cells[sa_idx + 1])
            m3 = re.match(r"^(\d{1,2})$", cor_txt)
            if m3:
                corde = int(m3.group(1))

        # Cote: last numeric cell of the row. KEPT for backwards compatibility only;
        # the primary cote source is now the PMU.fr official API (scrape_pmu_cotes).
        # Paris-Turf's "Cote" column is actually a "cote probable" estimate and often
        # drifts from the real live PMU cote by several points.
        cote_raw = None
        cote_num = None
        if include_cote:
            for c in reversed(cells):
                txt = _cell_text(c)
                if not txt or txt == "-":
                    continue
                m4 = re.match(r"^(\d+(?:[,\.]\d+)?)$", txt)
                if m4:
                    cote_raw = txt
                    cote_num = float(m4.group(1).replace(",", "."))
                    break

        # Find musique cell (contains Nj• pattern)
        musique_raw = None
        days_since_last = None
        for c in cells:
            txt = _cell_text(c)
            mdays = re.match(r"^\s*(\d+)\s*j\s*[•·]", txt)
            if mdays:
                musique_raw = txt
                days_since_last = int(mdays.group(1))
                break
        performances = _parse_performances(musique_raw) if musique_raw else []
        last3 = _format_last3(performances)

        horses_map[number] = {
            "sexe_age": sexe_age,
            "corde": corde,
            "cote_raw": cote_raw,
            "cote_num": cote_num,
            "musique": musique_raw,
            "days_since_last": days_since_last,
            "performances": performances,
            "last3": last3,
            "name_pt": name,
        }

    return {"race": race, "horses": horses_map, "source_url": target}


# ---------------------------------------------------------------------------
# Source 4 — PMU.fr official API (live cotes)
# ---------------------------------------------------------------------------
PMU_API_BASE = "https://offline.turfinfo.api.pmu.fr/rest/client/61"


async def _fetch_pmu(url: str, retries: int = 2) -> dict:
    """Fetch a PMU.fr JSON endpoint (public, no auth, no proxy needed)."""
    headers = {
        "User-Agent": "Mozilla/5.0 (Linux; x86_64) AppleWebKit/537.36",
        "Accept": "application/json",
    }
    last_exc: Exception | None = None
    for attempt in range(retries + 1):
        try:
            async with httpx.AsyncClient(
                headers=headers, timeout=TIMEOUT, follow_redirects=True, http2=False
            ) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            last_exc = e
            if attempt < retries:
                await asyncio.sleep(1.0 * (attempt + 1))
    assert last_exc is not None
    raise last_exc


def _match_pmu_race(programme: dict, race_meta: dict) -> tuple[int, int] | None:
    """Locate (reunion_num, course_num) matching our target race in the PMU programme.

    Matches by: specialite == PLAT/TROT/etc, hippodrome (if present in race_meta),
    nombreDeclaresPartants == race_meta.partants.
    """
    partants = race_meta.get("partants")
    hippo_target = (race_meta.get("hippodrome") or "").upper().replace(" ", "").replace("-", "")
    for r in programme.get("programme", {}).get("reunions", []):
        hippo = (r.get("hippodrome", {}).get("libelleCourt", "") or "").upper()
        hippo_norm = hippo.replace(" ", "").replace("-", "")
        for c in r.get("courses", []):
            if partants and c.get("nombreDeclaresPartants") != partants:
                continue
            if hippo_target and hippo_target not in hippo_norm and hippo_norm not in hippo_target:
                continue
            return r["numOfficiel"], c["numOrdre"]
    # Fallback: first race with Quinté+ attribute
    for r in programme.get("programme", {}).get("reunions", []):
        for c in r.get("courses", []):
            if c.get("categorieParticularite") in ("QUINTE_PLUS",) or c.get("paris"):
                for p in c.get("paris", []):
                    if p.get("typePari") == "QUINTE_PLUS":
                        return r["numOfficiel"], c["numOrdre"]
    return None


async def scrape_pmu_cotes(race_meta: dict) -> dict[str, Any]:
    """Fetch live cotes from the official PMU.fr public API.

    Returns {
      'source': 'PMU.fr',
      'race_url': '...',
      'horses': {number: {cote_num, cote_raw, trend, trend_pct, cote_update, type_rapport}},
      'rapport_type': 'DIRECT' | 'REFERENCE',
    }
    """
    import datetime as _dt
    date = race_meta.get("date")  # format "DD-MM-YYYY"
    if not date:
        d = _dt.datetime.now(_dt.timezone.utc).date()
        date_pmu = d.strftime("%d%m%Y")
    else:
        date_pmu = date.replace("-", "")

    programme = await _fetch_pmu(f"{PMU_API_BASE}/programme/{date_pmu}")
    match = _match_pmu_race(programme, race_meta)
    if match is None:
        return {"source": "PMU.fr", "horses": {}, "error": "race not found in PMU programme"}

    reunion_num, course_num = match
    participants_url = (
        f"{PMU_API_BASE}/programme/{date_pmu}/R{reunion_num}/C{course_num}/participants"
    )
    data = await _fetch_pmu(participants_url)

    horses: dict[int, dict[str, Any]] = {}
    for p in data.get("participants", []):
        number = p.get("numPmu")
        if number is None:
            continue
        # Prefer the DIRECT (live, during live betting). Fallback to REFERENCE
        # (last known reference cote) when DIRECT is absent.
        rd = p.get("dernierRapportDirect") or {}
        rr = p.get("dernierRapportReference") or {}
        source_rapport = rd if rd.get("rapport") is not None else rr
        if not source_rapport:
            continue
        rapport = source_rapport.get("rapport")
        if rapport is None:
            continue
        ts_ms = source_rapport.get("dateRapport")
        cote_update_iso = (
            _dt.datetime.fromtimestamp(ts_ms / 1000, _dt.timezone.utc).isoformat()
            if ts_ms
            else None
        )
        horses[int(number)] = {
            "cote_num": float(rapport),
            "cote_raw": _format_cote_raw(float(rapport)),
            "trend": source_rapport.get("indicateurTendance"),  # '+' | '-' | None
            "trend_pct": source_rapport.get("nombreIndicateurTendance"),
            "cote_update": cote_update_iso,
            "type_rapport": source_rapport.get("typeRapport"),  # DIRECT | REFERENCE
        }

    return {
        "source": "PMU.fr",
        "race_url": participants_url,
        "reunion_num": reunion_num,
        "course_num": course_num,
        "date_pmu": date_pmu,
        "horses": horses,
    }


def _format_cote_raw(value: float) -> str:
    """Format a PMU rapport (float) into the display form 'N/1' or 'N,M/1'."""
    if abs(value - round(value)) < 1e-6:
        return f"{int(round(value))}/1"
    return f"{value:.1f}".replace(".", ",") + "/1"


def _parse_performances(musique: str, current_year: int | None = None) -> list[dict[str, Any]]:
    """Parse a Paris-Turf musique into a chronologically ordered list of performances.

    Rules:
      • The musique string is read LEFT→RIGHT = MOST RECENT → OLDEST.
      • Tokens pattern: `(position)(type_letter)`
          - position: 1..99 (digit), or disqualif/incident code (D[a-z]?, T, A[a-z]?, Ret, 0)
          - type_letter: a (attelé), m (monté), h (haie), s (steeple), p (plat),
            c (cross), o (obstacle)
      • `(YY)` markers switch subsequent performances to year 20YY.
      • Default year is `current_year` (defaults to today's year). Each `(YY)` encountered
        while scanning left→right applies to tokens *to its right* (older performances).
    """
    if not musique:
        return []
    if current_year is None:
        from datetime import datetime as _dt, timezone as _tz
        current_year = _dt.now(_tz.utc).year

    # Remove the leading "NNj•" days marker
    s = re.sub(r"^\s*\d+\s*j\s*[•·.]\s*", "", musique)

    # Walk the string, keeping track of year context via (YY) markers.
    performances: list[dict[str, Any]] = []
    year = current_year
    token_re = re.compile(r"(\d+|D[a-zA-Z]?|T|A[a-zA-Z]?|Ret|0)([amhspco])")
    year_re = re.compile(r"\((\d{2})\)")

    pos = 0
    while pos < len(s):
        y = year_re.match(s, pos)
        if y:
            year = 2000 + int(y.group(1))
            pos = y.end()
            continue
        t = token_re.match(s, pos)
        if t:
            performances.append({
                "position": t.group(1),
                "type": t.group(2),
                "year": year,
            })
            pos = t.end()
            continue
        pos += 1

    return performances


_TYPE_LABEL = {
    "a": "attelé",
    "m": "monté",
    "h": "haie",
    "s": "steeple",
    "p": "plat",
    "c": "cross",
    "o": "obstacle",
}


def _format_last3(performances: list[dict[str, Any]]) -> str | None:
    if not performances:
        return None
    first3 = performances[:3]
    return " - ".join(f"{p['position']}{p['type']}" for p in first3)


def _parse_last3(musique: str) -> str | None:
    """Backwards-compatible helper (kept for any external callers)."""
    return _format_last3(_parse_performances(musique))


def compute_win_rate(horse: dict[str, Any]) -> float | None:
    v = horse.get("victoires")
    p = horse.get("places")
    c = horse.get("courses")
    if v is None or p is None or c is None or c == 0:
        return None
    return round((v + p) / c * 100, 1)
