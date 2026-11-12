"""Where the face is: horizontal framing for vertical reels.

Frames are sampled with FFmpeg (2 per second, small), faces found with the
OpenCV Haar cascade that ships inside opencv-python (no download). The median
face centre of each range is returned as a fraction of the frame width.
"""

from __future__ import annotations

import subprocess
import threading
from typing import Any

import numpy as np


def _cascade():
    import cv2

    return cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")


def face_centres(ffmpeg: str, path: str, ranges: list[tuple[float, float]], width: int = 480,
                 fps: float = 2.0, cancel: threading.Event | None = None) -> list[dict[str, Any]]:
    import cv2

    cascade = _cascade()
    out = []
    for a, b in ranges:
        if cancel is not None and cancel.is_set():
            raise RuntimeError("cancelled")
        dur = max(0.2, b - a)
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", f"{a:.3f}", "-t", f"{dur:.3f}", "-i", path,
               "-vf", f"fps={fps},scale={width}:-2", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
        probe = subprocess.run([ffmpeg.replace("ffmpeg", "ffprobe"), "-v", "error", "-select_streams", "v:0",
                                "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
                               capture_output=True, text=True)
        try:
            sw, sh = (int(v) for v in probe.stdout.strip().split(",")[:2])
        except ValueError:
            out.append({"start": a, "end": b, "x": None, "y": None, "faces": 0})
            continue
        h = int(round(sh * width / sw / 2) * 2)
        raw = subprocess.run(cmd, capture_output=True).stdout
        n = len(raw) // (width * h)
        xs, ys, sizes = [], [], []
        for i in range(n):
            img = np.frombuffer(raw[i * width * h:(i + 1) * width * h], np.uint8).reshape(h, width)
            found = cascade.detectMultiScale(img, scaleFactor=1.1, minNeighbors=5, minSize=(width // 20, width // 20))
            if len(found):
                x, y, w, hh = max(found, key=lambda r: r[2] * r[3])  # the biggest face = the person on camera
                xs.append((x + w / 2) / width)
                ys.append((y + hh / 2) / h)
                sizes.append(w / width)
        out.append({"start": a, "end": b, "faces": len(xs),
                    "x": float(np.median(xs)) if xs else None, "y": float(np.median(ys)) if ys else None,
                    "size": float(np.median(sizes)) if sizes else None})
    return out
