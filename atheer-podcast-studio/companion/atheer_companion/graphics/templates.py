"""Motion templates modelled on docs/motion/REF_01_vertical_reel.md.

Each template draws one frame for time t (seconds). Layout works for vertical
(1080x1920) and horizontal (1920x1080) frames: sizes scale with the short side.
Right-to-left by default; English text mirrors the layout.

The disc icon is our own neutral design (three waveform bars). The editor can
replace it with a logo image (`icon` field).
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np

from .canvas import (Frame, blur, circle_mask, clamp01, ease_in_cubic, ease_in_out_cubic, ease_out_back,
                     ease_out_cubic, ease_out_quint, hex_rgb, horizontal_ramp, load_logo, progress,
                     rounded_rect_mask)
from .text import has_rtl, shape_line, word_spans

ACCENT = "#EC797B"
INK = "#FFFFFF"
PAPER = "#F4F5F7"
PAPER_INK = "#1B2340"
PANEL = "#0B213C"
DOTS = "#2B2F7A"
CTA_BG = "#161B45"


@dataclass
class Ctx:
    w: int
    h: int
    fps: int = 25
    accent: str = ACCENT
    icon_path: str | None = None

    @property
    def s(self) -> float:
        return min(self.w, self.h) / 1080

    @property
    def portrait(self) -> bool:
        return self.h >= self.w


# ---- shared pieces ---------------------------------------------------------------

def draw_icon(f: Frame, ctx: Ctx, cx: float, cy: float, radius: float, opacity: float = 1.0, scale: float = 1.0) -> None:
    r = radius * scale
    if r < 0.5 or opacity <= 0:
        return
    disc = circle_mask(r)
    n = disc.shape[0]
    f.paint(disc, int(round(cx - n / 2)), int(round(cy - n / 2)), hex_rgb(ctx.accent), opacity)
    logo = load_logo(ctx.icon_path, int(r * 1.3)) if ctx.icon_path else None
    if logo is not None:
        f.paint_rgba(logo, int(round(cx - logo.shape[1] / 2)), int(round(cy - logo.shape[0] / 2)), opacity)
        return
    # Default mark: three rounded waveform bars.
    bw = max(1.0, r * 0.2)
    for i, hgt in enumerate((0.55, 0.95, 0.65)):
        bh = r * hgt
        bar, _, _ = rounded_rect_mask(bw, bh, bw / 2)
        bx = cx + (i - 1) * bw * 1.7
        f.paint(bar, int(round(bx - bar.shape[1] / 2)), int(round(cy - bar.shape[0] / 2)), hex_rgb(DOTS), opacity)


def youtube_glyph(f: Frame, cx: float, cy: float, r: float, opacity: float, accent: str) -> None:
    body, _, _ = rounded_rect_mask(r * 1.15, r * 0.8, r * 0.22)
    f.paint(body, int(round(cx - body.shape[1] / 2)), int(round(cy - body.shape[0] / 2)), hex_rgb(INK), opacity)
    # play triangle
    n = int(r * 0.6) + 2
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    tri = ((xx - n * 0.25) / (n * 0.55) <= 1 - np.abs(yy - n / 2) / (n * 0.32)) & (xx >= n * 0.25)
    f.paint(blur(tri.astype(np.float32), 0.6)[2:-2, 2:-2] if n > 6 else tri.astype(np.float32),
            int(round(cx - n * 0.45)), int(round(cy - n / 2)), hex_rgb(accent), opacity)


def _det_noise(i: int, seed: str) -> float:
    return int(hashlib.md5(f"{seed}:{i}".encode()).hexdigest()[:6], 16) / 0xFFFFFF


# ---- templates ---------------------------------------------------------------------

@dataclass
class Template:
    id: str
    title: dict[str, str]
    fields: list[dict[str, Any]]
    default_duration: float
    draw: Callable[[Frame, Ctx, float, float, dict[str, Any]], None]
    hold_time: Callable[[float], float] = field(default=lambda d: d / 2)
    full_frame: bool = False

    def describe(self) -> dict[str, Any]:
        return {"id": self.id, "title": self.title, "fields": self.fields,
                "defaultDuration": self.default_duration, "fullFrame": self.full_frame}


def _lower_third(f: Frame, ctx: Ctx, t: float, dur: float, p: dict[str, Any]) -> None:
    s = ctx.s
    name, sub = str(p.get("name", "")), str(p.get("title", ""))
    rtl = has_rtl(name + sub) or not (name + sub).strip()
    nm = shape_line(name, 46 * s, "bold")
    tm = shape_line(sub, 29 * s, "regular")
    r = 24 * s
    if ctx.portrait:
        icon_cx, icon_cy = 0.843 * ctx.w, 0.745 * ctx.h
    else:
        icon_cx, icon_cy = 0.885 * ctx.w, 0.80 * ctx.h
    if not rtl:
        icon_cx = ctx.w - icon_cx
    gap = 14 * s
    text_w = max(nm.width, tm.width)
    line_len = text_w + 40 * s
    text_edge = icon_cx - r - gap if rtl else icon_cx + r + gap  # where text starts (reading side)
    line_far = text_edge - line_len if rtl else text_edge + line_len
    line_near = text_edge
    thick = max(2.0, 2.2 * s)

    out_start = dur - 0.95
    # icon travel (beat 1) and exit
    p_in = ease_out_quint(progress(t, 0.0, 0.95))
    start_x = -r * 2 if rtl else ctx.w + r * 2
    cx = start_x + (icon_cx - start_x) * p_in
    p_out = progress(t, out_start + 0.45, 0.5)
    icon_scale = 1 - ease_in_cubic(p_out)
    # line: drawn behind the travelling icon, retracts towards the icon on exit
    a, b = (line_far, min(cx - r, line_near)) if rtl else (max(cx + r, line_near), line_far)
    if rtl:
        a = max(a, start_x)
    retract = ease_in_out_cubic(progress(t, out_start + 0.2, 0.45))
    if retract > 0:
        if rtl:
            a = a + (line_near - a) * retract
        else:
            b = b - (b - line_near) * retract
    lo, hi = min(a, b), max(a, b)
    if hi - lo > 1 and p_in > 0:
        bar = np.ones((int(thick), int(hi - lo)), np.float32)
        f.paint(bar, int(lo), int(icon_cy - thick / 2), hex_rgb(INK), 0.9)

    # text reveal (beat 2) from the icon outwards; hide back towards the icon on exit
    def reveal(mask_obj, start, ybase, size_alpha=1.0):
        rev = ease_out_cubic(progress(t, start, 0.85))
        hide = ease_in_cubic(progress(t, out_start, 0.5))
        vis = clamp01(rev - hide)
        if vis <= 0:
            return
        w, h = mask_obj.width, mask_obj.height
        soft = 18 * s
        if rtl:
            x0 = int(text_edge - w)
            edge = w - vis * (w + soft)
            ramp = horizontal_ramp(w, h, edge, soft, keep_right=True)
        else:
            x0 = int(text_edge)
            edge = vis * (w + soft)
            ramp = horizontal_ramp(w, h, edge, soft, keep_right=False)
        f.paint(mask_obj.mask * ramp, x0, int(ybase), hex_rgb(INK), size_alpha)

    reveal(nm, 0.88, icon_cy - thick - 6 * s - nm.height)
    reveal(tm, 1.0, icon_cy + thick + 2 * s, 0.95)
    draw_icon(f, ctx, cx, icon_cy, r, 1.0, icon_scale)


def _title_card(f: Frame, ctx: Ctx, t: float, dur: float, p: dict[str, Any]) -> None:
    s = ctx.s
    lines = [str(p.get("line1", "")), str(p.get("line2", ""))]
    lines = [ln for ln in lines if ln.strip()] or [" "]
    masks = [shape_line(ln, 66 * s, "bold") for ln in lines]
    r = 22 * s
    pad = 34 * s
    line_h = 66 * s * 1.28
    content_h = 2 * r + 16 * s + line_h * len(masks)
    pw = max(0.76 * ctx.w if ctx.portrait else 0.46 * ctx.w, max(m.width for m in masks) + 2 * pad)
    ph = content_h + 2 * pad
    cx = ctx.w / 2
    cy = (0.665 if ctx.portrait else 0.70) * ctx.h

    p_in = ease_out_cubic(progress(t, 0.0, 0.7))
    p_out = progress(t, dur - 0.5, 0.5)
    rise = (1 - p_in) * 70 * s
    alpha = p_in

    panel, _, _ = rounded_rect_mask(pw, ph, 16 * s)
    H, W = panel.shape
    xs = np.arange(W, dtype=np.float32)
    period = 7 * s
    ribs = 0.5 + 0.5 * np.sin(2 * math.pi * xs / period)
    band_c = (-0.3 + 1.6 * ((t * 0.45) % 1.0)) * W  # shimmer moving across
    band = np.exp(-((xs - band_c) / (0.18 * W)) ** 2)
    light = (0.05 + 0.10 * band) * ribs  # white rib highlights
    # exit: columns vanish in a deterministic order ("blinds")
    col_vis = np.ones(W, np.float32)
    if p_out > 0:
        cols = (xs // max(1, int(10 * s))).astype(int)
        order = np.array([_det_noise(int(c), "blinds") for c in range(cols.max() + 1)], np.float32)[cols]
        col_vis = np.clip((order - p_out * 1.2) * 6 + 1, 0, 1)
        alpha *= 1 - 0.4 * p_out
    px, py = int(cx - W / 2), int(cy - H / 2 + rise)
    f.paint(panel * col_vis, px, py, hex_rgb(PANEL), 0.84 * alpha)
    f.paint(panel * col_vis * light[None, :], px, py, hex_rgb(INK), alpha)

    text_a = ease_out_cubic(progress(t, 0.22, 0.5)) * (1 - p_out)
    y = py + pad
    draw_icon(f, ctx, cx, y + r, r, alpha * (1 - p_out))
    y += 2 * r + 16 * s
    for m in masks:
        mx = int(cx - m.width / 2)
        cv = col_vis[max(0, mx - px): max(0, mx - px) + m.width]
        cvm = np.ones(m.width, np.float32)
        cvm[: len(cv)] = cv
        f.paint(m.mask * cvm[None, :], mx, int(y + (line_h - m.height) / 2 + (1 - text_a) * 14 * s), hex_rgb(INK), text_a)
        y += line_h


def _emphasis(f: Frame, ctx: Ctx, t: float, dur: float, p: dict[str, Any]) -> None:
    s = ctx.s
    text = str(p.get("text", ""))
    m = shape_line(text, 60 * s, "bold")
    cx, cy = ctx.w / 2, (0.52 if ctx.portrait else 0.5) * ctx.h
    x0, y0 = int(cx - m.width / 2), int(cy - m.height / 2)
    spans = word_spans(text, m)
    rtl = has_rtl(text)
    n = max(1, len(spans))
    step = 0.9 / n
    out = 1 - progress(t, dur - 0.12, 0.12)
    vis = np.zeros(m.width, np.float32)
    # Each word owns the strip up to the midpoint of the gap to its neighbours, so no
    # glyph part (overhangs, dots) is ever cut. Words fade in in reading order.
    order = sorted(range(len(spans)), key=lambda i: spans[i][0])
    bounds: dict[int, tuple[int, int]] = {}
    for k, i in enumerate(order):
        lo = 0 if k == 0 else (spans[order[k - 1]][1] + spans[i][0]) // 2
        hi = m.width if k == len(order) - 1 else (spans[i][1] + spans[order[k + 1]][0]) // 2
        bounds[i] = (lo, hi)
    for i in range(len(spans)):
        k = ease_out_cubic(progress(t, i * step, 0.16))
        lo, hi = bounds[i]
        vis[lo:hi] = np.maximum(vis[lo:hi], k)
    if not spans:
        vis[:] = ease_out_cubic(progress(t, 0, 0.3))
    _ = rtl
    mask = m.mask * vis[None, :]
    shadow = blur(mask, 6 * s)
    pad = (shadow.shape[0] - mask.shape[0]) // 2
    f.paint(shadow, x0 - pad, y0 - pad + int(3 * s), (0, 0, 0), 0.55 * out)
    f.paint(mask, x0, y0, hex_rgb(INK), out)


def _caption(f: Frame, ctx: Ctx, t: float, dur: float, p: dict[str, Any]) -> None:
    s = ctx.s
    text = str(p.get("text", ""))
    guest = str(p.get("speaker", "guest")) != "host"
    m = shape_line(text, 34 * s, "bold")
    padx, pady = 16 * s, 7 * s
    pw, ph = m.width + 2 * padx, m.height + 2 * pady
    cx, cy = ctx.w / 2, (0.60 if ctx.portrait else 0.84) * ctx.h
    pill, _, _ = rounded_rect_mask(pw, ph, 10 * s)
    px, py = int(cx - pill.shape[1] / 2), int(cy - pill.shape[0] / 2)
    f.paint(pill, px, py, hex_rgb(ctx.accent if guest else PAPER))
    f.paint(m.mask, int(cx - m.width / 2), int(cy - m.height / 2), hex_rgb(INK if guest else PAPER_INK))


def _cta(f: Frame, ctx: Ctx, t: float, dur: float, p: dict[str, Any]) -> None:
    s = ctx.s
    text = str(p.get("text", ""))
    rtl = has_rtl(text) or not text.strip()
    m = shape_line(text, 26 * s, "medium")
    r = 20 * s
    ph = 2 * r
    pw_full = m.width + 2 * r + 34 * s
    cx_icon = (0.5 * ctx.w + pw_full / 2 - r) if rtl else (0.5 * ctx.w - pw_full / 2 + r)
    cy = (0.715 if ctx.portrait else 0.88) * ctx.h
    p_pop = progress(t, 0.0, 0.32)
    p_ext = ease_out_cubic(progress(t, 0.22, 0.45))
    p_txt = ease_out_cubic(progress(t, 0.42, 0.4))
    out = progress(t, dur - 0.5, 0.5)
    p_ext *= 1 - ease_in_cubic(clamp01(out * 1.6))
    p_txt *= 1 - clamp01(out * 2.2)
    icon_scale = (ease_out_back(p_pop) if p_pop < 1 else 1.0) * (1 - ease_in_cubic(clamp01((out - 0.45) / 0.55)))
    pw = 2 * r + (pw_full - 2 * r) * p_ext
    if pw > 2 * r + 1:
        pill, _, _ = rounded_rect_mask(pw, ph, r)
        x = int(cx_icon + r - pill.shape[1]) if rtl else int(cx_icon - r)
        f.paint(pill, x, int(cy - pill.shape[0] / 2), hex_rgb(CTA_BG), 0.92)
        if p_txt > 0:
            tx = (cx_icon - r - 14 * s - m.width) if rtl else (cx_icon + r + 14 * s)
            f.paint(m.mask, int(tx), int(cy - m.height / 2), hex_rgb(INK), p_txt)
    if r * icon_scale >= 1:
        disc = circle_mask(r * icon_scale)
        n = disc.shape[0]
        f.paint(disc, int(cx_icon - n / 2), int(cy - n / 2), hex_rgb(ctx.accent))
        youtube_glyph(f, cx_icon, cy, r * 0.62 * icon_scale, 1.0, ctx.accent)


def _outro(f: Frame, ctx: Ctx, t: float, dur: float, p: dict[str, Any]) -> None:
    s = ctx.s
    fade = ease_out_cubic(progress(t, 0, 0.6))
    W, H = ctx.w, ctx.h
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    g = np.clip((xx / W) * 0.55 + (yy / H) * 0.45, 0, 1)
    c1, c2 = np.array(hex_rgb("#1E2A8E")), np.array(hex_rgb("#127A8A"))
    rgb = c1[None, None, :] * (1 - g[..., None]) + c2[None, None, :] * g[..., None]
    xs = np.arange(W, dtype=np.float32)
    streaks = np.zeros(W, np.float32)
    for i in range(14):
        base = _det_noise(i, "streak") * W
        speed = (0.03 + 0.05 * _det_noise(i, "speed")) * W
        x = (base + speed * t) % W
        width = (2 + 10 * _det_noise(i, "w")) * s
        streaks += np.exp(-((xs - x) / width) ** 2) * (0.10 + 0.18 * _det_noise(i, "a"))
    rgb = np.clip(rgb + streaks[None, :, None], 0, 1)
    layer = np.concatenate([rgb * fade, np.full((H, W, 1), fade, np.float32)], axis=2).astype(np.float32)
    f.paint_rgba(layer, 0, 0)
    ta = ease_out_cubic(progress(t, 0.4, 0.7)) * (1 - progress(t, dur - 0.3, 0.3))
    y = H * 0.47
    if ctx.icon_path:
        logo = load_logo(ctx.icon_path, int(220 * s))
        if logo is not None:
            f.paint_rgba(logo, int(W / 2 - logo.shape[1] / 2), int(y - logo.shape[0] / 2), ta)
            y += logo.shape[0] / 2 + 30 * s
    else:
        tm = shape_line(str(p.get("title", "")), 84 * s, "bold")
        f.paint(tm.mask, int(W / 2 - tm.width / 2), int(y - tm.height / 2 + (1 - ta) * 12 * s), hex_rgb(INK), ta)
        y += tm.height / 2 + 18 * s
    sub = shape_line(str(p.get("tagline", "")), 44 * s, "regular")
    f.paint(sub.mask, int(W / 2 - sub.width / 2), int(y), hex_rgb(INK), 0.85 * ta)


def _f(fid: str, en: str, ar: str, default: str = "", kind: str = "text", options: list | None = None) -> dict[str, Any]:
    d: dict[str, Any] = {"id": fid, "label": {"en": en, "ar": ar}, "default": default, "kind": kind}
    if options:
        d["options"] = options
    return d


TEMPLATES: dict[str, Template] = {
    t.id: t
    for t in [
        Template("lower_third", {"en": "Guest name", "ar": "اسم الضيف"},
                 [_f("name", "Name", "الاسم", "د. اسم الضيف"),
                  _f("title", "Title", "الصفة", "التخصص أو الوظيفة")],
                 6.0, _lower_third, hold_time=lambda d: min(3.0, d - 1.2)),
        Template("title_card", {"en": "Title card", "ar": "كارت عنوان"},
                 [_f("line1", "Line 1", "السطر الأول", "اجعل الجدة"),
                  _f("line2", "Line 2", "السطر الثاني", "جزءًا من حياتك")],
                 4.0, _title_card, hold_time=lambda d: min(2.0, d - 0.6)),
        Template("emphasis", {"en": "Emphasis words", "ar": "كلمات تأكيد"},
                 [_f("text", "Text", "النص", "أنشطة جماعية")],
                 2.5, _emphasis, hold_time=lambda d: min(1.6, d - 0.2)),
        Template("caption", {"en": "Caption", "ar": "كابشن"},
                 [_f("text", "Text", "النص", "نحرص على الزيارات العائلية"),
                  _f("speaker", "Speaker", "المتكلم", "guest", "choice",
                     [{"value": "guest", "label": {"en": "Guest", "ar": "الضيف"}},
                      {"value": "host", "label": {"en": "Host", "ar": "المذيع"}}])],
                 2.0, _caption),
        Template("cta", {"en": "Watch on YouTube", "ar": "تابع على يوتيوب"},
                 [_f("text", "Text", "النص", "تابع الحلقة كاملة على يوتيوب")],
                 5.0, _cta, hold_time=lambda d: min(2.0, d - 0.6)),
        Template("outro", {"en": "Outro", "ar": "الخاتمة"},
                 [_f("title", "Title", "العنوان", "مجموعة الملتيميديا والذكاء الاصطناعي"),
                  _f("tagline", "Tagline", "الشعار", "استوديو البودكاست")],
                 4.0, _outro, hold_time=lambda d: min(2.5, d - 0.4), full_frame=True),
    ]
}
