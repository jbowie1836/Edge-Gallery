# Data: mean household income by Texas county

The atlas maps **mean annual household income** for all 254 Texas counties from the U.S. Census Bureau's
**American Community Survey (ACS) 2020–2024 5-year estimates**, released **January 29, 2026**. All dollar values are in
**2024 inflation-adjusted dollars**. As of November 8, 2026 this is the latest 5-year release: the Census API has no
2021–2025 5-year dataset yet (`https://api.census.gov/data/2025/acs/acs5/subject.json` returns 404), and 1-year
estimates do not cover most Texas counties.

| Item | Value |
| --- | --- |
| Estimate | `S1901_C01_013E` — *Estimate!!Households!!Mean income (dollars)* |
| Margin of error | `S1901_C01_013M` — 90% confidence level |
| Households | `S1901_C01_001E` — *Estimate!!Households!!Total* |
| Table | S1901, *Income in the Past 12 Months (in 2024 Inflation-Adjusted Dollars)*, ACS 5-year subject tables |
| Release notes | <https://www.census.gov/programs-surveys/acs/news/data-releases/2024/release.html> |
| Table viewer | <https://data.census.gov/table/ACSST5Y2024.S1901?g=040XX00US48$0500000> |
| Boundaries | 2024 Cartographic Boundary File, counties, 1:5,000,000: <https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_5m.zip> |
| Statewide mean | **$109,933 ± $385** (the official Texas estimate, not an average of counties) |

## Mean, median and per-capita income

- **Mean household income** (this atlas) is the total income of all households divided by the number of households.
  Household income is the past-12-month income of the householder and every other member aged 15 or older, related
  or not, from all reported sources.
- **Median household income** is the income of the middle household: half earn less, half more. For Texas it is
  $78,476 (`S1901_C01_012E`), well below the $109,933 mean, because a smaller number of very high incomes pulls the
  mean up.
- **Per-capita income** divides aggregate income by every resident, including children, rather than by households.

These three measures are not interchangeable, and the files here contain only the mean (the median appears in the
source extract for context).

## Files

| Path | Contents |
| --- | --- |
| `public/data/income.json` | `AtlasData` (`src/types.ts`): metadata, the official state estimate, and 254 `CountyIncome` records sorted by FIPS |
| `public/data/texas-counties.geojson` | `CountyFeatureCollection`: 254 `Polygon`/`MultiPolygon` features with properties `{ fips, name }` only |
| `public/data/source/acs5-2020-2024-s1901-texas.csv` | Verbatim official S1901 values (state + 254 counties), including annotation columns |
| `public/data/source/acs5-2020-2024-summary-file-b19025-b11001-texas.csv` | Verbatim summary-file rows used for the independent cross-check |
| `public/data/source/manifest.json` | Source URLs, retrieval times, `Last-Modified` headers, SHA-256 hashes, verified variable labels and check results |
| `scripts/fetch_data.py` | Reproducible pipeline (Python 3.10+, standard library only) |
| `scripts/test_fetch_data.py` | Python unit tests for parsing, special values, shapefile reading and geometry checks |
| `tests/data.test.ts` | Vitest integrity tests over the committed files (run in CI by `npm test`) |

`income.json` and the GeoJSON join one-to-one on the five-digit county FIPS code (`48001`–`48507`): ACS `GEO_ID`
`0500000US48xxx` ↔ boundary `GEOID`. County names match exactly (ACS `"Anderson County, Texas"` ↔ boundary
`NAMELSAD` `"Anderson County"`).

## Sources and access

- **Estimates** come from the Census Bureau's data.census.gov table service,
  `https://data.census.gov/api/access/data/table?id=ACSST5Y2024.S1901&g=040XX00US48$0500000` (all Texas counties) and
  `g=040XX00US48` (Texas). It serves the same ACS 5-year subject table as the Census Data API; each response names its
  API source (`https://api.census.gov/data/2024/acs/acs5/subject?get=group(S1901)&ucgid=…`). The Data API itself now
  requires a key for data queries (unkeyed requests redirect to `missing_key.html`); the pipeline needs no key.
- **Variable metadata** (`https://api.census.gov/data/2024/acs/acs5/subject/groups/S1901.json`, keyless) is checked on
  every refresh: the six labels used must match exactly and the concept must state `in 2024 Inflation-Adjusted Dollars`.
  If the Census renumbers or relabels columns, the refresh stops rather than reading the wrong column.
- **Cross-check**: the ACS table-based Summary File for the same release (posted January 29, 2026) —
  `acsdt5y2024-b19025.dat` (aggregate household income) and `acsdt5y2024-b11001.dat` (households) under
  `https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/`.
- **Boundaries**: `cb_2024_us_county_5m.zip`, plus `cb_2024_us_state_5m.zip` to check that the counties tile the state.

All are public-domain U.S. government data.

## Verification results (this build)

- **Coverage**: 254 of 254 counties; every county has a published mean, margin of error and household count.
- **Metric**: for all 255 geographies (state + counties), S1901 households equal summary-file B11001 households
  exactly, and the S1901 mean equals B19025 aggregate income ÷ households to within $0.4993 (whole-dollar rounding).
  This confirms the values are household means for every county, not medians or per-capita figures.
- **State figure**: the published Texas mean is $109,933 ± $385. County households sum exactly to the state's
  10,992,816, and the household-weighted average of county means is $109,932.58. The unweighted average of county
  means ($88,060.56) would be wrong, so it is not used.
- **Range**: Zavala County has the lowest mean ($50,963) and Rockwall County the highest ($162,868). The widest
  relative margin is Kenedy County ($64,860 ± $34,160, ±53%).
- **Geometry**: 254 features (9 `MultiPolygon` coastal counties with barrier islands), 265 rings, 11,827 vertices,
  no holes. No edges cross, shared borders are identical and run in opposite directions, and the county areas sum
  exactly to the Texas outline from the state file (no gaps or overlaps).

## Checking the data independently

- **Offline:** `npm test` compares every county in `income.json` with the verbatim official extract in
  `public/data/source/`. It also recomputes each mean as B19025 ÷ B11001 and checks the FIPS join and geometry.
- **Against the Census Bureau:** `public/data/source/manifest.json` records the URL and SHA-256 of every raw download.
  All seven downloads were byte-identical when re-fetched on November 8, 2026, so a fresh download can be compared
  directly:

  ```sh
  curl -s 'https://data.census.gov/api/access/data/table?id=ACSST5Y2024.S1901&g=040XX00US48%240500000' | sha256sum
  # f90846bf0eea66a23f80ced4019ff082a1a8178d0943122e323171b3e2221e72 (as in manifest.json)
  ```

  If data.census.gov changes its response formatting, the hash can change while the values stay the same. In that
  case, compare the values with the extract instead.
- **Full rebuild:** copy `scripts/fetch_data.py` into the `scripts/` folder of an empty directory and run it with
  `--refresh`. Its outputs go under that directory, so the committed files are not touched. A rebuild on November 8,
  2026 reproduced the GeoJSON and both extracts byte-for-byte; only `fetchedAt` and the data.census.gov
  `Last-Modified` header differed.

## Missing and special values

The ACS publishes special codes instead of numbers when an estimate or margin cannot be shown
([Census notes](https://www.census.gov/data/developers/data-sets/acs-1year/notes-on-acs-estimate-and-annotation-values.html)).
The pipeline maps every one of them, as well as blanks and annotated cells, to `null`. It never substitutes zero.

| Code | Annotation | Meaning |
| --- | --- | --- |
| `-666666666` | `-` | Too few sample observations to compute an estimate |
| `-999999999` | `N` | Too few sample cases to display |
| `-888888888` | `(X)` | Not applicable or not available |
| `-555555555` | `*****` | Controlled estimate; margin of error not appropriate |
| `-333333333` | `***` | Median falls in an open-ended interval |
| `-222222222` | `**` | Too few sample observations to compute a margin of error |

A published `0` would stay `0`. When `meanIncome` is `null`, `marginOfError` is also `null`. The UI should show such
counties as "Not available" with the missing-data color. No county is missing in the 2020–2024 release.

## Geometry processing

- Census's own 1:5,000,000 generalization is used as published. There is no further simplification and no convex
  approximation. Coordinates are rounded to 5 decimal places (about 1 m), which removed 4 consecutive duplicate
  vertices. The shoreline-clipped file excludes Gulf and bay water; barrier islands are kept as extra polygons.
- **Winding follows d3-geo**: exterior rings are clockwise and holes counter-clockwise (longitude/latitude, north up),
  as in the source shapefile. This is the reverse of the RFC 7946 right-hand rule. Do not "rewind" the rings, or
  d3-geo will treat each county as the whole globe minus the county (`geoArea` ≈ 4π, `fitExtent` breaks). Three.js
  `ExtrudeGeometry` accepts either orientation.
- Coordinates are NAD83 longitude/latitude (EPSG:4269), used directly as GeoJSON WGS84 coordinates. The difference is
  about 1 m, far below the 1:5,000,000 generalization.

## Refresh

```sh
npm run data:refresh                             # python scripts/fetch_data.py; reuses .data-cache/ downloads
python scripts/fetch_data.py --refresh           # re-download everything (~75 MB, mostly the summary file)
python scripts/fetch_data.py --skip-cross-check  # skip the summary-file cross-check
python -m unittest discover -s scripts -p "test_*.py"
npm test
```

Downloads are cached in `.data-cache/` (gitignored). Before writing, the pipeline validates labels, coverage, joins,
the cross-check, and geometry, and it exits non-zero on any failure. For the next release, run
`python scripts/fetch_data.py --year 2025 --release-date YYYY-MM-DD --refresh`. Then update the release-specific spot
checks in `tests/data.test.ts` and the figures in this document. The pipeline warns when the Census API lists a newer
5-year release than the one requested.

## Limitations

- ACS figures are survey estimates. Small counties have wide margins of error, so ranking adjacent counties by point
  estimate does not mean their difference is statistically significant.
- A 5-year estimate describes the 60-month period 2020–2024, not a single year, and should not be compared directly with
  1-year estimates.
- The data.census.gov table service is the Census Bureau's public website backend rather than the documented keyed
  API. If it changes, the documented route is the Census Data API with a key, which this pipeline does not yet use.
- The 1:5,000,000 boundaries are for statewide display, not for legal or parcel-level use.
