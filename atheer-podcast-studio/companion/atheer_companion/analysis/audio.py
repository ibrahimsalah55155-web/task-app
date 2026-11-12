"""Audio decoding with a disk cache, and timeline assembly.

Every file is decoded once by FFmpeg to 16 kHz mono int16 and cached as .npy
(memory-mapped on reuse), keyed by path + size + mtime. Long podcasts stay
cheap: 2 hours = 230 MB on disk, read lazily.

A "piece" describes how a file is used on the sequence:
  {path, srcIn: seconds into the file, seqStart: seconds on the sequence, dur: seconds}
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np

SR = 16000


class AudioError(RuntimeError):
    pass


@dataclass
class Piece:
    path: str
    src_in: float
    seq_start: float
    dur: float

    @staticmethod
    def from_json(d: dict[str, Any]) -> "Piece":
        return Piece(str(d["path"]), float(d.get("srcIn", 0)), float(d.get("seqStart", 0)), float(d["dur"]))


class AudioCache:
    def __init__(self, ffmpeg: str | None, cache_dir: Path) -> None:
        self.ffmpeg = ffmpeg
        self.dir = cache_dir
        self.dir.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def _key(self, path: str) -> str:
        st = os.stat(path)
        raw = f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime_ns}|{SR}"
        return hashlib.sha1(raw.encode()).hexdigest()[:20]

    def load(self, path: str, cancel: threading.Event | None = None) -> np.ndarray:
        """Whole file as int16 at 16 kHz mono (memory-mapped)."""
        if not self.ffmpeg:
            raise AudioError("ffmpeg not found")
        if not Path(path).is_file():
            raise AudioError(f"File not found or drive disconnected: {path}")
        key = self._key(path)
        out = self.dir / f"{key}.npy"
        with self._guard:
            lock = self._locks.setdefault(key, threading.Lock())
        with lock:
            if not out.is_file():
                tmp = out.with_suffix(".part")
                cmd = [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", path, "-vn",
                       "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"]
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                chunks = []
                assert proc.stdout is not None
                while True:
                    if cancel is not None and cancel.is_set():
                        proc.kill()
                        raise AudioError("cancelled")
                    b = proc.stdout.read(1 << 20)
                    if not b:
                        break
                    chunks.append(b)
                err = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
                if proc.wait() != 0:
                    raise AudioError(f"cannot decode audio of {Path(path).name}: {err.strip()[-200:]}")
                data = np.frombuffer(b"".join(chunks), dtype=np.int16)
                if data.size == 0:
                    raise AudioError(f"{Path(path).name} has no audio stream")
                np.save(tmp, data)
                os.replace(str(tmp) + ".npy" if not str(tmp).endswith(".npy") else tmp, out)
        return np.load(out, mmap_mode="r")

    def float_range(self, path: str, start: float, dur: float, cancel: threading.Event | None = None) -> np.ndarray:
        data = self.load(path, cancel)
        a = max(0, int(round(start * SR)))
        b = max(a, int(round((start + dur) * SR)))
        seg = np.asarray(data[a:b], dtype=np.float32) / 32768.0
        want = b - a
        if seg.size < want:  # file shorter than the piece: pad with silence
            seg = np.pad(seg, (0, want - seg.size))
        return seg

    def timeline(self, pieces: Iterable[Piece], total: float | None = None,
                 cancel: threading.Event | None = None) -> np.ndarray:
        """One track's audio laid out on the sequence time axis (float32, 16 kHz)."""
        pieces = list(pieces)
        end = total if total is not None else max((p.seq_start + p.dur for p in pieces), default=0.0)
        out = np.zeros(int(round(end * SR)) + 1, dtype=np.float32)
        for p in pieces:
            seg = self.float_range(p.path, p.src_in, p.dur, cancel)
            a = int(round(p.seq_start * SR))
            n = min(seg.size, out.size - a)
            if n > 0:
                out[a:a + n] += seg[:n]
        return out


def frame_rms(x: np.ndarray, hop: int = 160, win: int = 400) -> np.ndarray:
    """RMS in dBFS per 10 ms hop (100 values per second)."""
    if x.size < win:
        x = np.pad(x, (0, win - x.size))
    n = 1 + (x.size - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    # Stride without copying huge arrays for long files: process in blocks.
    out = np.empty(n, dtype=np.float32)
    block = 20000
    for i in range(0, n, block):
        sl = idx[i:i + block]
        e = np.sqrt(np.mean(x[sl] ** 2, axis=1) + 1e-12)
        out[i:i + block] = 20 * np.log10(e)
    return out
