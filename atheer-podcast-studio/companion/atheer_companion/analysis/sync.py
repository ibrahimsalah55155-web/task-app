"""Multicamera / multi-recorder synchronisation.

For every file, find where it starts on the reference recording's clock:

  1. coarse: cross-correlate loudness-change envelopes at 100 Hz over the whole
     recordings (cheap even for hours of audio);
  2. fine: sample-accurate correlation of 16 kHz audio in a window around the
     coarse lag, with parabolic sub-sample refinement;
  3. drift: repeat the fine step at several points along the overlap and fit a
     line; the slope is the clock drift in parts per million;
  4. timecode: when both files carry timecode, the timecode offset is compared
     with the audio offset; agreement within one frame raises confidence, and a
     file with no usable audio falls back to timecode.

Nothing is guessed silently: every result carries a confidence level and the
reasons behind it.
"""

from __future__ import annotations

import math
import threading
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np
from scipy.signal import fftconvolve

from .audio import SR, AudioCache, AudioError

ENV_RATE = 100
FINE_WIN = 8.0  # seconds of target audio per fine window
FINE_SEARCH = 0.25  # seconds either side of the coarse lag


@dataclass
class SyncFile:
    path: str
    role: str  # guest_cam | host_cam | wide_cam | guest_mic | host_mic | extra
    timecode: str | None = None
    fps: float | None = None
    duration: float | None = None
    has_audio: bool = True


@dataclass
class SyncResult:
    path: str
    role: str
    offset: float | None  # seconds: file time 0 is at this time on the reference clock
    method: str  # reference | audio | audio+timecode | timecode | manual
    confidence: str  # high | medium | low | none
    score: float
    drift_ppm: float | None = None
    drift_frames: float | None = None
    warnings: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {"path": self.path, "role": self.role, "offset": None if self.offset is None else round(self.offset, 5),
                "method": self.method, "confidence": self.confidence, "score": round(self.score, 2),
                "driftPpm": None if self.drift_ppm is None else round(self.drift_ppm, 1),
                "driftFrames": None if self.drift_frames is None else round(self.drift_frames, 2),
                "warnings": self.warnings}


def envelope(x: np.ndarray) -> np.ndarray:
    """Loudness-change envelope at 100 Hz: log energy minus its 1 s moving average."""
    hop = SR // ENV_RATE
    n = x.size // hop
    if n < 10:
        return np.zeros(max(n, 1), np.float32)
    e = np.sqrt(np.mean(x[: n * hop].reshape(n, hop) ** 2, axis=1) + 1e-9)
    le = np.log(e)
    k = ENV_RATE
    ma = np.convolve(le, np.ones(k) / k, mode="same")
    d = le - ma
    d = np.clip(d, -3, 3)
    d -= d.mean()
    s = d.std()
    return (d / s if s > 0 else d).astype(np.float32)


def xcorr_lag(ref: np.ndarray, tgt: np.ndarray) -> tuple[np.ndarray, int]:
    """Full cross-correlation c[k] = sum ref[n + lag] * tgt[n]; returns (c, zero_index)."""
    c = fftconvolve(ref, tgt[::-1], mode="full")
    return c, tgt.size - 1


def peak_stats(c: np.ndarray, exclude: int) -> tuple[int, float, float]:
    i = int(np.argmax(c))
    peak = float(c[i])
    mask = np.ones(c.size, bool)
    mask[max(0, i - exclude): i + exclude + 1] = False
    rest = c[mask]
    if rest.size == 0:
        return i, float("inf"), float("inf")
    z = (peak - float(rest.mean())) / (float(rest.std()) + 1e-9)
    second = float(rest.max())
    ratio = peak / second if second > 0 else float("inf")
    return i, z, ratio


def tc_seconds(tc: str | None, fps: float | None) -> float | None:
    if not tc or not fps:
        return None
    parts = tc.replace(";", ":").replace(".", ":").split(":")
    if len(parts) != 4:
        return None
    h, m, s, f = (int(p) for p in parts)
    nominal = round(fps)
    frames = ((h * 60 + m) * 60 + s) * nominal + f
    if ";" in tc and nominal in (30, 60):  # drop-frame
        drop = 2 if nominal == 30 else 4
        total_min = h * 60 + m
        frames -= drop * (total_min - total_min // 10)
    return frames / fps


def fine_lag(ref: np.ndarray, tgt: np.ndarray, coarse: float, t0: float, win: float = FINE_WIN) -> tuple[float, float] | None:
    """Refine the lag using target window [t0, t0+win). Returns (lag_seconds, normalised peak)."""
    a = int(round(t0 * SR))
    b = a + int(round(win * SR))
    if a < 0 or b > tgt.size:
        return None
    seg = tgt[a:b]
    if np.std(seg) < 1e-4:
        return None
    ra = int(round((t0 + coarse - FINE_SEARCH) * SR))
    rb = int(round((t0 + coarse + win + FINE_SEARCH) * SR))
    if ra < 0 or rb > ref.size:
        return None
    rseg = ref[ra:rb]
    c = fftconvolve(rseg, seg[::-1], mode="valid")  # c[k]: rseg[k:k+len] vs seg
    k = int(np.argmax(c))
    # parabolic interpolation
    if 0 < k < c.size - 1:
        y0, y1, y2 = c[k - 1], c[k], c[k + 1]
        den = y0 - 2 * y1 + y2
        frac = 0.5 * (y0 - y2) / den if den != 0 else 0.0
    else:
        frac = 0.0
    norm = float(c[k] / (np.linalg.norm(seg) * np.linalg.norm(rseg[k:k + seg.size]) + 1e-9))
    lag = (ra + k + frac) / SR - t0
    return lag, norm


def sync_files(files: list[SyncFile], cache: AudioCache, reference: str | None = None,
               progress: Callable[[float, str], None] | None = None,
               cancel: threading.Event | None = None) -> dict[str, Any]:
    if not files:
        raise ValueError("no files")
    prog = progress or (lambda f, m: None)
    order = ["guest_mic", "host_mic", "wide_cam", "host_cam", "guest_cam", "extra"]
    audio_files = [f for f in files if f.has_audio]
    if reference:
        ref_file = next((f for f in files if f.path == reference), None)
    else:
        ref_file = min(audio_files, key=lambda f: order.index(f.role) if f.role in order else 99) if audio_files else None
    if ref_file is None or not ref_file.has_audio:
        raise ValueError("No file with audio to use as the sync reference")

    prog(0.02, f"Reading {ref_file.path.split('/')[-1].split(chr(92))[-1]}")
    ref = np.asarray(cache.float_range(ref_file.path, 0, (cache.load(ref_file.path, cancel).size) / SR, cancel))
    ref_env = envelope(ref)
    ref_tc = tc_seconds(ref_file.timecode, ref_file.fps)
    results: list[SyncResult] = [SyncResult(ref_file.path, ref_file.role, 0.0, "reference", "high", 100.0)]

    others = [f for f in files if f is not ref_file]
    for n, f in enumerate(others):
        if cancel is not None and cancel.is_set():
            raise RuntimeError("cancelled")
        prog(0.05 + 0.9 * n / max(1, len(others)), f"Matching {f.path.replace(chr(92), '/').split('/')[-1]}")
        tc = tc_seconds(f.timecode, f.fps)
        tc_offset = (tc - ref_tc) if (tc is not None and ref_tc is not None) else None
        frame = 1 / (f.fps or 25)
        if not f.has_audio:
            if tc_offset is not None:
                results.append(SyncResult(f.path, f.role, tc_offset, "timecode", "medium", 50.0,
                                          warnings=["No audio: synced by timecode only. Check visually."]))
            else:
                results.append(SyncResult(f.path, f.role, None, "manual", "none", 0.0,
                                          warnings=["No audio and no timecode: set the offset by hand."]))
            continue
        try:
            tgt = np.asarray(cache.float_range(f.path, 0, cache.load(f.path, cancel).size / SR, cancel))
        except AudioError as e:
            results.append(SyncResult(f.path, f.role, tc_offset, "timecode" if tc_offset is not None else "manual",
                                      "medium" if tc_offset is not None else "none", 0.0, warnings=[str(e)]))
            continue
        env = envelope(tgt)
        c, zero = xcorr_lag(ref_env, env)
        i, z, ratio = peak_stats(c, exclude=ENV_RATE // 2)
        coarse = (i - zero) / ENV_RATE

        # fine refinement at several points along the overlap
        ov_start = max(0.0, -coarse)
        ov_end = min(tgt.size / SR, ref.size / SR - coarse)
        overlap = ov_end - ov_start
        lags: list[tuple[float, float, float]] = []  # (t_center, lag, norm)
        if overlap > FINE_WIN + 2 * FINE_SEARCH:
            points = 7 if overlap > 120 else 3
            for k in range(points):
                t0 = ov_start + FINE_SEARCH + (overlap - FINE_WIN - 2 * FINE_SEARCH) * (k / max(1, points - 1))
                r = fine_lag(ref, tgt, coarse, t0)
                if r and r[1] > 0.2:
                    lags.append((t0 + FINE_WIN / 2, r[0], r[1]))
        warnings: list[str] = []
        drift_ppm = drift_frames = None
        if lags:
            ts = np.array([x[0] for x in lags])
            ls = np.array([x[1] for x in lags])
            if len(lags) >= 3 and np.ptp(ts) > 30:
                slope, intercept = np.polyfit(ts, ls, 1)
                drift_ppm = float(slope * 1e6)
                offset = float(intercept)  # lag at target time 0
                drift_frames = abs(slope) * (tgt.size / SR) / frame
                resid = np.abs(ls - (slope * ts + intercept)).max()
                if resid > frame / 2:
                    warnings.append("Offsets along the file are inconsistent: possible edit, gap or VFR in this file.")
                if drift_frames > 1:
                    warnings.append(f"Clock drift of {drift_ppm:.0f} ppm: {drift_frames:.1f} frames out of sync by the end.")
            else:
                offset = float(np.median(ls))
            mean_norm = float(np.mean([x[2] for x in lags]))
        else:
            offset = coarse
            mean_norm = 0.0
            warnings.append("Only a coarse match was possible (short overlap or very quiet audio).")

        if z >= 12 and ratio >= 1.4 and mean_norm >= 0.35:
            conf = "high"
        elif z >= 7 and ratio >= 1.15:
            conf = "medium"
        else:
            conf = "low"
        method = "audio"
        if tc_offset is not None:
            if abs(tc_offset - offset) <= frame:
                method = "audio+timecode"
                conf = "high" if conf != "low" else "medium"
            elif conf == "low":
                method = "timecode"
                offset = tc_offset
                warnings.append("Audio match is weak; using timecode.")
            else:
                warnings.append(f"Timecode disagrees with the audio by {abs(tc_offset - offset):.2f} s; the audio is used.")
        if conf == "low":
            warnings.append("Low confidence: check this file's sync before building.")
        score = float(min(100.0, z * 4 + mean_norm * 40))
        results.append(SyncResult(f.path, f.role, offset, method, conf, score, drift_ppm, drift_frames, warnings))

    known = [r.offset for r in results if r.offset is not None]
    origin = min(known) if known else 0.0
    prog(1.0, "Done")
    return {
        "reference": ref_file.path,
        "results": [{**r.to_json(), "seqStart": None if r.offset is None else round(r.offset - origin, 5)} for r in results],
        "sequenceOrigin": origin,
    }


def frames_to_seconds(frames: int, fps: float) -> float:
    return frames / fps if fps else math.nan
