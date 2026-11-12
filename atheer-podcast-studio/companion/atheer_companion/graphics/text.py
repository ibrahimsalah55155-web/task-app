"""Arabic-correct text rendering: HarfBuzz shaping + FreeType rasterising.

Arabic letters change shape by position and need right-to-left layout with
left-to-right islands (numbers, English words). HarfBuzz does the shaping;
this module splits a line into direction runs, orders them visually and
rasterises the glyphs into an alpha mask (numpy float32, 0..1).
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import freetype
import numpy as np
import uharfbuzz as hb

FONT_DIR = Path(__file__).resolve().parent / "fonts"
FONTS = {
    "bold": FONT_DIR / "IBMPlexSansArabic-Bold.ttf",
    "medium": FONT_DIR / "IBMPlexSansArabic-Medium.ttf",
    "regular": FONT_DIR / "IBMPlexSansArabic-Regular.ttf",
}


def _strong_dir(ch: str) -> str | None:
    bd = unicodedata.bidirectional(ch)
    if bd in ("R", "AL"):
        return "rtl"
    if bd == "L":
        return "ltr"
    if bd in ("EN", "AN"):
        return "num"
    return None


def has_rtl(text: str) -> bool:
    return any(_strong_dir(c) == "rtl" for c in text)


def direction_runs(text: str) -> tuple[str, list[tuple[str, str]]]:
    """Split into (direction, substring) runs in LOGICAL order.

    Base direction is RTL when the line has any Arabic letter. Neutral
    characters (spaces, punctuation) join the run before them, except at a
    boundary between opposite runs where they take the base direction.
    Digits form LTR islands.
    """
    base = "rtl" if has_rtl(text) else "ltr"
    runs: list[list[str]] = []  # [dir, chars]
    for ch in text:
        d = _strong_dir(ch)
        if d == "num":
            d = "ltr"
        if d is None:
            if runs:
                runs[-1][1] += ch
            else:
                runs.append([base, ch])
            continue
        if runs and runs[-1][0] == d:
            runs[-1][1] += ch
        elif runs and runs[-1][0] != d and runs[-1][1].strip() == "":
            runs[-1] = [d, runs[-1][1] + ch]
        else:
            # Move trailing neutrals of an opposite-direction run back to the base direction.
            if runs and runs[-1][0] != base:
                body = runs[-1][1].rstrip()
                tail = runs[-1][1][len(body):]
                runs[-1][1] = body
                if tail:
                    runs.append([base, tail])
            if runs and runs[-1][0] == d:
                runs[-1][1] += ch
            else:
                runs.append([d, ch])
    return base, [(d, s) for d, s in runs if s]


@lru_cache(maxsize=8)
def _hb_font(path: str) -> tuple[hb.Font, int]:
    blob = hb.Blob.from_file_path(path)
    face = hb.Face(blob)
    font = hb.Font(face)
    return font, face.upem


@lru_cache(maxsize=8)
def _ft_face(path: str) -> freetype.Face:
    return freetype.Face(path)


@dataclass
class TextMask:
    mask: np.ndarray  # float32 HxW, 0..1
    ascent: int  # pixels above the baseline
    width: int
    height: int
    # x (pixels, from the left of the mask) where each logical character cluster starts,
    # used for word-by-word reveals.
    clusters: list[tuple[int, int, int]]  # (logical char index, x0, x1)


def shape_line(text: str, size_px: float, weight: str = "bold", tracking: float = 0.0) -> TextMask:
    path = str(FONTS[weight])
    font, upem = _hb_font(path)
    scale = size_px / upem
    face = _ft_face(path)
    face.set_pixel_sizes(0, max(1, int(round(size_px))))

    base, runs = direction_runs(text)
    shaped: list[tuple[str, int, list]] = []  # (dir, logical offset, glyphs)
    offset = 0
    for d, s in runs:
        buf = hb.Buffer()
        buf.add_str(s)
        buf.direction = d
        buf.guess_segment_properties()
        buf.direction = d
        hb.shape(font, buf, {"kern": True, "liga": True})
        glyphs = list(zip(buf.glyph_infos, buf.glyph_positions))
        shaped.append((d, offset, glyphs))
        offset += len(s)

    # Visual order of runs: RTL paragraphs show the first logical run on the right.
    visual = list(reversed(shaped)) if base == "rtl" else shaped

    asc = int(np.ceil(face.size.ascender / 64)) + 2
    desc = int(np.ceil(-face.size.descender / 64)) + 2
    pen = 0.0
    placements = []  # (gid, x, y, cluster, advance)
    for d, off, glyphs in visual:
        for info, pos in glyphs:  # HarfBuzz already returns RTL runs in visual order
            placements.append((info.codepoint, pen + pos.x_offset * scale, pos.y_offset * scale, off + info.cluster,
                               pos.x_advance * scale))
            pen += pos.x_advance * scale + tracking
    width = max(1, int(np.ceil(pen)) + 4)
    height = asc + desc
    mask = np.zeros((height, width), dtype=np.float32)
    cluster_x: dict[int, list[float]] = {}
    for gid, x, y, cl, adv in placements:
        face.load_glyph(gid, freetype.FT_LOAD_RENDER | freetype.FT_LOAD_TARGET_NORMAL)
        g = face.glyph
        bm = g.bitmap
        if bm.width and bm.rows:
            arr = np.array(bm.buffer, dtype=np.uint8).reshape(bm.rows, bm.pitch)[:, : bm.width].astype(np.float32) / 255
            x0 = int(round(x)) + g.bitmap_left + 2
            y0 = asc - g.bitmap_top - int(round(y))
            xa, ya = max(0, x0), max(0, y0)
            xb, yb = min(width, x0 + bm.width), min(height, y0 + bm.rows)
            if xb > xa and yb > ya:
                sub = arr[ya - y0: yb - y0, xa - x0: xb - x0]
                np.maximum(mask[ya:yb, xa:xb], sub, out=mask[ya:yb, xa:xb])
        # Pen span of the glyph (origin to origin + advance), so a word's area covers its letters.
        cluster_x.setdefault(cl, []).extend([x + 2, x + 2 + adv])
    clusters = sorted((cl, int(min(xs)), int(max(xs)) + 1) for cl, xs in cluster_x.items())
    return TextMask(mask=mask, ascent=asc, width=width, height=height, clusters=clusters)


def word_spans(text: str, tm: TextMask) -> list[tuple[int, int]]:
    """Pixel x-spans of each word, in logical (reading) order."""
    spans: list[tuple[int, int]] = []
    start = 0
    words = []
    for i, ch in enumerate(text + " "):
        if ch == " ":
            if i > start:
                words.append((start, i))
            start = i + 1
    for a, b in words:
        xs = [(x0, x1) for cl, x0, x1 in tm.clusters if a <= cl < b]
        if xs:
            spans.append((min(x for x, _ in xs), max(x for _, x in xs)))
    # Widen to the next word boundary so glyph extents (overhangs) are covered.
    return spans
