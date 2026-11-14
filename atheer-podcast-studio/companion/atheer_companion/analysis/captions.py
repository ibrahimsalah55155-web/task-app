"""Caption segmentation (Arabic first), SRT, and caption stills.

Captions are cut on natural boundaries: punctuation, pauses and a maximum
line length, never in the middle of a word. Words below a confidence
threshold are flagged for review in the panel.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from PIL import Image

from ..graphics.canvas import Frame, blur, hex_rgb, rounded_rect_mask
from ..graphics.templates import ACCENT, INK, PAPER, PAPER_INK, Ctx
from ..graphics.text import has_rtl, shape_line, word_spans

END_PUNCT = ("。", ".", "؟", "?", "!", "؛")
SOFT_PUNCT = ("،", ",", ":")


def normalise_arabic(text: str) -> str:
    t = re.sub(r"\s+", " ", text).strip()
    if has_rtl(t):
        t = t.replace("?", "؟").replace(",", "،").replace(";", "؛")
    return t


def build_captions(words: list[dict[str, Any]], max_chars: int = 32, max_dur: float = 5.0, min_dur: float = 0.8,
                   gap_split: float = 0.6, low_conf: float = 0.5) -> list[dict[str, Any]]:
    caps: list[dict[str, Any]] = []
    cur: list[dict[str, Any]] = []

    def flush():
        if not cur:
            return
        text = normalise_arabic(" ".join(w["word"] for w in cur))
        speakers = [w.get("speaker") for w in cur if w.get("speaker")]
        caps.append({
            "start": round(cur[0]["start"], 3),
            "end": round(cur[-1]["end"], 3),
            "text": text,
            "words": [{"start": round(w["start"], 3), "end": round(w["end"], 3), "word": w["word"]} for w in cur],
            "speaker": max(set(speakers), key=speakers.count) if speakers else None,
            "lowConfidence": [i for i, w in enumerate(cur) if float(w.get("prob", 1)) < low_conf],
        })
        cur.clear()

    for w in words:
        word = w["word"].strip()
        if not word:
            continue
        if cur:
            gap = w["start"] - cur[-1]["end"]
            length = len(" ".join(x["word"] for x in cur)) + 1 + len(word)
            dur = w["end"] - cur[0]["start"]
            if gap > gap_split or length > max_chars or dur > max_dur:
                flush()
        cur.append({**w, "word": word})
        if word.endswith(END_PUNCT) and cur[-1]["end"] - cur[0]["start"] >= min_dur:
            flush()
        elif word.endswith(SOFT_PUNCT) and len(" ".join(x["word"] for x in cur)) >= max_chars * 0.6:
            flush()
    flush()
    # small hold so captions do not flash, without overlapping the next one
    for i, c in enumerate(caps):
        nxt = caps[i + 1]["start"] if i + 1 < len(caps) else c["end"] + 0.3
        c["end"] = round(min(max(c["end"] + 0.15, c["start"] + min_dur), nxt), 3)
    return caps


def _ts(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def to_srt(captions: list[dict[str, Any]]) -> str:
    out = []
    for i, c in enumerate(captions, 1):
        out.append(f"{i}\n{_ts(c['start'])} --> {_ts(c['end'])}\n{c['text']}\n")
    return "\n".join(out)


STYLES = {
    "podcast": {"en": "Bold podcast (host white / guest coral)", "ar": "بودكاست (المذيع أبيض / الضيف كورال)"},
    "clean": {"en": "Clean documentary", "ar": "وثائقي بسيط"},
    "word": {"en": "Word emphasis", "ar": "إبراز الكلمة"},
    "minimal": {"en": "Minimal modern", "ar": "مودرن بسيط"},
}


def _hex(c: str | None, fallback: str) -> tuple[int, int, int]:
    try:
        return hex_rgb(c) if c else hex_rgb(fallback)
    except Exception:  # noqa: BLE001
        return hex_rgb(fallback)


def style_defaults(style: str, accent: str) -> dict[str, Any]:
    """Every style as plain settings; the panel's caption controls override any of them."""
    base = {"position": "bottom", "yPercent": None, "size": 1.0, "weight": "bold", "textColor": INK,
            "highlightColor": accent, "box": False, "boxColor": "#000000", "boxOpacity": 0.55, "radius": 8,
            "shadow": True, "maxWidthPercent": 90, "guestColor": None, "hostColor": None}
    if style == "podcast":
        return {**base, "box": True, "boxOpacity": 1.0, "radius": 10, "shadow": False, "baseSize": 34,
                "guestColor": accent, "hostColor": PAPER, "guestText": INK, "hostText": PAPER_INK}
    if style == "minimal":
        return {**base, "box": True, "boxOpacity": 0.55, "radius": 6, "shadow": False, "baseSize": 32,
                "weight": "medium", "position": "lower"}
    if style == "clean":
        return {**base, "baseSize": 46}
    return {**base, "baseSize": 50}  # word


def _y(o: dict[str, Any], ctx: Ctx) -> float:
    if o.get("yPercent") is not None:
        return max(5.0, min(95.0, float(o["yPercent"]))) / 100 * ctx.h
    pos = o.get("position", "bottom")
    table = {"top": (0.16, 0.12), "middle": (0.50, 0.50), "bottom": (0.60, 0.84), "lower": (0.78, 0.88)}
    p, l = table.get(pos, table["bottom"])
    return (p if ctx.portrait else l) * ctx.h


def _draw_caption(f: Frame, ctx: Ctx, text: str, style: str, speaker: str | None, highlight: int | None,
                  opts: dict[str, Any] | None = None) -> None:
    s = ctx.s
    o = {**style_defaults(style, ctx.accent), **{k: v for k, v in (opts or {}).items() if v is not None and v != ""}}
    size = float(o["baseSize"]) * float(o.get("size", 1.0)) * s
    weight = "medium" if o.get("weight") == "medium" else "bold"
    m = shape_line(text, size, weight)
    max_w = float(o.get("maxWidthPercent", 90)) / 100 * ctx.w
    pad_of = (lambda mm: (0.45 * mm.height, 0.2 * mm.height)) if o.get("box") else (lambda mm: (0.0, 0.0))
    total = m.width + 2 * pad_of(m)[0]
    if total > max_w:  # long line: shrink to fit (box included) instead of running off the frame
        m = shape_line(text, size * max_w / total * 0.98, weight)
    cx = ctx.w / 2
    y = _y(o, ctx)
    x0, y0 = int(cx - m.width / 2), int(y - m.height / 2)
    who = "host" if speaker == "host" else "guest" if speaker == "guest" else None
    text_rgb = _hex(o.get(f"{who}Text") if who and style == "podcast" and not (opts or {}).get("textColor") else o.get("textColor"), INK)
    if o.get("box"):
        box_hex = o.get(f"{who}Color") if who and o.get(f"{who}Color") else o.get("boxColor")
        padx, pady = pad_of(m)
        pill, _, _ = rounded_rect_mask(m.width + 2 * padx, m.height + 2 * pady, float(o.get("radius", 8)) * s)
        f.paint(pill, int(cx - pill.shape[1] / 2), int(y - pill.shape[0] / 2), _hex(box_hex, "#000000"),
                float(o.get("boxOpacity", 1.0)))
    else:
        if who and o.get(f"{who}Color") and (opts or {}).get(f"{who}Color"):
            text_rgb = _hex(o.get(f"{who}Color"), INK)
    if o.get("shadow"):
        shadow = blur(m.mask, 5 * s)
        pad = (shadow.shape[0] - m.mask.shape[0]) // 2
        f.paint(shadow, x0 - pad, y0 - pad + int(3 * s), (0, 0, 0), 0.7)
    f.paint(m.mask, x0, y0, text_rgb)
    if highlight is not None:
        spans = word_spans(text, m)
        if 0 <= highlight < len(spans):
            a, b = spans[highlight]
            f.paint(m.mask[:, a:b], x0 + a, y0, _hex(o.get("highlightColor"), ctx.accent))


def render_caption_stills(captions: list[dict[str, Any]], style: str, width: int, height: int, out_dir: Path,
                          accent: str | None = None, progress=None, cancel=None,
                          opts: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """One transparent PNG per caption (per word for the 'word' style), with its time range."""
    if style not in STYLES:
        raise ValueError(f"unknown caption style {style}")
    out_dir.mkdir(parents=True, exist_ok=True)
    # File names unique per render: Premiere (and the panel) must never mistake an older render's
    # CAP_0001.png for this one's.
    import hashlib
    import time as _time

    run = hashlib.sha1(f"{out_dir}|{_time.time_ns()}".encode()).hexdigest()[:6]
    ctx = Ctx(w=width, h=height, accent=accent or ACCENT)
    items: list[dict[str, Any]] = []
    total = len(captions)
    for i, c in enumerate(captions):
        if cancel is not None and cancel.is_set():
            raise RuntimeError("cancelled")
        if progress and i % 10 == 0:
            progress(i / max(1, total), "Rendering captions")
        states: list[tuple[float, float, int | None]]
        if (style == "word" or (opts or {}).get("wordByWord")) and c.get("words"):
            ws = c["words"]
            states = [(ws[k]["start"] if k else c["start"], ws[k + 1]["start"] if k + 1 < len(ws) else c["end"], k)
                      for k in range(len(ws))]
        else:
            states = [(c["start"], c["end"], None)]
        for a, b, hl in states:
            if b - a < 0.04:
                continue
            f = Frame(width, height)
            _draw_caption(f, ctx, c["text"], style, c.get("speaker"), hl, opts)
            name = f"CAP_{run}_{i + 1:04d}{'' if hl is None else f'_{hl + 1:02d}'}.png"
            path = out_dir / name
            Image.fromarray(f.to_rgba8(), "RGBA").save(path, optimize=False, compress_level=6)
            items.append({"path": str(path), "start": round(a, 3), "end": round(b, 3), "caption": i})
    return items


def preview_caption(text: str, style: str, width: int, height: int, accent: str | None = None,
                    speaker: str | None = "guest", opts: dict[str, Any] | None = None, highlight: int | None = None) -> bytes:
    """PNG of one caption over a neutral grey frame (for the panel's live preview)."""
    import io

    f = Frame(width, height)
    _draw_caption(f, Ctx(w=width, h=height, accent=accent or ACCENT), text, style, speaker, highlight, opts)
    rgba = f.to_rgba8()
    bg = Image.new("RGBA", (width, height), (58, 60, 64, 255))
    bg.alpha_composite(Image.fromarray(rgba, "RGBA"))
    bg.thumbnail((360, 640))
    buf = io.BytesIO()
    bg.convert("RGB").save(buf, "PNG")
    return buf.getvalue()
