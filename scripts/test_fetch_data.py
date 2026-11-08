"""Unit tests for fetch_data.py (standard library only).

Run: python -m unittest discover -s scripts -p "test_*.py"
"""

from __future__ import annotations

import json
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path

import fetch_data as fd

CW_SQUARE = [(0.0, 0.0), (0.0, 1.0), (1.0, 1.0), (1.0, 0.0), (0.0, 0.0)]
CCW_HOLE = [(0.25, 0.25), (0.75, 0.25), (0.75, 0.75), (0.25, 0.75), (0.25, 0.25)]
TEXAS_FIPS = [f"48{code:03d}" for code in range(1, 508, 2)]


def county_row(fips: str, mean: str | None = "100000", moe: str | None = "5000", households: str | None = "1000",
               mean_annotation: str | None = None) -> dict:
    return {"GEO_ID": f"0500000US{fips}", "NAME": f"County {fips} County, Texas",
            fd.MEAN: mean, f"{fd.MEAN}A": mean_annotation, fd.MEAN_MOE: moe, f"{fd.MEAN_MOE}A": None,
            fd.HOUSEHOLDS: households, f"{fd.HOUSEHOLDS}A": None}


class ParseAcsValueTest(unittest.TestCase):
    def test_numbers(self):
        self.assertEqual(fd.parse_acs_value("82026"), (82026, None))
        self.assertEqual(fd.parse_acs_value("1,234"), (1234, None))
        self.assertEqual(fd.parse_acs_value(12.5), (12.5, None))

    def test_zero_is_a_value_not_missing(self):
        self.assertEqual(fd.parse_acs_value("0"), (0, None))

    def test_special_values_become_none(self):
        for code, meaning in fd.SPECIAL_VALUES.items():
            self.assertEqual(fd.parse_acs_value(str(code)), (None, meaning))
        value, reason = fd.parse_acs_value("-5")
        self.assertIsNone(value)
        self.assertIn("negative", reason)

    def test_blanks_symbols_and_annotations_become_none(self):
        for raw in (None, "", "null", "N", "(X)", "**", "-", "nan"):
            self.assertIsNone(fd.parse_acs_value(raw)[0], raw)
        self.assertIsNone(fd.parse_acs_value("250001", "+")[0])


class TableTest(unittest.TestCase):
    def payload(self, object_id="ACSST5Y2024.S1901", header=("GEO_ID", "NAME"), rows=(("x", "y"),)):
        return {"response": {"objectId": object_id, "data": [list(header), *map(list, rows)]}}

    def test_parses_rows(self):
        rows = fd.parse_table_response(self.payload(), object_id="ACSST5Y2024.S1901", required=["GEO_ID"])
        self.assertEqual(rows, [{"GEO_ID": "x", "NAME": "y"}])

    def test_rejects_wrong_table_missing_columns_and_ragged_rows(self):
        with self.assertRaises(fd.PipelineError):
            fd.parse_table_response(self.payload(object_id="ACSST5Y2023.S1901"), object_id="ACSST5Y2024.S1901", required=[])
        with self.assertRaises(fd.PipelineError):
            fd.parse_table_response(self.payload(), object_id="ACSST5Y2024.S1901", required=[fd.MEAN])
        with self.assertRaises(fd.PipelineError):
            fd.parse_table_response(self.payload(rows=(("x",),)), object_id="ACSST5Y2024.S1901", required=[])

    def test_build_counties_keeps_unpublished_values_null(self):
        rows = [county_row(fips) for fips in reversed(TEXAS_FIPS)]
        rows[-1] = county_row("48001", mean="-666666666", moe="-222222222")
        rows[-2] = county_row("48003", moe="-555555555")
        rows[-3] = county_row("48005", mean="0", households="-999999999")
        counties, notes = fd.build_counties(rows)
        self.assertEqual([c["fips"] for c in counties], TEXAS_FIPS)
        self.assertEqual(counties[0], {"fips": "48001", "name": "County 48001 County", "meanIncome": None,
                                       "marginOfError": None, "households": 1000})
        self.assertEqual((counties[1]["meanIncome"], counties[1]["marginOfError"]), (100000, None))
        self.assertEqual((counties[2]["meanIncome"], counties[2]["households"]), (0, None))
        self.assertEqual(len(notes), 3)

    def test_build_counties_rejects_bad_coverage(self):
        rows = [county_row(fips) for fips in TEXAS_FIPS]
        with self.assertRaises(fd.PipelineError):
            fd.build_counties(rows[:-1])
        with self.assertRaises(fd.PipelineError):
            fd.build_counties([*rows[:-1], county_row("48001")])
        with self.assertRaises(fd.PipelineError):
            fd.build_counties([*rows[:-1], county_row("40001")])

    def test_verify_variables(self):
        concept = "Income in the Past 12 Months (in 2024 Inflation-Adjusted Dollars)"
        group = {"variables": {name: {"label": label, "concept": concept} for name, label in fd.EXPECTED_LABELS.items()}}
        self.assertEqual(fd.verify_variables(group, 2024)[0], 2024)
        with self.assertRaises(fd.PipelineError):
            fd.verify_variables(group, 2023)
        group["variables"][fd.MEAN]["label"] = "Estimate!!Households!!Median income (dollars)"
        with self.assertRaises(fd.PipelineError):
            fd.verify_variables(group, 2024)


class CrossCheckTest(unittest.TestCase):
    rows = [{"GEO_ID": "g", fd.MEAN: "100", f"{fd.MEAN}A": None, fd.HOUSEHOLDS: "3", f"{fd.HOUSEHOLDS}A": None}]

    def test_accepts_rounded_mean(self):
        result = fd.cross_check(self.rows, {"g": {"B19025_E001": "301"}}, {"g": {"B11001_E001": "3"}})
        self.assertEqual(result["geographiesChecked"], 1)
        self.assertAlmostEqual(result["maxAbsoluteDifferenceDollars"], 0.3333, places=4)

    def test_rejects_other_metrics_and_household_mismatch(self):
        with self.assertRaises(fd.PipelineError):
            fd.cross_check(self.rows, {"g": {"B19025_E001": "360"}}, {"g": {"B11001_E001": "3"}})
        with self.assertRaises(fd.PipelineError):
            fd.cross_check(self.rows, {"g": {"B19025_E001": "300"}}, {"g": {"B11001_E001": "4"}})

    def test_reads_summary_file_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "t.dat"
            path.write_text("GEO_ID|B19025_E001|B19025_M001\n0500000US48001|10|2\n0500000US01001|9|1\n")
            found = fd.read_summary_file(path, {"0500000US48001"}, ("B19025_E001",))
        self.assertEqual(found, {"0500000US48001": {"B19025_E001": "10"}})


def shapefile_bytes(rings: list[list[tuple[float, float]]]) -> tuple[bytes, bytes]:
    points = [p for ring in rings for p in ring]
    parts, start = [], 0
    for ring in rings:
        parts.append(start)
        start += len(ring)
    content = struct.pack("<i4d2i", 5, 0, 0, 1, 1, len(rings), len(points))
    content += struct.pack(f"<{len(parts)}i", *parts) + b"".join(struct.pack("<2d", *p) for p in points)
    header = struct.pack(">i20xi", 9994, (100 + 8 + len(content)) // 2) + struct.pack("<2i", 1000, 5) + bytes(64)
    shp = header + struct.pack(">2i", 1, len(content) // 2) + content
    fields = [("STATEFP", 2), ("GEOID", 5), ("NAMELSAD", 20)]
    dbf_header = struct.pack("<B3BIHH20x", 3, 125, 1, 1, 1, 33 + 32 * len(fields), 1 + sum(n for _, n in fields))
    descriptors = b"".join(name.encode().ljust(11, b"\x00") + b"C" + bytes(4) + bytes([size, 0]) + bytes(14)
                           for name, size in fields)
    record = b" " + b"48" + b"48001" + b"Anderson County".ljust(20)
    return shp, dbf_header + descriptors + b"\x0d" + record + b"\x1a"


class GeometryTest(unittest.TestCase):
    def test_reads_shapefile_parts(self):
        shp, dbf = shapefile_bytes([CW_SQUARE, CCW_HOLE])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "t.zip"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("t.shp", shp)
                archive.writestr("t.dbf", dbf)
                archive.writestr("t.cpg", "UTF-8")
                archive.writestr("t.prj", 'GEOGCS["GCS_North_American_1983"]')
            [(record, rings)] = fd.read_shapefile(path, "t")
        self.assertEqual(record, {"STATEFP": "48", "GEOID": "48001", "NAMELSAD": "Anderson County"})
        self.assertEqual(rings, [CW_SQUARE, CCW_HOLE])

    def test_keeps_d3_winding_and_assigns_holes(self):
        geometry = fd.rings_to_geometry([CW_SQUARE, CCW_HOLE])
        self.assertEqual(geometry["type"], "Polygon")
        exterior, hole = geometry["coordinates"]
        self.assertLess(fd.signed_area([tuple(p) for p in exterior]), 0)
        self.assertGreater(fd.signed_area([tuple(p) for p in hole]), 0)
        shifted = [(x + 2, y) for x, y in CW_SQUARE]
        self.assertEqual(fd.rings_to_geometry([CW_SQUARE, shifted])["type"], "MultiPolygon")
        with self.assertRaises(fd.PipelineError):
            fd.rings_to_geometry([CCW_HOLE])

    def test_clean_ring_rounds_dedupes_and_closes(self):
        ring = fd.clean_ring([(0.000001, 0.0), (0.0, 0.000002), (1.0, 1.0), (1.0, 0.0)], decimals=5)
        self.assertEqual(ring, [(0.0, 0.0), (1.0, 1.0), (1.0, 0.0), (0.0, 0.0)])

    def test_detects_crossings_but_allows_shared_borders(self):
        bowtie = [(0.0, 0.0), (1.0, 1.0), (1.0, 0.0), (0.0, 1.0), (0.0, 0.0)]
        self.assertEqual(fd.find_crossings([bowtie]), [(0, 0)])
        neighbour = [(1.0, 0.0), (1.0, 1.0), (2.0, 1.0), (2.0, 0.0), (1.0, 0.0)]
        self.assertEqual(fd.find_crossings([CW_SQUARE, neighbour]), [])

    def test_shared_borders_must_run_in_opposite_directions(self):
        def feature(ring):
            return {"geometry": {"type": "Polygon", "coordinates": [[list(p) for p in ring]]}}
        neighbour = [(1.0, 0.0), (1.0, 1.0), (2.0, 1.0), (2.0, 0.0), (1.0, 0.0)]
        self.assertEqual(fd.edge_problems([feature(CW_SQUARE), feature(neighbour)]), [])
        self.assertTrue(fd.edge_problems([feature(CW_SQUARE), feature(CW_SQUARE)]))


class SerializationTest(unittest.TestCase):
    def test_income_round_trips_with_one_county_per_line(self):
        data = {"metadata": {"period": "2020–2024"}, "stateMeanIncome": 1, "stateMarginOfError": None,
                "counties": [{"fips": "48001", "name": "A County", "meanIncome": None, "marginOfError": None,
                              "households": 2}]}
        text = fd.serialize_income(data)
        self.assertEqual(json.loads(text), data)
        self.assertIn('    {"fips": "48001", "name": "A County", "meanIncome": null', text)


if __name__ == "__main__":
    unittest.main()
