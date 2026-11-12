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


def _draw_caption(f: Frame, ctx: Ctx, text: str, style: str, speaker: str | None, highlight: int | None) -> None:
    s = ctx.s
    portrait = ctx.portrait
    y = (0.60 if portrait else 0.84) * ctx.h
    if style == "minimal":
        y = (0.78 if portrait else 0.88) * ctx.h
    size = {"podcast": 34, "clean": 46, "word": 50, "minimal": 32}[style] * s
    m = shape_line(text, size, "bold" if style != "minimal" else "medium")
    cx = ctx.w / 2
    x0, y0 = int(cx - m.width / 2), int(y - m.height / 2)
    if style == "podcast":
        guest = speaker != "host"
        padx, pady = 16 * s, 7 * s
        pill, _, _ = rounded_rect_mask(m.width + 2 * padx, m.height + 2 * pady, 10 * s)
        f.paint(pill, int(cx - pill.shape[1] / 2), int(y - pill.shape[0] / 2), hex_rgb(ctx.accent if guest else PAPER))
        f.paint(m.mask, x0, y0, hex_rgb(INK if guest else PAPER_INK))
        return
    if style == "minimal":
        padx, pady = 14 * s, 6 * s
        pill, _, _ = rounded_rect_mask(m.width + 2 * padx, m.height + 2 * pady, 6 * s)
        f.paint(pill, int(cx - pill.shape[1] / 2), int(y - pill.shape[0] / 2), (0, 0, 0), 0.55)
        f.paint(m.mask, x0, y0, hex_rgb(INK))
        return
    shadow = blur(m.mask, 5 * s)
    pad = (shadow.shape[0] - m.mask.shape[0]) // 2
    f.paint(shadow, x0 - pad, y0 - pad + int(3 * s), (0, 0, 0), 0.7)
    f.paint(m.mask, x0, y0, hex_rgb(INK))
    if style == "word" and highlight is not None:
        spans = word_spans(text, m)
        if 0 <= highlight < len(spans):
            a, b = spans[highlight]
            sub = m.mask[:, a:b]
            f.paint(sub, x0 + a, y0, hex_rgb(ctx.accent))


def render_caption_stills(captions: list[dict[str, Any]], style: str, width: int, height: int, out_dir: Path,
                          accent: str | None = None, progress=None, cancel=None) -> list[dict[str, Any]]:
    """One transparent PNG per caption (per word for the 'word' style), with its time range."""
    if style not in STYLES:
        raise ValueError(f"unknown caption style {style}")
    out_dir.mkdir(parents=True, exist_ok=True)
    ctx = Ctx(w=width, h=height, accent=accent or ACCENT)
    items: list[dict[str, Any]] = []
    total = len(captions)
    for i, c in enumerate(captions):
        if cancel is not None and cancel.is_set():
            raise RuntimeError("cancelled")
        if progress and i % 10 == 0:
            progress(i / max(1, total), "Rendering captions")
        states: list[tuple[float, float, int | None]]
        if style == "word" and c.get("words"):
            ws = c["words"]
            states = [(ws[k]["start"] if k else c["start"], ws[k + 1]["start"] if k + 1 < len(ws) else c["end"], k)
                      for k in range(len(ws))]
        else:
            states = [(c["start"], c["end"], None)]
        for a, b, hl in states:
            if b - a < 0.04:
                continue
            f = Frame(width, height)
            _draw_caption(f, ctx, c["text"], style, c.get("speaker"), hl)
            name = f"CAP_{i + 1:04d}{'' if hl is None else f'_{hl + 1:02d}'}.png"
            path = out_dir / name
            Image.fromarray(f.to_rgba8(), "RGBA").save(path, optimize=False, compress_level=6)
            items.append({"path": str(path), "start": round(a, 3), "end": round(b, 3), "caption": i})
    return items
