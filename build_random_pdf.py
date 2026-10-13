#!/usr/bin/env python3
"""Build a random PDF file using only the Python standard library.

Every run produces a different document: a random title, sections of random
pseudo-prose, tables of random numbers and figures made of random coloured
shapes, laid out over a random number of US Letter pages. Pass ``--seed`` to
reproduce a document.

Usage:
    python3 build_random_pdf.py                        # writes random.pdf
    python3 build_random_pdf.py -o report.pdf --pages 3
    python3 build_random_pdf.py --seed 42              # reproducible content
"""

from __future__ import annotations

import argparse
import colorsys
import datetime as dt
import random
import sys
from pathlib import Path

PAGE_W, PAGE_H = 612, 792  # US Letter, in PostScript points
MARGIN = 72
TEXT_W = PAGE_W - 2 * MARGIN
FOOTER_Y = 40
BODY_SIZE, BODY_LEADING = 11, 15

FONTS = {"F1": "Helvetica", "F2": "Helvetica-Bold", "F3": "Helvetica-Oblique"}

# Advance widths (1/1000 em) of Helvetica for ASCII 32..126 in WinAnsiEncoding.
# Knowing them lets us wrap text accurately without shipping a font file.
HELVETICA_WIDTHS = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]

ONSETS = [
    "b", "c", "d", "f", "g", "h", "j", "k", "l", "m", "n", "p", "r", "s", "t", "v", "w", "z",
    "br", "cr", "dr", "fr", "gr", "pr", "tr", "bl", "cl", "fl", "gl", "pl", "sl",
    "sh", "th", "ch", "st", "sp", "qu",
]
NUCLEI = ["a", "e", "i", "o", "u", "a", "e", "i", "o", "ai", "ea", "ou", "oo", "ie"]
CODAS = ["", "", "", "n", "r", "s", "l", "m", "t", "k", "nd", "st", "rn", "sh", "th", "ng"]
BEZIER_ARC = 0.5523  # control-point distance for a quarter circle of radius 1


# --------------------------------------------------------------------------- #
# Low-level PDF helpers
# --------------------------------------------------------------------------- #
def fmt(value: float) -> str:
    """Format a number compactly for a content stream."""
    return f"{value:.2f}".rstrip("0").rstrip(".") or "0"


def pdf_string(text: str) -> str:
    """Encode text as a PDF literal string."""
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return f"({escaped})"


def text_width(text: str, size: float, bold: bool = False) -> float:
    units = sum(HELVETICA_WIDTHS[ord(ch) - 32] if 32 <= ord(ch) <= 126 else 556 for ch in text)
    # Helvetica-Bold glyphs are a little wider; a flat factor is close enough for wrapping.
    return units * size / 1000 * (1.08 if bold else 1.0)


def wrap(text: str, size: float, width: float, bold: bool = False) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if current and text_width(candidate, size, bold) > width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


class PdfWriter:
    """Collects numbered objects and serialises them with a correct xref table."""

    def __init__(self) -> None:
        self.objects: list[bytes | None] = []

    def reserve(self) -> int:
        self.objects.append(None)
        return len(self.objects)

    def set(self, number: int, body: str | bytes) -> None:
        self.objects[number - 1] = body.encode("latin-1") if isinstance(body, str) else body

    def add(self, body: str | bytes) -> int:
        number = self.reserve()
        self.set(number, body)
        return number

    def add_stream(self, data: bytes) -> int:
        return self.add(b"<< /Length %d >>\nstream\n" % len(data) + data + b"\nendstream")

    def render(self, root: int, info: int) -> bytes:
        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets: list[int] = []
        for number, body in enumerate(self.objects, start=1):
            if body is None:
                raise ValueError(f"object {number} was reserved but never set")
            offsets.append(len(out))
            out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
        xref_offset = len(out)
        out += b"xref\n0 %d\n" % (len(offsets) + 1)
        out += b"0000000000 65535 f \n"
        for offset in offsets:
            out += b"%010d 00000 n \n" % offset
        out += (
            b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n"
            % (len(offsets) + 1, root, info, xref_offset)
        )
        return bytes(out)


# --------------------------------------------------------------------------- #
# Random content
# --------------------------------------------------------------------------- #
def random_word(rng: random.Random) -> str:
    syllables = rng.choices([1, 2, 3, 4], weights=[3, 5, 3, 1])[0]
    return "".join(rng.choice(ONSETS) + rng.choice(NUCLEI) + rng.choice(CODAS) for _ in range(syllables))


def random_sentence(rng: random.Random) -> str:
    words = [random_word(rng) for _ in range(rng.randint(5, 14))]
    if len(words) > 7 and rng.random() < 0.5:
        words[rng.randint(2, len(words) - 3)] += ","
    sentence = " ".join(words)
    return sentence[0].upper() + sentence[1:] + rng.choice([".", ".", ".", "?", "!"])


def random_paragraph(rng: random.Random) -> str:
    return " ".join(random_sentence(rng) for _ in range(rng.randint(3, 6)))


def random_title(rng: random.Random) -> str:
    return " ".join(random_word(rng).capitalize() for _ in range(rng.randint(2, 4)))


def random_cell(rng: random.Random) -> str:
    roll = rng.random()
    if roll < 0.4:
        return f"{rng.randint(0, 9999):,}"
    if roll < 0.7:
        return f"{rng.uniform(-500, 500):.2f}"
    if roll < 0.9:
        return f"{rng.uniform(0, 100):.1f}%"
    return rng.choice(["yes", "no", "n/a"])


def random_color(rng: random.Random, light: bool = False) -> str:
    hue = rng.random()
    saturation = rng.uniform(0.15, 0.4) if light else rng.uniform(0.45, 0.9)
    value = rng.uniform(0.88, 1.0) if light else rng.uniform(0.55, 0.95)
    return " ".join(fmt(c) for c in colorsys.hsv_to_rgb(hue, saturation, value))


def circle_path(cx: float, cy: float, r: float) -> str:
    k = BEZIER_ARC * r
    return (
        f"{fmt(cx + r)} {fmt(cy)} m "
        f"{fmt(cx + r)} {fmt(cy + k)} {fmt(cx + k)} {fmt(cy + r)} {fmt(cx)} {fmt(cy + r)} c "
        f"{fmt(cx - k)} {fmt(cy + r)} {fmt(cx - r)} {fmt(cy + k)} {fmt(cx - r)} {fmt(cy)} c "
        f"{fmt(cx - r)} {fmt(cy - k)} {fmt(cx - k)} {fmt(cy - r)} {fmt(cx)} {fmt(cy - r)} c "
        f"{fmt(cx + k)} {fmt(cy - r)} {fmt(cx + r)} {fmt(cy - k)} {fmt(cx + r)} {fmt(cy)} c h"
    )


def random_shape(rng: random.Random, x: float, y: float, w: float, h: float) -> str:
    kind = rng.choice(["rect", "rect", "circle", "circle", "triangle", "line"])
    color = random_color(rng)
    cx, cy = rng.uniform(x, x + w), rng.uniform(y, y + h)
    size = rng.uniform(10, min(w, h) * 0.45)
    if kind == "rect":
        rect_w = size * rng.uniform(0.5, 2.0)
        return f"{color} rg {fmt(cx - rect_w / 2)} {fmt(cy - size / 2)} {fmt(rect_w)} {fmt(size)} re f"
    if kind == "circle":
        return f"{color} rg {circle_path(cx, cy, size / 2)} f"
    if kind == "triangle":
        pts = [(cx + rng.uniform(-size, size), cy + rng.uniform(-size, size)) for _ in range(3)]
        segments = " ".join(f"{fmt(px)} {fmt(py)} l" for px, py in pts[1:])
        return f"{color} rg {fmt(pts[0][0])} {fmt(pts[0][1])} m {segments} h f"
    x2, y2 = rng.uniform(x, x + w), rng.uniform(y, y + h)
    return f"{color} RG {fmt(rng.uniform(0.5, 6))} w {fmt(cx)} {fmt(cy)} m {fmt(x2)} {fmt(y2)} l S"


# --------------------------------------------------------------------------- #
# Page layout
# --------------------------------------------------------------------------- #
class Page:
    """Accumulates content-stream operators while tracking a vertical cursor."""

    def __init__(self) -> None:
        self.ops: list[str] = []
        self.y = PAGE_H - MARGIN

    def fits(self, height: float) -> bool:
        return self.y - height >= MARGIN + 20

    def text(self, x: float, y: float, text: str, size: float = BODY_SIZE, font: str = "F1", gray: float = 0.0) -> None:
        self.ops.append(f"BT {fmt(gray)} g /{font} {fmt(size)} Tf {fmt(x)} {fmt(y)} Td {pdf_string(text)} Tj ET")

    def lines(self, lines: list[str], size: float, leading: float, font: str = "F1", gray: float = 0.0) -> None:
        for line in lines:
            self.y -= leading
            self.text(MARGIN, self.y, line, size, font, gray)

    def rule(self, y: float, gray: float, width: float) -> None:
        self.ops.append(f"q {fmt(gray)} G {fmt(width)} w {fmt(MARGIN)} {fmt(y)} m {fmt(PAGE_W - MARGIN)} {fmt(y)} l S Q")

    def caption(self, text: str) -> None:
        self.y -= 2
        self.lines(wrap(text, 9, TEXT_W), 9, 12, "F3", 0.35)
        self.y -= 6


def draw_figure(page: Page, rng: random.Random, number: int) -> bool:
    height = rng.randint(140, 220)
    if not page.fits(height + 40):
        return False
    page.y -= 8
    bottom = page.y - height
    box = f"{fmt(MARGIN)} {fmt(bottom)} {fmt(TEXT_W)} {fmt(height)} re"
    page.ops.append(f"q {box} W n {random_color(rng, light=True)} rg {box} f")
    page.ops.extend(random_shape(rng, MARGIN, bottom, TEXT_W, height) for _ in range(rng.randint(10, 28)))
    page.ops.append(f"Q q 0.25 G 0.8 w {box} S Q")
    page.y = bottom
    page.caption(f"Figure {number}: {random_sentence(rng)}")
    return True


def draw_table(page: Page, rng: random.Random, number: int) -> bool:
    cols, rows, row_h = rng.randint(3, 5), rng.randint(3, 7), 18
    height = row_h * (rows + 1)
    if not page.fits(height + 40):
        return False
    page.y -= 8
    top = page.y
    col_w = TEXT_W / cols
    page.ops.append(f"q {random_color(rng, light=True)} rg {fmt(MARGIN)} {fmt(top - row_h)} {fmt(TEXT_W)} {fmt(row_h)} re f Q")
    for c in range(cols):
        label = random_word(rng).capitalize()
        while text_width(label, 10, bold=True) > col_w - 12:
            label = random_word(rng).capitalize()
        page.text(MARGIN + c * col_w + 6, top - row_h + 5.5, label, 10, "F2")
    for r in range(rows):
        baseline = top - (r + 2) * row_h + 5.5
        for c in range(cols):
            value = random_cell(rng)
            page.text(MARGIN + (c + 1) * col_w - 6 - text_width(value, 10), baseline, value, 10)
    grid = ["q 0.6 G 0.5 w"]
    grid += [f"{fmt(MARGIN)} {fmt(top - r * row_h)} m {fmt(MARGIN + TEXT_W)} {fmt(top - r * row_h)} l S" for r in range(rows + 2)]
    grid += [f"{fmt(MARGIN + c * col_w)} {fmt(top)} m {fmt(MARGIN + c * col_w)} {fmt(top - height)} l S" for c in range(cols + 1)]
    grid.append("Q")
    page.ops.extend(grid)
    page.y = top - height
    page.caption(f"Table {number}: {random_sentence(rng)}")
    return True


def fill_body(page: Page, rng: random.Random, counters: dict[str, int]) -> None:
    """Add random headings, paragraphs, figures and tables until the page is full."""
    for _ in range(40):
        kind = rng.choices(["heading", "paragraph", "figure", "table"], weights=[2, 6, 2, 1])[0]
        if kind == "heading":
            lines = wrap(f"{counters['section'] + 1}. {random_title(rng)}", 14, TEXT_W, bold=True)
            if not page.fits(18 * len(lines) + 4 * BODY_LEADING):
                return
            counters["section"] += 1
            page.y -= 8
            page.lines(lines, 14, 18, "F2")
            page.y -= 4
            kind = "paragraph"  # a heading is always followed by some text
        if kind == "paragraph":
            lines = wrap(random_paragraph(rng), BODY_SIZE, TEXT_W)
            room = int((page.y - MARGIN - 20) // BODY_LEADING)
            if room < 2:
                return
            page.lines(lines[:room], BODY_SIZE, BODY_LEADING)
            page.y -= 6
            if len(lines) > room:
                return
        elif kind == "figure":
            if draw_figure(page, rng, counters["figure"] + 1):
                counters["figure"] += 1
        elif kind == "table":
            if draw_table(page, rng, counters["table"] + 1):
                counters["table"] += 1


def build_pages(rng: random.Random, title: str, seed: int, stamp: dt.datetime, page_count: int) -> list[Page]:
    counters = {"section": 0, "figure": 0, "table": 0}
    pages: list[Page] = []
    for index in range(page_count):
        page = Page()
        if index == 0:
            page.y -= 16
            page.lines(wrap(title, 26, TEXT_W, bold=True), 26, 32, "F2")
            page.y -= 4
            subtitle = f"A randomly generated document  |  seed {seed}  |  {stamp:%Y-%m-%d %H:%M} UTC"
            page.lines([subtitle], 10, 14, "F3", 0.4)
            page.rule(page.y - 8, 0.0, 1.0)
            page.y -= 14
        else:
            page.text(MARGIN, PAGE_H - 50, title, 9, "F3", 0.5)
            page.rule(PAGE_H - 56, 0.7, 0.5)
        fill_body(page, rng, counters)
        footer = f"Page {index + 1} of {page_count}"
        page.text(MARGIN, FOOTER_Y, "Generated by build_random_pdf.py", 9, "F3", 0.5)
        page.text(PAGE_W - MARGIN - text_width(footer, 9), FOOTER_Y, footer, 9, "F1", 0.5)
        pages.append(page)
    return pages


def build_pdf(seed: int, pages: int | None = None) -> tuple[bytes, int]:
    """Return the PDF bytes and the number of pages for the given seed."""
    rng = random.Random(seed)
    page_count = rng.randint(2, 5)
    if pages:
        page_count = pages
    title = random_title(rng)
    stamp = dt.datetime.now(dt.timezone.utc)

    writer = PdfWriter()
    catalog = writer.reserve()
    pages_root = writer.reserve()
    font_refs = ""
    for name, base in FONTS.items():
        font = writer.add(f"<< /Type /Font /Subtype /Type1 /BaseFont /{base} /Encoding /WinAnsiEncoding >>")
        font_refs += f"/{name} {font} 0 R "
    kids: list[int] = []
    for page in build_pages(rng, title, seed, stamp, page_count):
        content = writer.add_stream("\n".join(page.ops).encode("latin-1"))
        kids.append(writer.add(
            f"<< /Type /Page /Parent {pages_root} 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
            f"/Resources << /Font << {font_refs} >> >> /Contents {content} 0 R >>"
        ))
    kid_refs = " ".join(f"{kid} 0 R" for kid in kids)
    writer.set(pages_root, f"<< /Type /Pages /Kids [{kid_refs}] /Count {len(kids)} >>")
    writer.set(catalog, f"<< /Type /Catalog /Pages {pages_root} 0 R >>")
    subject = pdf_string(f"Random document generated from seed {seed}")
    info = writer.add(
        f"<< /Title {pdf_string(title)} /Author (build_random_pdf.py) /Subject {subject} "
        f"/Producer (build_random_pdf.py) /CreationDate (D:{stamp:%Y%m%d%H%M%S}Z00'00') >>"
    )
    return writer.render(catalog, info), page_count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build a PDF file full of random content.")
    parser.add_argument("-o", "--output", type=Path, default=Path("random.pdf"), help="output path (default: random.pdf)")
    parser.add_argument("--pages", type=int, help="number of pages (default: random, 2-5)")
    parser.add_argument("--seed", type=int, help="seed for reproducible content (default: random)")
    args = parser.parse_args(argv)
    if args.pages is not None and args.pages < 1:
        parser.error("--pages must be at least 1")

    seed = args.seed if args.seed is not None else random.SystemRandom().randrange(1, 1_000_000_000)
    data, page_count = build_pdf(seed, args.pages)
    args.output.write_bytes(data)
    print(f"Wrote {args.output} ({page_count} pages, {len(data):,} bytes, seed {seed})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
