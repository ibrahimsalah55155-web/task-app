"""Voice activity: Silero VAD (bundled ONNX, MIT) with an energy fallback.

Output is a speech probability per 32 ms window (31.25 values per second),
resampled to 100 Hz so every analysis shares the same 10 ms grid.
"""

from __future__ import annotations

import logging
import threading
from functools import lru_cache
from pathlib import Path

import numpy as np

from .audio import SR, frame_rms

log = logging.getLogger("atheer.vad")
MODEL = Path(__file__).resolve().parent / "models" / "silero_vad_16k_op15.onnx"
CHUNK = 512
CONTEXT = 64
RATE = 100  # analysis frames per second


@lru_cache(maxsize=1)
def _session():
    try:
        import onnxruntime as ort
    except ImportError:
        return None
    if not MODEL.is_file():
        return None
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    opts.inter_op_num_threads = 1
    return ort.InferenceSession(str(MODEL), sess_options=opts, providers=["CPUExecutionProvider"])


def silero_available() -> bool:
    return _session() is not None


def speech_prob(x: np.ndarray, cancel: threading.Event | None = None) -> np.ndarray:
    """Speech probability at 100 Hz for a 16 kHz float signal."""
    n100 = int(np.ceil(x.size / SR * RATE))
    sess = _session()
    if sess is None:
        log.warning("Silero VAD unavailable; using the energy detector")
        return energy_prob(x)[:n100]
    pad = (-x.size) % CHUNK
    xs = np.pad(x, (0, pad)).astype(np.float32)
    n = xs.size // CHUNK
    state = np.zeros((2, 1, 128), dtype=np.float32)
    context = np.zeros((1, CONTEXT), dtype=np.float32)
    sr = np.array(SR, dtype=np.int64)
    probs = np.empty(n, dtype=np.float32)
    for i in range(n):
        if cancel is not None and i % 2000 == 0 and cancel.is_set():
            raise RuntimeError("cancelled")
        chunk = xs[i * CHUNK:(i + 1) * CHUNK][None, :]
        inp = np.concatenate([context, chunk], axis=1)
        out, state = sess.run(None, {"input": inp, "state": state, "sr": sr})
        probs[i] = out[0, 0]
        context = inp[:, -CONTEXT:]
    # resample 31.25 Hz -> 100 Hz (nearest previous window)
    t = np.arange(n100) / RATE
    idx = np.minimum((t * SR / CHUNK).astype(int), n - 1)
    return probs[idx]


def energy_prob(x: np.ndarray) -> np.ndarray:
    """Fallback: a soft speech score from loudness above the noise floor."""
    db = frame_rms(x)
    floor = np.percentile(db, 10)
    return np.clip((db - floor - 6) / 12, 0, 1).astype(np.float32)


def smooth(mask: np.ndarray, fill_gaps: int, min_run: int) -> np.ndarray:
    """Fill short False gaps, then drop True runs shorter than min_run (frames)."""
    m = mask.astype(bool).copy()
    for value, limit in ((False, fill_gaps), (True, min_run)):
        if limit <= 0:
            continue
        i = 0
        n = m.size
        while i < n:
            if m[i] == value:
                j = i
                while j < n and m[j] == value:
                    j += 1
                # don't touch runs at the edges for gap filling
                if j - i < limit and not (value is False and (i == 0 or j == n)):
                    m[i:j] = not value
                i = j
            else:
                i += 1
    return m


def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) frame index pairs of True runs."""
    m = np.concatenate([[False], mask.astype(bool), [False]])
    d = np.diff(m.astype(np.int8))
    starts = np.where(d == 1)[0]
    ends = np.where(d == -1)[0]
    return list(zip(starts.tolist(), ends.tolist()))
