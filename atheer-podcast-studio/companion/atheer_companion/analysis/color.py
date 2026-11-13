"""Camera colour matching.

Measures what each camera looks like (exposure, contrast, white balance,
saturation) from frames sampled across the shoot, in CIE Lab, ignoring
clipped highlights and crushed blacks. Two ways to use the result:

* Lumetri in Premiere (closed loop): the panel sets Lumetri Basic Correction on
  the camera's master clip, exports one frame through Premiere, and asks
  `compare()` how far that frame still is from the reference camera. It
  repeats until the error is small. Lumetri's own scales never have to be
  guessed: they are measured on the real footage.
* A .cube 3D LUT per camera (Reinhard transfer in Lab), for Lumetri's
  Input LUT or any other app.
"""

from __future__ import annotations

import subprocess
import threading
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

STAT_KEYS = ("L", "Lstd", "a", "b", "chroma")


class ColorError(RuntimeError):
    pass


# ---- colour science (sRGB / Rec.709 display-referred, D65) ----------------------------

_M = np.array([[0.4124564, 0.3575761, 0.1804375],
               [0.2126729, 0.7151522, 0.0721750],
               [0.0193339, 0.1191920, 0.9503041]])
_MI = np.linalg.inv(_M)
_WHITE = np.array([0.95047, 1.0, 1.08883])


def _lin(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _gam(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    xyz = _lin(rgb) @ _M.T / _WHITE
    e = 216 / 24389
    f = np.where(xyz > e, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def lab_to_rgb(lab: np.ndarray) -> np.ndarray:
    fy = (lab[..., 0] + 16) / 116
    fx = fy + lab[..., 1] / 500
    fz = fy - lab[..., 2] / 200
    e = 6 / 29
    f = np.stack([fx, fy, fz], -1)
    xyz = np.where(f > e, f ** 3, 3 * e * e * (f - 4 / 29)) * _WHITE
    return _gam(xyz @ _MI.T)


# ---- measuring ----------------------------------------------------------------------------

def stats_from_rgb(rgb: np.ndarray) -> dict[str, float]:
    """rgb: (..., 3) floats 0..1. Clipped/crushed pixels are ignored."""
    px = rgb.reshape(-1, 3)
    ok = (px.max(1) < 0.985) & (px.max(1) > 0.02)
    if ok.mean() < 0.05:
        ok = np.ones(len(px), bool)
    lab = rgb_to_lab(px[ok])
    return {"L": float(lab[:, 0].mean()), "Lstd": float(lab[:, 0].std()), "a": float(lab[:, 1].mean()),
            "b": float(lab[:, 2].mean()), "chroma": float(np.hypot(lab[:, 1], lab[:, 2]).mean()),
            "_mu": lab.mean(0).tolist(), "_sd": lab.std(0).tolist()}


def read_frames(ffmpeg: str, path: str, times: list[float], width: int = 256,
                cancel: threading.Event | None = None) -> np.ndarray:
    if not Path(path).is_file():
        raise ColorError(f"File not found or drive disconnected: {path}")
    frames = []
    for t in times:
        if cancel is not None and cancel.is_set():
            raise ColorError("cancelled")
        r = subprocess.run([ffmpeg, "-v", "error", "-ss", f"{max(0.0, t):.3f}", "-i", path, "-frames:v", "1",
                            "-vf", f"scale={width}:-2:flags=area,format=rgb24", "-f", "rawvideo", "-"],
                           capture_output=True, check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if not r.stdout:
            continue
        n = len(r.stdout) // 3
        h = n // width
        frames.append(np.frombuffer(r.stdout[: width * h * 3], np.uint8).reshape(h, width, 3))
    if not frames:
        raise ColorError(f"Could not read frames from {path}")
    return np.concatenate([f.reshape(-1, 3) for f in frames]).astype(np.float32) / 255.0


def measure(ffmpeg: str, cameras: list[dict[str, Any]], reference: str,
            progress=None, cancel: threading.Event | None = None) -> dict[str, Any]:
    """cameras: [{id, path, times[]}] -> stats per camera + the corrections that match each to `reference`."""
    prog = progress or (lambda f, m: None)
    out: dict[str, Any] = {}
    for i, cam in enumerate(cameras):
        prog(i / max(1, len(cameras)), f"Reading {Path(cam['path']).name}")
        out[cam["id"]] = stats_from_rgb(read_frames(ffmpeg, cam["path"], cam["times"], cancel=cancel))
    if reference not in out:
        raise ColorError("reference camera not measured")
    ref = out[reference]
    return {"reference": reference, "stats": out,
            "delta": {k: diff(v, ref) for k, v in out.items()}}


def diff(cur: dict[str, float], target: dict[str, float]) -> dict[str, float]:
    """What still separates `cur` from `target` (target minus current)."""
    return {"L": target["L"] - cur["L"], "Lstd": target["Lstd"] - cur["Lstd"], "a": target["a"] - cur["a"],
            "b": target["b"] - cur["b"], "chroma": target["chroma"] - cur["chroma"],
            "error": float(np.sqrt((target["L"] - cur["L"]) ** 2 + (target["a"] - cur["a"]) ** 2
                                   + (target["b"] - cur["b"]) ** 2))}


def compare_image(path: str, target: dict[str, float], crop: tuple[float, float, float, float] | None = None) -> dict[str, Any]:
    """Stats of a frame Premiere exported (PNG/JPG/TIFF) and its distance from the target camera."""
    if not Path(path).is_file():
        raise ColorError(f"Frame not found: {path}")
    im = Image.open(path).convert("RGB")
    im.thumbnail((512, 512))
    rgb = np.asarray(im).astype(np.float32) / 255.0
    if crop:
        h, w = rgb.shape[:2]
        x0, y0, x1, y1 = crop
        rgb = rgb[int(y0 * h):max(int(y0 * h) + 1, int(y1 * h)), int(x0 * w):max(int(x0 * w) + 1, int(x1 * w))]
    st = stats_from_rgb(rgb)
    return {"stats": st, "delta": diff(st, target)}


# ---- LUT --------------------------------------------------------------------------------

def match_lut(src: dict[str, Any], ref: dict[str, Any], size: int = 33, strength: float = 1.0) -> np.ndarray:
    """(size, size, size, 3) RGB LUT indexed [b, g, r] that moves `src` statistics onto `ref` (Reinhard, Lab)."""
    g = np.linspace(0, 1, size)
    b, gg, r = np.meshgrid(g, g, g, indexing="ij")
    rgb = np.stack([r, gg, b], -1)
    lab = rgb_to_lab(rgb)
    mu_s, sd_s = np.array(src["_mu"]), np.maximum(np.array(src["_sd"]), 1e-3)
    mu_r, sd_r = np.array(ref["_mu"]), np.maximum(np.array(ref["_sd"]), 1e-3)
    scale = np.clip(sd_r / sd_s, 0.6, 1.6)
    moved = (lab - mu_s) * scale + mu_r
    out = lab_to_rgb(lab + strength * (moved - lab))
    return np.clip(out, 0, 1)


def write_cube(lut: np.ndarray, path: Path, title: str) -> None:
    size = lut.shape[0]
    lines = [f'TITLE "{title}"', f"LUT_3D_SIZE {size}", "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"]
    # .cube order: red changes fastest, then green, then blue -> our [b, g, r] indexing flattened.
    for v in lut.reshape(-1, 3):
        lines.append(f"{v[0]:.6f} {v[1]:.6f} {v[2]:.6f}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="ascii")


def apply_lut(rgb: np.ndarray, lut: np.ndarray) -> np.ndarray:
    """Trilinear lookup (used by tests and previews)."""
    size = lut.shape[0]
    p = np.clip(rgb, 0, 1) * (size - 1)
    i0 = np.floor(p).astype(int)
    i1 = np.minimum(i0 + 1, size - 1)
    f = p - i0
    out = np.zeros_like(rgb)
    for dr in (0, 1):
        for dg in (0, 1):
            for db in (0, 1):
                ir = i1[..., 0] if dr else i0[..., 0]
                ig = i1[..., 1] if dg else i0[..., 1]
                ib = i1[..., 2] if db else i0[..., 2]
                w = ((f[..., 0] if dr else 1 - f[..., 0]) * (f[..., 1] if dg else 1 - f[..., 1])
                     * (f[..., 2] if db else 1 - f[..., 2]))
                out += w[..., None] * lut[ib, ig, ir]
    return out


def write_luts(result: dict[str, Any], out_dir: str, strength: float = 1.0) -> dict[str, str]:
    ref = result["stats"][result["reference"]]
    paths = {}
    for cam, st in result["stats"].items():
        if cam == result["reference"]:
            continue
        p = Path(out_dir) / f"MAG_match_{cam}_to_{result['reference']}.cube"
        write_cube(match_lut(st, ref, strength=strength), p, f"MAG match {cam} -> {result['reference']}")
        paths[cam] = str(p)
    return paths
