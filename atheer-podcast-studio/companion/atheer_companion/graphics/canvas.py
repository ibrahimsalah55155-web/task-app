"""Small compositing toolkit: premultiplied RGBA float32 frames, anti-aliased shapes.

Everything is drawn into a sub-rectangle of the frame so a 1080x1920 frame
with a few elements stays fast in pure numpy.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageFilter


def hex_rgb(h: str) -> tuple[float, float, float]:
    h = h.lstrip("#")
    return tuple(int(h[i: i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]


# ---- easing -------------------------------------------------------------------

def clamp01(x: float) -> float:
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def progress(t: float, start: float, dur: float) -> float:
    return clamp01((t - start) / dur) if dur > 0 else float(t >= start)


def ease_out_cubic(x: float) -> float:
    return 1 - (1 - x) ** 3


def ease_out_quint(x: float) -> float:
    return 1 - (1 - x) ** 5


def ease_in_cubic(x: float) -> float:
    return x ** 3


def ease_in_out_cubic(x: float) -> float:
    return 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def ease_out_back(x: float, k: float = 1.70158) -> float:
    c3 = k + 1
    return 1 + c3 * (x - 1) ** 3 + k * (x - 1) ** 2


# ---- frame -------------------------------------------------------------------

class Frame:
    """Premultiplied RGBA, float32, shape (H, W, 4)."""

    def __init__(self, width: int, height: int) -> None:
        self.w = width
        self.h = height
        self.px = np.zeros((height, width, 4), dtype=np.float32)

    def paint(self, mask: np.ndarray, x: int, y: int, rgb: tuple[float, float, float], opacity: float = 1.0) -> None:
        """Composite a solid colour through an alpha mask placed at (x, y)."""
        if opacity <= 0:
            return
        mh, mw = mask.shape
        xa, ya = max(0, x), max(0, y)
        xb, yb = min(self.w, x + mw), min(self.h, y + mh)
        if xb <= xa or yb <= ya:
            return
        a = mask[ya - y: yb - y, xa - x: xb - x] * opacity
        dst = self.px[ya:yb, xa:xb]
        inv = 1 - a
        for c in range(3):
            dst[..., c] = rgb[c] * a + dst[..., c] * inv
        dst[..., 3] = a + dst[..., 3] * inv

    def paint_rgba(self, rgba: np.ndarray, x: int, y: int, opacity: float = 1.0) -> None:
        """Composite a premultiplied RGBA image placed at (x, y)."""
        if opacity <= 0:
            return
        mh, mw = rgba.shape[:2]
        xa, ya = max(0, x), max(0, y)
        xb, yb = min(self.w, x + mw), min(self.h, y + mh)
        if xb <= xa or yb <= ya:
            return
        src = rgba[ya - y: yb - y, xa - x: xb - x] * opacity
        dst = self.px[ya:yb, xa:xb]
        dst *= (1 - src[..., 3:4])
        dst += src

    def to_rgba8(self) -> np.ndarray:
        """Straight (un-premultiplied) 8-bit RGBA, as video encoders expect."""
        a = self.px[..., 3:4]
        rgb = np.divide(self.px[..., :3], a, out=np.zeros_like(self.px[..., :3]), where=a > 1e-6)
        out = np.concatenate([rgb, a], axis=2)
        return (np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8)


# ---- shapes (signed-distance anti-aliasing) ----------------------------------

def rounded_rect_mask(w: float, h: float, r: float) -> tuple[np.ndarray, int, int]:
    """Mask of a w x h rounded rectangle; returns (mask, ox, oy) offsets for sub-pixel padding."""
    W, H = int(math.ceil(w)) + 2, int(math.ceil(h)) + 2
    if W <= 2 or H <= 2:
        return np.zeros((1, 1), np.float32), 0, 0
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    cx, cy = (W - 1) / 2, (H - 1) / 2
    r = min(r, w / 2, h / 2)
    qx = np.abs(xx - cx) - (w / 2 - r)
    qy = np.abs(yy - cy) - (h / 2 - r)
    outside = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0))
    inside = np.minimum(np.maximum(qx, qy), 0)
    sdf = outside + inside - r
    return np.clip(0.5 - sdf, 0, 1).astype(np.float32), 1, 1


def circle_mask(radius: float) -> np.ndarray:
    n = int(math.ceil(radius * 2)) + 2
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    c = (n - 1) / 2
    d = np.hypot(xx - c, yy - c) - radius
    return np.clip(0.5 - d, 0, 1).astype(np.float32)


def blur(mask: np.ndarray, radius: float) -> np.ndarray:
    if radius <= 0:
        return mask
    pad = int(radius * 3)
    padded = np.pad(mask, pad)
    img = Image.fromarray((padded * 255).astype(np.uint8))
    img = img.filter(ImageFilter.GaussianBlur(radius))
    return np.asarray(img, dtype=np.float32) / 255


def horizontal_ramp(width: int, height: int, edge: float, soft: float, keep_right: bool) -> np.ndarray:
    """1 on one side of x=edge, 0 on the other, with a soft transition."""
    xs = np.arange(width, dtype=np.float32)
    v = (xs - edge) / max(soft, 1e-3) + 0.5
    v = np.clip(v if keep_right else 1 - v, 0, 1)
    return np.broadcast_to(v, (height, width))


def load_logo(path: str, size: int) -> np.ndarray | None:
    """User logo (PNG/JPG) fitted into a size x size square, premultiplied RGBA."""
    try:
        img = Image.open(path).convert("RGBA")
    except Exception:  # noqa: BLE001
        return None
    img.thumbnail((size, size), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(img, ((size - img.width) // 2, (size - img.height) // 2), img)
    arr = np.asarray(canvas, dtype=np.float32) / 255
    arr[..., :3] *= arr[..., 3:4]
    return arr


@dataclass
class Box:
    x: float
    y: float
    w: float
    h: float
