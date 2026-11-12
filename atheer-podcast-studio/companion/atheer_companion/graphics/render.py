"""Render a template to a transparent video (ProRes 4444 with alpha) or a preview PNG."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import subprocess
import threading
from fractions import Fraction
from pathlib import Path
from typing import Any, Callable

from PIL import Image

from .canvas import Frame
from .templates import TEMPLATES, Ctx

RENDERER_VERSION = "gfx-1"


class RenderError(RuntimeError):
    pass


def _rate(fps: float) -> Fraction:
    """25 -> 25/1, 29.97 -> 30000/1001, 23.976 -> 24000/1001."""
    for ntsc in (Fraction(24000, 1001), Fraction(30000, 1001), Fraction(60000, 1001)):
        if abs(fps - float(ntsc)) < 0.01:
            return ntsc
    return Fraction(fps).limit_denominator(1001)


def _ctx(width: int, height: int, fps: float, opts: dict[str, Any]) -> Ctx:
    if not (64 <= width <= 8192 and 64 <= height <= 8192):
        raise RenderError("frame size out of range")
    if not 12 <= fps <= 120:
        raise RenderError("unsupported frame rate")
    icon = opts.get("icon")
    if icon and not Path(icon).is_file():
        icon = None
    return Ctx(w=width, h=height, fps=round(fps), accent=opts.get("accent") or "#EC797B", icon_path=icon)


def _fields(template_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    tpl = TEMPLATES.get(template_id)
    if not tpl:
        raise RenderError(f"unknown template {template_id!r}")
    out = {f["id"]: f.get("default", "") for f in tpl.fields}
    for k, v in (fields or {}).items():
        if k in out:
            out[k] = str(v)[:200]
    return out


def draw_frame(template_id: str, fields: dict[str, Any], width: int, height: int, t: float,
               duration: float | None = None, fps: int = 25, opts: dict[str, Any] | None = None) -> Frame:
    tpl = TEMPLATES[template_id]
    ctx = _ctx(width, height, fps, opts or {})
    dur = duration or tpl.default_duration
    frame = Frame(width, height)
    tpl.draw(frame, ctx, t, dur, _fields(template_id, fields))
    return frame


def preview_png(template_id: str, fields: dict[str, Any], width: int, height: int,
                duration: float | None = None, opts: dict[str, Any] | None = None, max_width: int = 360,
                crop: bool = False) -> str:
    """Base64 PNG of the template at its 'hold' moment, scaled down for the panel."""
    tpl = TEMPLATES.get(template_id)
    if not tpl:
        raise RenderError(f"unknown template {template_id!r}")
    dur = duration or tpl.default_duration
    frame = draw_frame(template_id, fields, width, height, tpl.hold_time(dur), dur, 25, opts)
    img = Image.fromarray(frame.to_rgba8(), "RGBA")
    if crop and not tpl.full_frame:
        bbox = img.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
        if bbox:
            pad = int(min(width, height) * 0.04)
            x0, y0, x1, y1 = max(0, bbox[0] - pad), max(0, bbox[1] - pad), min(width, bbox[2] + pad), min(height, bbox[3] + pad)
            # widen to a 16:9 box so every card thumbnail has the same shape
            cw, ch = x1 - x0, y1 - y0
            if cw / max(ch, 1) < 16 / 9:
                extra = int(ch * 16 / 9) - cw
                x0, x1 = max(0, x0 - extra // 2), min(width, x1 + extra - extra // 2)
            else:
                extra = int(cw * 9 / 16) - ch
                y0, y1 = max(0, y0 - extra // 2), min(height, y1 + extra - extra // 2)
            img = img.crop((x0, y0, x1, y1))
    if img.width > max_width:
        img = img.resize((max_width, round(img.height * max_width / img.width)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _icon_stamp(path: str | None) -> str | None:
    """A changed logo file must produce a new render."""
    try:
        st = Path(path).stat() if path else None
    except OSError:
        return None
    return f"{st.st_size}:{st.st_mtime_ns}" if st else None


def render_key(template_id: str, fields: dict[str, Any], width: int, height: int, fps: float, duration: float,
               opts: dict[str, Any]) -> str:
    payload = json.dumps([RENDERER_VERSION, template_id, _fields(template_id, fields), width, height, fps,
                          round(duration, 3), opts.get("accent"), opts.get("icon"),
                          _icon_stamp(opts.get("icon"))], sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(payload.encode()).hexdigest()[:12]


def render_video(ffmpeg: str | None, template_id: str, fields: dict[str, Any], width: int, height: int, fps: float,
                 duration: float | None, out_dir: Path, opts: dict[str, Any] | None = None,
                 progress: Callable[[float], None] | None = None,
                 cancel: threading.Event | None = None) -> dict[str, Any]:
    if not ffmpeg:
        raise RenderError("ffmpeg not found")
    tpl = TEMPLATES.get(template_id)
    if not tpl:
        raise RenderError(f"unknown template {template_id!r}")
    opts = opts or {}
    dur = float(duration or tpl.default_duration)
    if not 0.2 <= dur <= 120:
        raise RenderError("duration must be between 0.2 and 120 seconds")
    ctx = _ctx(width, height, fps, opts)
    vals = _fields(template_id, fields)
    key = render_key(template_id, fields, width, height, fps, dur, opts)
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"MAG_{template_id}_{key}.mov"
    sidecar = out.with_suffix(".json")
    meta = {"template": template_id, "fields": vals, "width": width, "height": height, "fps": fps,
            "duration": dur, "opts": opts, "renderer": RENDERER_VERSION, "path": str(out)}
    if out.is_file() and out.stat().st_size > 0:
        return {**meta, "cached": True, "frames": round(dur * fps)}

    rate = _rate(fps)
    frames = max(1, round(dur * float(rate)))
    tmp = out.with_name(out.stem + ".part.mov")
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
           "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{width}x{height}", "-r", f"{rate.numerator}/{rate.denominator}", "-i", "-",
           "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16",
           "-vendor", "apl0", "-f", "mov", str(tmp)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for i in range(frames):
            if cancel is not None and cancel.is_set():
                raise RenderError("cancelled")
            fr = Frame(width, height)
            tpl.draw(fr, ctx, i / float(rate), dur, vals)
            assert proc.stdin is not None
            proc.stdin.write(fr.to_rgba8().tobytes())
            if progress and i % 5 == 0:
                progress(i / frames)
        assert proc.stdin is not None
        proc.stdin.close()
        err = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
        if proc.wait(timeout=120) != 0:
            raise RenderError(f"ffmpeg failed: {err.strip()[-300:]}")
    except BaseException:
        proc.kill()
        tmp.unlink(missing_ok=True)
        raise
    tmp.replace(out)
    sidecar.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return {**meta, "cached": False, "frames": frames}
