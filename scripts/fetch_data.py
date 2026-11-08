#!/usr/bin/env python3
"""Rebuild the Texas income atlas data from official U.S. Census Bureau releases.

Outputs (committed and served with the app):
  public/data/income.json             AtlasData (src/types.ts)
  public/data/texas-counties.geojson  CountyFeatureCollection (src/types.ts)
  public/data/source/                 verbatim source extracts and a provenance manifest

Usage:
  python scripts/fetch_data.py                     # reuse cached downloads when present
  python scripts/fetch_data.py --refresh           # re-download every source
  python scripts/fetch_data.py --skip-cross-check  # skip the ~65 MB summary-file check

Standard library only (Python 3.10+). Raw downloads are cached in .data-cache/
(gitignored). No Census API key is needed. See docs/DATA.md.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import re
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = ROOT / ".data-cache"
OUT_DIR = ROOT / "public" / "data"
SOURCE_DIR = OUT_DIR / "source"

STATE_FIPS = "48"
STATE_NAME = "Texas"
EXPECTED_COUNTY_COUNT = 254

DEFAULT_YEAR = 2024
# Official release dates of ACS 5-year estimates, keyed by the final year of the period.
# 2020-2024: https://www.census.gov/programs-surveys/acs/news/data-releases/2024/release.html
RELEASE_DATES = {2024: "2026-01-29"}

TABLE = "S1901"
MEAN = "S1901_C01_013E"
MEAN_MOE = "S1901_C01_013M"
HOUSEHOLDS = "S1901_C01_001E"
HOUSEHOLDS_MOE = "S1901_C01_001M"
MEDIAN = "S1901_C01_012E"
MEDIAN_MOE = "S1901_C01_012M"

# Published labels for every variable used; a refresh stops if the Census renumbers columns.
EXPECTED_LABELS = {
    MEAN: "Estimate!!Households!!Mean income (dollars)",
    MEAN_MOE: "Margin of Error!!Households!!Mean income (dollars)",
    HOUSEHOLDS: "Estimate!!Households!!Total",
    HOUSEHOLDS_MOE: "Margin of Error!!Households!!Total",
    MEDIAN: "Estimate!!Households!!Median income (dollars)",
    MEDIAN_MOE: "Margin of Error!!Households!!Median income (dollars)",
}
EXTRACT_COLUMNS = [
    "GEO_ID", "NAME", HOUSEHOLDS, HOUSEHOLDS_MOE, MEAN, MEAN_MOE,
    f"{MEAN}A", f"{MEAN_MOE}A", MEDIAN, MEDIAN_MOE,
]

# Summary-file tables for the independent cross-check: mean = aggregate income / households.
SF_AGGREGATE = ("b19025", "B19025_E001", "B19025_M001")
SF_HOUSEHOLDS = ("b11001", "B11001_E001", "B11001_M001")

# Special estimate/MOE values the ACS publishes instead of numbers:
# https://www.census.gov/data/developers/data-sets/acs-1year/notes-on-acs-estimate-and-annotation-values.html
SPECIAL_VALUES = {
    -999999999: "N: too few sample cases to display",
    -888888888: "(X): not applicable or not available",
    -666666666: "-: too few sample observations to compute an estimate",
    -555555555: "*****: controlled estimate, margin of error not appropriate",
    -333333333: "***: median falls in an open-ended interval",
    -222222222: "**: too few sample observations to compute a margin of error",
}

BOUNDARY_RESOLUTION = "5m"  # Census-generalized at 1:5,000,000; topology shared with the state file
COORDINATE_DECIMALS = 5     # about 1 m, far finer than the 1:5,000,000 generalization
TEXAS_BBOX = (-106.7, 25.8, -93.5, 36.6)  # lon/lat envelope used as a sanity bound

USER_AGENT = "texas-income-atlas-data-pipeline/1.0 (python-urllib)"


class PipelineError(RuntimeError):
    """A source or validation problem that must stop the refresh."""


# ---------------------------------------------------------------------------
# Downloads
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Fetched:
    url: str
    path: Path
    sha256: str
    size: int
    fetched_at: str
    last_modified: str | None

    def provenance(self, role: str) -> dict[str, Any]:
        return {
            "role": role, "url": self.url, "fetchedAt": self.fetched_at,
            "lastModified": self.last_modified, "bytes": self.size, "sha256": self.sha256,
        }


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def fetch(url: str, filename: str, *, refresh: bool) -> Fetched:
    """Download url into the cache (atomic write) or reuse a cached copy of the same URL."""
    CACHE_DIR.mkdir(exist_ok=True)
    path = CACHE_DIR / filename
    meta_path = CACHE_DIR / f"{filename}.meta.json"
    if not refresh and path.exists() and meta_path.exists():
        meta = json.loads(meta_path.read_text())
        if meta.get("url") == url:
            return Fetched(url, path, meta["sha256"], meta["bytes"], meta["fetchedAt"], meta.get("lastModified"))

    last_error: Exception | None = None
    for attempt in range(1, 5):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=180) as response:
                final_url = response.geturl()
                if "missing_key" in final_url or "invalid_key" in final_url:
                    raise PipelineError(f"{url} requires a Census API key (redirected to {final_url})")
                digest, size = hashlib.sha256(), 0
                partial = path.with_name(path.name + ".part")
                with partial.open("wb") as handle:
                    while chunk := response.read(1 << 20):
                        handle.write(chunk)
                        digest.update(chunk)
                        size += len(chunk)
                last_modified = response.headers.get("Last-Modified")
            fetched_at = utc_now()
            partial.replace(path)
            meta = {"url": url, "fetchedAt": fetched_at, "lastModified": last_modified,
                    "bytes": size, "sha256": digest.hexdigest()}
            meta_path.write_text(json.dumps(meta, indent=2) + "\n")
            print(f"  downloaded {url} ({size:,} bytes)")
            return Fetched(url, path, meta["sha256"], size, fetched_at, last_modified)
        except urllib.error.HTTPError as error:
            if 400 <= error.code < 500 and error.code != 429:
                raise PipelineError(f"{url} returned HTTP {error.code}") from error
            last_error = error
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            last_error = error
        time.sleep(2 ** attempt)
    raise PipelineError(f"Could not download {url}: {last_error}")


def http_status(url: str) -> int | None:
    """Status code for url without following key redirects; None when unreachable."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        return None


# ---------------------------------------------------------------------------
# ACS values and tables
# ---------------------------------------------------------------------------

def parse_acs_value(raw: Any, annotation: Any = None) -> tuple[int | float | None, str | None]:
    """Return (value, reason). value is None whenever the Census published no usable number.

    Zero stays zero; blanks, annotations, non-numeric codes and negative special values become None.
    """
    if annotation not in (None, ""):
        return None, f"annotated {annotation!r}"
    if raw is None:
        return None, "no value published"
    text = str(raw).strip().replace(",", "")
    if text == "" or text.lower() == "null":
        return None, "no value published"
    try:
        number = float(text)
    except ValueError:
        return None, f"non-numeric value {text!r}"
    if not math.isfinite(number):
        return None, f"non-finite value {text!r}"
    if number < 0:
        code = int(number)
        return None, SPECIAL_VALUES.get(code, f"negative special value {text}")
    return (int(number) if number.is_integer() else number), None


def parse_table_response(payload: Any, *, object_id: str, required: Iterable[str]) -> list[dict[str, Any]]:
    """Rows of a data.census.gov table response as header->value dicts, validated."""
    response = payload.get("response") if isinstance(payload, dict) else None
    if not isinstance(response, dict) or not isinstance(response.get("data"), list):
        raise PipelineError("Unexpected data.census.gov response shape")
    if response.get("objectId") != object_id:
        raise PipelineError(f"Expected table {object_id}, received {response.get('objectId')!r}")
    header, *rows = response["data"]
    missing = [column for column in required if column not in header]
    if missing:
        raise PipelineError(f"{object_id} is missing columns {missing}")
    parsed = []
    for row in rows:
        if len(row) != len(header):
            raise PipelineError(f"{object_id} row has {len(row)} values for {len(header)} columns")
        parsed.append(dict(zip(header, row)))
    return parsed


def county_name(acs_name: str) -> str:
    suffix = f", {STATE_NAME}"
    if not acs_name.endswith(suffix):
        raise PipelineError(f"Unexpected county name {acs_name!r}")
    return acs_name[: -len(suffix)]


def build_counties(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """CountyIncome records sorted by FIPS, plus human-readable notes on unpublished values."""
    pattern = re.compile(rf"^0500000US({STATE_FIPS}\d{{3}})$")
    counties, notes, seen = [], [], set()
    for row in rows:
        match = pattern.match(str(row.get("GEO_ID", "")))
        if not match:
            raise PipelineError(f"Unexpected county GEO_ID {row.get('GEO_ID')!r}")
        fips = match.group(1)
        if fips in seen:
            raise PipelineError(f"Duplicate county {fips}")
        seen.add(fips)
        name = county_name(str(row["NAME"]))
        mean, mean_reason = parse_acs_value(row[MEAN], row.get(f"{MEAN}A"))
        moe, moe_reason = parse_acs_value(row[MEAN_MOE], row.get(f"{MEAN_MOE}A"))
        households, households_reason = parse_acs_value(row[HOUSEHOLDS], row.get(f"{HOUSEHOLDS}A"))
        if mean is None:
            moe = None  # an interval around an unpublished estimate is meaningless
            notes.append(f"{name} ({fips}): mean income not published ({mean_reason})")
        elif moe is None:
            notes.append(f"{name} ({fips}): margin of error not published ({moe_reason})")
        if households is None:
            notes.append(f"{name} ({fips}): household count not published ({households_reason})")
        counties.append({"fips": fips, "name": name, "meanIncome": mean,
                         "marginOfError": moe, "households": households})
    if len(counties) != EXPECTED_COUNTY_COUNT:
        raise PipelineError(f"Expected {EXPECTED_COUNTY_COUNT} Texas counties, received {len(counties)}")
    counties.sort(key=lambda county: county["fips"])
    return counties, notes


def verify_variables(group: dict[str, Any], year: int) -> tuple[int, dict[str, dict[str, str]]]:
    """Check published labels/concepts for every variable used; return the dollar year."""
    variables = group.get("variables", {})
    verified: dict[str, dict[str, str]] = {}
    dollar_years = set()
    for name, label in EXPECTED_LABELS.items():
        meta = variables.get(name)
        if not meta or meta.get("label") != label:
            raise PipelineError(f"{name} label changed: {meta.get('label') if meta else 'missing'!r}")
        concept = meta.get("concept", "")
        found = re.search(r"in (\d{4}) Inflation-Adjusted Dollars", concept, re.IGNORECASE)
        if not found:
            raise PipelineError(f"{name} concept lacks a dollar basis: {concept!r}")
        dollar_years.add(int(found.group(1)))
        verified[name] = {"label": label, "concept": concept}
    if dollar_years != {year}:
        raise PipelineError(f"Unexpected dollar basis {sorted(dollar_years)} for the {year} release")
    return year, verified


def read_summary_file(path: Path, geo_ids: set[str], columns: tuple[str, ...]) -> dict[str, dict[str, str]]:
    """Selected rows/columns of a pipe-delimited ACS table-based summary file."""
    found: dict[str, dict[str, str]] = {}
    with path.open(encoding="utf-8", newline="") as handle:
        header = handle.readline().rstrip("\r\n").split("|")
        missing = [column for column in columns if column not in header]
        if header[0] != "GEO_ID" or missing:
            raise PipelineError(f"{path.name} header changed: missing {missing}")
        index = [header.index(column) for column in columns]
        for line in handle:
            geo_id = line[: line.find("|")]
            if geo_id in geo_ids:
                values = line.rstrip("\r\n").split("|")
                found[geo_id] = {column: values[i] for column, i in zip(columns, index)}
    return found


def cross_check(s1901_rows: list[dict[str, Any]], aggregate: dict[str, dict[str, str]],
                households: dict[str, dict[str, str]]) -> dict[str, Any]:
    """Compare each S1901 mean with B19025 aggregate income / B11001 households."""
    checked, max_diff, failures = 0, 0.0, []
    for row in s1901_rows:
        geo_id = row["GEO_ID"]
        mean, _ = parse_acs_value(row[MEAN], row.get(f"{MEAN}A"))
        s1901_households, _ = parse_acs_value(row[HOUSEHOLDS], row.get(f"{HOUSEHOLDS}A"))
        total, _ = parse_acs_value(aggregate.get(geo_id, {}).get(SF_AGGREGATE[1]))
        count, _ = parse_acs_value(households.get(geo_id, {}).get(SF_HOUSEHOLDS[1]))
        if count != s1901_households:
            failures.append(f"{geo_id}: households {s1901_households} vs summary file {count}")
            continue
        if mean is None or total is None or not count:
            if (mean is None) != (total is None or not count):
                failures.append(f"{geo_id}: published mean {mean} vs aggregate {total}/{count}")
            continue
        diff = abs(total / count - mean)
        max_diff = max(max_diff, diff)
        checked += 1
        if diff > 1.0:  # S1901 rounds the published mean to whole dollars
            failures.append(f"{geo_id}: mean {mean} vs aggregate/households {total / count:.2f}")
    if failures:
        raise PipelineError("Summary-file cross-check failed:\n  " + "\n  ".join(failures[:20]))
    return {"geographiesChecked": checked, "householdTotalsMatched": len(s1901_rows),
            "maxAbsoluteDifferenceDollars": round(max_diff, 4), "toleranceDollars": 1.0}


# ---------------------------------------------------------------------------
# Shapefile reading and geometry
# ---------------------------------------------------------------------------

Ring = list[tuple[float, float]]


def parse_dbf(data: bytes, encoding: str) -> list[dict[str, str]]:
    count, header_length, record_length = struct.unpack("<IHH", data[4:12])
    fields, position = [], 32
    while data[position] != 0x0D:
        descriptor = data[position: position + 32]
        fields.append((descriptor[:11].split(b"\x00", 1)[0].decode("ascii"), descriptor[16]))
        position += 32
    records = []
    for i in range(count):
        record = data[header_length + i * record_length: header_length + (i + 1) * record_length]
        if record[:1] == b"*":
            raise PipelineError("Deleted dBASE record in boundary file")
        offset, values = 1, {}
        for name, length in fields:
            values[name] = record[offset: offset + length].decode(encoding).strip()
            offset += length
        records.append(values)
    return records


def parse_shp(data: bytes) -> list[list[Ring]]:
    if struct.unpack(">i", data[:4])[0] != 9994 or struct.unpack("<i", data[32:36])[0] != 5:
        raise PipelineError("Boundary file is not a polygon shapefile")
    shapes, offset = [], 100
    while offset < len(data):
        words = struct.unpack(">i", data[offset + 4: offset + 8])[0]
        content = data[offset + 8: offset + 8 + 2 * words]
        offset += 8 + 2 * words
        if struct.unpack("<i", content[:4])[0] != 5:
            raise PipelineError("Unexpected null or non-polygon shape in boundary file")
        part_count, point_count = struct.unpack("<2i", content[36:44])
        parts = struct.unpack(f"<{part_count}i", content[44: 44 + 4 * part_count])
        start = 44 + 4 * part_count
        values = struct.unpack(f"<{2 * point_count}d", content[start: start + 16 * point_count])
        points = list(zip(values[0::2], values[1::2]))
        ends = [*parts[1:], point_count]
        shapes.append([points[a:b] for a, b in zip(parts, ends)])
    return shapes


def read_shapefile(zip_path: Path, stem: str) -> list[tuple[dict[str, str], list[Ring]]]:
    with zipfile.ZipFile(zip_path) as archive:
        names = set(archive.namelist())
        encoding = archive.read(f"{stem}.cpg").decode("ascii").strip() if f"{stem}.cpg" in names else "latin-1"
        projection = archive.read(f"{stem}.prj").decode("ascii")
        records = parse_dbf(archive.read(f"{stem}.dbf"), encoding)
        shapes = parse_shp(archive.read(f"{stem}.shp"))
    if "North_American_1983" not in projection or "PROJCS" in projection:
        raise PipelineError(f"Unexpected boundary coordinate system: {projection}")
    if len(records) != len(shapes):
        raise PipelineError("Boundary .dbf and .shp record counts differ")
    return list(zip(records, shapes))


def signed_area(ring: Ring) -> float:
    """Planar shoelace area in degrees²; negative means clockwise with north up."""
    return 0.5 * sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1] for i in range(len(ring) - 1))


def clean_ring(ring: Iterable[tuple[float, float]], decimals: int = COORDINATE_DECIMALS) -> Ring:
    """Round coordinates, drop consecutive duplicates, and close the ring."""
    cleaned: Ring = []
    for x, y in ring:
        point = (round(x, decimals), round(y, decimals))
        if not cleaned or point != cleaned[-1]:
            cleaned.append(point)
    if cleaned and cleaned[0] != cleaned[-1]:
        cleaned.append(cleaned[0])
    return cleaned


def point_in_ring(point: tuple[float, float], ring: Ring) -> bool:
    x, y = point
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def rings_to_geometry(rings: list[Ring]) -> dict[str, Any]:
    """GeoJSON Polygon/MultiPolygon from shapefile rings.

    Keeps the shapefile winding (exterior clockwise, holes counter-clockwise with north up),
    which is the orientation d3-geo requires to treat each county as the small polygon.
    """
    exteriors, holes = [], []
    for ring in rings:
        if len(ring) < 4:
            raise PipelineError("Degenerate ring with fewer than four positions")
        area = signed_area(ring)
        if area == 0:
            raise PipelineError("Zero-area ring")
        (exteriors if area < 0 else holes).append(ring)
    if not exteriors:
        raise PipelineError("Polygon without an exterior ring")
    polygons: list[list[Ring]] = [[exterior] for exterior in exteriors]
    for hole in holes:
        containers = [p for p in polygons if point_in_ring(hole[0], p[0])]
        if not containers:
            raise PipelineError("Hole outside every exterior ring")
        min(containers, key=lambda p: abs(signed_area(p[0]))).append(hole)
    coordinates = [[[list(point) for point in ring] for ring in polygon] for polygon in polygons]
    if len(coordinates) == 1:
        return {"type": "Polygon", "coordinates": coordinates[0]}
    return {"type": "MultiPolygon", "coordinates": coordinates}


def geometry_rings(geometry: dict[str, Any]) -> list[Ring]:
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    return [[tuple(point) for point in ring] for polygon in polygons for ring in polygon]


def orientation(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def segments_cross(a, b, c, d) -> bool:
    """True when segments ab and cd cross at a point interior to both."""
    o1, o2 = orientation(a, b, c), orientation(a, b, d)
    o3, o4 = orientation(c, d, a), orientation(c, d, b)
    return o1 * o2 < 0 and o3 * o4 < 0


def find_crossings(rings: list[Ring], cell: float = 0.25) -> list[tuple[int, int]]:
    """Pairs of ring indexes whose edges properly cross, using a uniform grid index."""
    segments = [(index, ring[i], ring[i + 1]) for index, ring in enumerate(rings) for i in range(len(ring) - 1)]
    grid: dict[tuple[int, int], list[int]] = defaultdict(list)
    for s, (_, a, b) in enumerate(segments):
        for gx in range(math.floor(min(a[0], b[0]) / cell), math.floor(max(a[0], b[0]) / cell) + 1):
            for gy in range(math.floor(min(a[1], b[1]) / cell), math.floor(max(a[1], b[1]) / cell) + 1):
                grid[(gx, gy)].append(s)
    crossings, tested = set(), set()
    for members in grid.values():
        for i, s in enumerate(members):
            for t in members[i + 1:]:
                if (s, t) in tested:
                    continue
                tested.add((s, t))
                (ring_a, a, b), (ring_b, c, d) = segments[s], segments[t]
                if segments_cross(a, b, c, d):
                    crossings.add((min(ring_a, ring_b), max(ring_a, ring_b)))
    return sorted(crossings)


def edge_problems(features: list[dict[str, Any]]) -> list[str]:
    """Shared borders must be identical and traversed in opposite directions by neighbours."""
    directed: Counter[tuple[tuple[float, float], tuple[float, float]]] = Counter()
    for feature in features:
        for ring in geometry_rings(feature["geometry"]):
            for a, b in zip(ring, ring[1:]):
                directed[(a, b)] += 1
    problems = [f"edge {edge} used {count} times in one direction" for edge, count in directed.items() if count > 1]
    return problems[:20]


def validate_features(features: list[dict[str, Any]]) -> dict[str, Any]:
    rings, vertices = [], 0
    min_x, min_y, max_x, max_y = TEXAS_BBOX
    for feature in features:
        for ring in geometry_rings(feature["geometry"]):
            if len(ring) < 4 or ring[0] != ring[-1]:
                raise PipelineError(f"{feature['properties']['fips']}: ring is not closed")
            if any(not (min_x <= x <= max_x and min_y <= y <= max_y) for x, y in ring):
                raise PipelineError(f"{feature['properties']['fips']}: coordinate outside Texas")
            rings.append(ring)
            vertices += len(ring) - 1
    crossings = find_crossings(rings)
    if crossings:
        raise PipelineError(f"Boundary edges cross: ring pairs {crossings[:10]}")
    problems = edge_problems(features)
    if problems:
        raise PipelineError("Inconsistent shared borders: " + "; ".join(problems))
    return {"rings": len(rings), "vertices": vertices}


def polygon_area(rings: list[Ring]) -> float:
    return sum(-signed_area(ring) for ring in rings)  # exterior clockwise (+), holes (-)


def build_features(boundaries: list[tuple[dict[str, str], list[Ring]]],
                   names: dict[str, str]) -> list[dict[str, Any]]:
    by_fips: dict[str, dict[str, Any]] = {}
    for record, rings in boundaries:
        if record["STATEFP"] != STATE_FIPS:
            continue
        fips = record["GEOID"]
        if fips in by_fips:
            raise PipelineError(f"Duplicate boundary {fips}")
        if fips not in names:
            raise PipelineError(f"Boundary {fips} has no ACS estimate row")
        if record["NAMELSAD"] != names[fips]:
            raise PipelineError(f"{fips}: boundary name {record['NAMELSAD']!r} vs ACS {names[fips]!r}")
        geometry = rings_to_geometry([clean_ring(ring) for ring in rings])
        by_fips[fips] = {"type": "Feature", "properties": {"fips": fips, "name": names[fips]},
                         "geometry": geometry}
    missing = sorted(set(names) - set(by_fips))
    if missing:
        raise PipelineError(f"ACS counties without boundaries: {missing}")
    return [by_fips[fips] for fips in sorted(by_fips)]


def state_area_check(features: list[dict[str, Any]], state_zip: Path, stem: str) -> dict[str, Any]:
    """Counties must tile the state outline exactly: no gaps or overlaps."""
    state = [rings for record, rings in read_shapefile(state_zip, stem) if record["STATEFP"] == STATE_FIPS]
    if len(state) != 1:
        raise PipelineError("Texas outline missing from the state boundary file")
    state_area = polygon_area([clean_ring(ring) for ring in state[0]])
    county_area = sum(polygon_area(geometry_rings(feature["geometry"])) for feature in features)
    relative = abs(county_area - state_area) / state_area
    if relative > 1e-6:
        raise PipelineError(f"Counties cover {county_area:.6f} deg² but Texas covers {state_area:.6f} deg²")
    return {"countyAreaSquareDegrees": round(county_area, 6), "stateAreaSquareDegrees": round(state_area, 6),
            "relativeDifference": relative}


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def money(value: int | float | None) -> str:
    return "not published" if value is None else f"${value:,.0f}"


def build_metadata(*, year: int, release_date: str, dollar_year: int, acs_fetch: Fetched,
                   boundary_url: str, state_median: int | float | None, counties: list[dict[str, Any]],
                   value_notes: list[str]) -> dict[str, Any]:
    period = f"{year - 4}–{year}"
    published = [c for c in counties if c["meanIncome"] is not None and c["marginOfError"] is not None]
    widest = max(published, key=lambda c: c["marginOfError"] / c["meanIncome"]) if published else None
    missing_mean = sum(1 for c in counties if c["meanIncome"] is None)
    notes = [
        "Estimates are survey-based. Margins of error (variable S1901_C01_013M) are at the 90% confidence "
        "level; the true value is likely within the estimate plus or minus the margin.",
        f"Mean is not median: half of Texas households had incomes below the statewide median of "
        f"{money(state_median)} (S1901_C01_012E), while the mean is pulled higher by a smaller number of very "
        "high incomes. Per-capita income is different again: it divides aggregate income by every resident, "
        "including children, rather than by households.",
        f"Each 5-year estimate pools survey responses collected from {year - 4} through {year}; it describes "
        "that period, not a single year, and is not comparable with 1-year estimates.",
    ]
    if missing_mean:
        notes.append(f"{missing_mean} counties have no published mean; they are null and shown as not available, never as $0.")
    else:
        notes.append("Every Texas county has a published mean in this release. Unpublished values would be null and "
                     "shown as not available, never as $0.")
    if widest:
        share = widest["marginOfError"] / widest["meanIncome"]
        notes.append(f"Small counties carry wide margins; the widest is {widest['name']} "
                     f"({money(widest['meanIncome'])} ± {money(widest['marginOfError'])}, ±{share:.0%}).")
    notes.extend(value_notes)
    return {
        "releaseYear": year,
        "period": period,
        "dollarYear": dollar_year,
        "source": f"U.S. Census Bureau, American Community Survey {period} 5-Year Estimates, "
                  f"Table {TABLE}: Income in the Past 12 Months (in {dollar_year} Inflation-Adjusted Dollars)",
        "sourceUrl": f"https://data.census.gov/table/ACSST5Y{year}.{TABLE}?g=040XX00US{STATE_FIPS}$0500000",
        "sourceVariable": MEAN,
        "releaseDate": release_date,
        "fetchedAt": acs_fetch.fetched_at,
        "boundarySource": f"U.S. Census Bureau, {year} Cartographic Boundary File, counties, 1:5,000,000 "
                          f"(cb_{year}_us_county_{BOUNDARY_RESOLUTION})",
        "boundaryUrl": boundary_url,
        "boundaryYear": year,
        "definition": "Mean household income: the total income of all households divided by the number of "
                      "households. Household income is the past-12-month income of the householder and every "
                      "other household member aged 15 or older, related or not, from all reported sources such "
                      "as wages, self-employment, interest, dividends, rent, Social Security, retirement income "
                      f"and public assistance. Dollar values are adjusted for inflation to {dollar_year} dollars.",
        "notes": " ".join(notes),
    }


def serialize_income(data: dict[str, Any]) -> str:
    """Pretty JSON with one county per line for reviewable diffs."""
    head = json.dumps({k: v for k, v in data.items() if k != "counties"}, indent=2, ensure_ascii=False)
    rows = ",\n".join("    " + json.dumps(c, ensure_ascii=False) for c in data["counties"])
    text = f'{head[:-2]},\n  "counties": [\n{rows}\n  ]\n}}\n'
    if json.loads(text) != data:
        raise PipelineError("income.json serialization round-trip failed")
    return text


def serialize_geojson(features: list[dict[str, Any]]) -> str:
    """Compact GeoJSON with one feature per line."""
    lines = ",\n".join(json.dumps(f, ensure_ascii=False, separators=(",", ":")) for f in features)
    return '{"type":"FeatureCollection","features":[\n' + lines + "\n]}\n"


def write_csv(path: Path, columns: list[str], rows: Iterable[dict[str, Any]]) -> None:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(columns)
    for row in rows:
        writer.writerow(["" if row.get(column) is None else row.get(column) for column in columns])
    path.write_text(buffer.getvalue(), encoding="utf-8")


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def table_url(year: int, geography: str) -> str:
    query = urllib.parse.urlencode({"id": f"ACSST5Y{year}.{TABLE}", "g": geography})
    return f"https://data.census.gov/api/access/data/table?{query}"


def run(args: argparse.Namespace) -> None:
    year = args.year
    release_date = args.release_date or RELEASE_DATES.get(year)
    if not release_date:
        raise PipelineError(f"Pass --release-date for the {year} release")
    refresh = args.refresh
    sources: list[dict[str, Any]] = []
    period = f"{year - 4}-{year}"

    print(f"ACS {period} 5-year, Table {TABLE}")
    newer_url = f"https://api.census.gov/data/{year + 1}/acs/acs5/subject.json"
    newer_status = http_status(newer_url)
    if newer_status == 200:
        print(f"  WARNING: a newer ACS 5-year release exists ({newer_url}); consider --year {year + 1}")

    group_fetch = fetch(f"https://api.census.gov/data/{year}/acs/acs5/subject/groups/{TABLE}.json",
                        f"acs5-{year}-{TABLE}-variables.json", refresh=refresh)
    dollar_year, verified = verify_variables(json.loads(group_fetch.path.read_text()), year)
    sources.append(group_fetch.provenance("Variable labels and dollar basis (Census API metadata, keyless)"))

    object_id = f"ACSST5Y{year}.{TABLE}"
    columns = [c for c in EXTRACT_COLUMNS if not c.endswith("A")] + [f"{MEAN}A", f"{MEAN_MOE}A", f"{HOUSEHOLDS}A"]
    county_fetch = fetch(table_url(year, f"040XX00US{STATE_FIPS}$0500000"),
                         f"acs5-{year}-{TABLE}-tx-counties.json", refresh=refresh)
    state_fetch = fetch(table_url(year, f"040XX00US{STATE_FIPS}"), f"acs5-{year}-{TABLE}-tx-state.json", refresh=refresh)
    county_payload = json.loads(county_fetch.path.read_text())
    county_rows = parse_table_response(county_payload, object_id=object_id, required=columns)
    state_rows = parse_table_response(json.loads(state_fetch.path.read_text()), object_id=object_id, required=columns)
    if county_payload["response"].get("metadataAPIURI") != f"https://api.census.gov/data/{year}/acs/acs5/subject":
        raise PipelineError("County table does not come from the ACS 5-year subject tables")
    sources.append(county_fetch.provenance("County estimates (data.census.gov table service)"))
    sources.append(state_fetch.provenance("Texas estimate (data.census.gov table service)"))
    counties, value_notes = build_counties(county_rows)
    if len(state_rows) != 1 or state_rows[0]["GEO_ID"] != f"0400000US{STATE_FIPS}" or state_rows[0]["NAME"] != STATE_NAME:
        raise PipelineError("Unexpected Texas state row")
    state_row = state_rows[0]
    state_mean, _ = parse_acs_value(state_row[MEAN], state_row.get(f"{MEAN}A"))
    state_moe, _ = parse_acs_value(state_row[MEAN_MOE], state_row.get(f"{MEAN_MOE}A")) if state_mean is not None else (None, None)
    state_median, _ = parse_acs_value(state_row[MEDIAN], state_row.get(f"{MEDIAN}A"))
    print(f"  {len(counties)} counties; Texas mean {money(state_mean)} ± {money(state_moe)}")

    all_rows = [state_row, *sorted(county_rows, key=lambda row: row["GEO_ID"])]
    cross: dict[str, Any] | None = None
    sf_rows: dict[str, dict[str, str]] = {}
    if not args.skip_cross_check:
        geo_ids = {row["GEO_ID"] for row in all_rows}
        base = f"https://www2.census.gov/programs-surveys/acs/summary_file/{year}/table-based-SF/data/5YRData"
        tables = {}
        for table, estimate, moe in (SF_AGGREGATE, SF_HOUSEHOLDS):
            sf_fetch = fetch(f"{base}/acsdt5y{year}-{table}.dat", f"acsdt5y{year}-{table}.dat", refresh=refresh)
            sources.append(sf_fetch.provenance(f"Cross-check: ACS summary file table {table.upper()}"))
            tables[table] = read_summary_file(sf_fetch.path, geo_ids, (estimate, moe))
        cross = cross_check(all_rows, tables[SF_AGGREGATE[0]], tables[SF_HOUSEHOLDS[0]])
        for geo_id in geo_ids:
            sf_rows[geo_id] = {"GEO_ID": geo_id, **tables[SF_AGGREGATE[0]].get(geo_id, {}),
                               **tables[SF_HOUSEHOLDS[0]].get(geo_id, {})}
        print(f"  summary-file cross-check: {cross}")

    boundary_url = f"https://www2.census.gov/geo/tiger/GENZ{year}/shp/cb_{year}_us_county_{BOUNDARY_RESOLUTION}.zip"
    boundary_fetch = fetch(boundary_url, f"cb_{year}_us_county_{BOUNDARY_RESOLUTION}.zip", refresh=refresh)
    sources.append(boundary_fetch.provenance("County boundaries (cartographic boundary file)"))
    names = {county["fips"]: county["name"] for county in counties}
    features = build_features(read_shapefile(boundary_fetch.path, f"cb_{year}_us_county_{BOUNDARY_RESOLUTION}"), names)
    geometry_stats = validate_features(features)
    state_url = f"https://www2.census.gov/geo/tiger/GENZ{year}/shp/cb_{year}_us_state_{BOUNDARY_RESOLUTION}.zip"
    state_boundary = fetch(state_url, f"cb_{year}_us_state_{BOUNDARY_RESOLUTION}.zip", refresh=refresh)
    sources.append(state_boundary.provenance("Texas outline for the gap/overlap check"))
    geometry_stats["stateTiling"] = state_area_check(features, state_boundary.path, f"cb_{year}_us_state_{BOUNDARY_RESOLUTION}")
    print(f"  {len(features)} county boundaries: {geometry_stats}")

    metadata = build_metadata(year=year, release_date=release_date, dollar_year=dollar_year, acs_fetch=county_fetch,
                              boundary_url=boundary_url, state_median=state_median, counties=counties,
                              value_notes=value_notes)
    atlas = {"metadata": metadata, "stateMeanIncome": state_mean, "stateMarginOfError": state_moe, "counties": counties}

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "income.json").write_text(serialize_income(atlas), encoding="utf-8")
    (OUT_DIR / "texas-counties.geojson").write_text(serialize_geojson(features), encoding="utf-8")
    extract_name = f"acs5-{period}-{TABLE.lower()}-texas.csv"
    write_csv(SOURCE_DIR / extract_name, EXTRACT_COLUMNS, all_rows)
    outputs = {"estimatesExtract": f"source/{extract_name}"}
    if cross is not None:
        sf_name = f"acs5-{period}-summary-file-b19025-b11001-texas.csv"
        sf_columns = ["GEO_ID", SF_AGGREGATE[1], SF_AGGREGATE[2], SF_HOUSEHOLDS[1], SF_HOUSEHOLDS[2]]
        write_csv(SOURCE_DIR / sf_name, sf_columns, (sf_rows[row["GEO_ID"]] for row in all_rows))
        outputs["crossCheckExtract"] = f"source/{sf_name}"
    manifest = {
        "description": "Provenance for public/data/income.json and texas-counties.geojson. Extract CSVs hold "
                       "the official values verbatim; empty cells mean the Census published no value.",
        "release": {"survey": "American Community Survey 5-Year Estimates", "period": period,
                    "releaseDate": release_date, "releaseNotesUrl":
                    f"https://www.census.gov/programs-surveys/acs/news/data-releases/{year}/release.html",
                    "newerReleaseCheck": {"url": newer_url, "httpStatus": newer_status}},
        "variables": verified,
        "sources": sources,
        "outputs": outputs,
        "summaryFileCrossCheck": cross,
        "geometry": {"resolution": "1:5,000,000", "coordinateDecimals": COORDINATE_DECIMALS,
                     "coordinateSystem": "NAD83 longitude/latitude (EPSG:4269), used as GeoJSON lon/lat",
                     "winding": "exterior rings clockwise, holes counter-clockwise (d3-geo convention)",
                     "features": len(features), **geometry_stats},
        "coverage": {"counties": len(counties),
                     "meanIncomePublished": sum(1 for c in counties if c["meanIncome"] is not None),
                     "marginOfErrorPublished": sum(1 for c in counties if c["marginOfError"] is not None),
                     "householdsPublished": sum(1 for c in counties if c["households"] is not None)},
    }
    (SOURCE_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_DIR / 'income.json'}, {OUT_DIR / 'texas-counties.geojson'} and {SOURCE_DIR}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--year", type=int, default=DEFAULT_YEAR, help="final year of the ACS 5-year period")
    parser.add_argument("--release-date", help="official release date (YYYY-MM-DD) for years not in RELEASE_DATES")
    parser.add_argument("--refresh", action="store_true", help="ignore cached downloads")
    parser.add_argument("--skip-cross-check", action="store_true", help="skip the summary-file cross-check")
    try:
        run(parser.parse_args(argv))
    except PipelineError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
