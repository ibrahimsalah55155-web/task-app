"""Silence detection and speaker-based camera decisions on a 10 ms grid.

Both work on the SEQUENCE timeline: each microphone track is assembled from
its pieces (audio.AudioCache.timeline), analysed with Silero VAD + loudness,
and decisions are returned in sequence seconds, ready for the cut engine.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any, Callable

import numpy as np
from scipy.ndimage import median_filter

from .audio import AudioCache, Piece, frame_rms
from .vad import RATE, runs, smooth, speech_prob


@dataclass
class TrackSignal:
    name: str
    prob: np.ndarray  # speech probability, 100 Hz
    db: np.ndarray  # loudness dBFS, 100 Hz
    floor: float  # noise floor dBFS


def analyse_tracks(cache: AudioCache, tracks: list[dict[str, Any]], total: float,
                   progress: Callable[[float, str], None] | None = None,
                   cancel: threading.Event | None = None) -> list[TrackSignal]:
    out = []
    n = int(round(total * RATE))
    for i, tr in enumerate(tracks):
        if progress:
            progress(0.05 + 0.75 * i / max(1, len(tracks)), f"Listening to {tr.get('name', 'track')}")
        pieces = [Piece.from_json(p) for p in tr["pieces"]]
        x = cache.timeline(pieces, total, cancel)
        prob = speech_prob(x, cancel)
        db = frame_rms(x)
        prob = np.pad(prob, (0, max(0, n - prob.size)))[:n]
        db = np.pad(db, (0, max(0, n - db.size)), constant_values=-120)[:n]
        audible = db[db > -90]
        floor = float(np.percentile(audible, 10)) if audible.size else -90.0
        out.append(TrackSignal(str(tr.get("name", f"track{i}")), prob, db, floor))
    return out


# ---- silence --------------------------------------------------------------------

PRESETS: dict[str, dict[str, float]] = {
    "conservative": {"minSilence": 1.2, "padBefore": 0.20, "padAfter": 0.30, "keepPause": 0.50, "threshold": 0.40},
    "balanced": {"minSilence": 0.70, "padBefore": 0.12, "padAfter": 0.20, "keepPause": 0.30, "threshold": 0.50},
    "aggressive": {"minSilence": 0.40, "padBefore": 0.08, "padAfter": 0.12, "keepPause": 0.15, "threshold": 0.60},
}


def detect_silences(signals: list[TrackSignal], params: dict[str, Any]) -> dict[str, Any]:
    p = {**PRESETS["balanced"], **PRESETS.get(str(params.get("preset", "balanced")), {}),
         **{k: float(v) for k, v in params.items() if k in PRESETS["balanced"] and v is not None}}
    keep_breath = bool(params.get("preserveBreath", False))
    keep_laughter = bool(params.get("preserveLaughter", True))
    if not signals:
        raise ValueError("no audio tracks to analyse")
    n = min(s.prob.size for s in signals)
    speech = np.zeros(n, bool)
    sounds = np.zeros(n, bool)
    breaths = np.zeros(n, bool)
    for s in signals:
        sp = smooth(s.prob[:n] > p["threshold"], fill_gaps=int(0.12 * RATE), min_run=int(0.06 * RATE))
        speech |= sp
        loud = s.db[:n] > s.floor + 18
        soft = (s.db[:n] > s.floor + 6) & ~loud
        sounds |= smooth(loud & ~sp, fill_gaps=int(0.1 * RATE), min_run=int(0.15 * RATE))
        breaths |= smooth(soft & ~sp, fill_gaps=int(0.05 * RATE), min_run=int(0.2 * RATE))
    protected = speech.copy()
    if keep_laughter:
        protected |= sounds
    if keep_breath:
        protected |= breaths
    for r in params.get("protect", []) or []:
        a, b = int(float(r["start"]) * RATE), int(float(r["end"]) * RATE)
        protected[max(0, a):max(0, b)] = True

    min_gap = int(p["minSilence"] * RATE)
    cands = []
    for a, b in runs(~protected):
        if b - a < min_gap:
            continue
        g0, g1 = a / RATE, b / RATE
        at_start, at_end = a == 0, b >= n
        head = 0.0 if at_start else max(p["padAfter"], p["keepPause"] / 2)
        tail = 0.0 if at_end else max(p["padBefore"], p["keepPause"] / 2)
        r0, r1 = g0 + head, g1 - tail
        if r1 - r0 < 0.1:
            continue
        kind = "silence"
        if keep_breath is False and breaths[a:b].any():
            kind = "silence+breath"
        cands.append({"start": round(r0, 3), "end": round(r1, 3), "dur": round(r1 - r0, 3),
                      "gapStart": round(g0, 3), "gapEnd": round(g1, 3), "kind": kind})
    total = n / RATE
    removed = sum(c["dur"] for c in cands)
    return {"candidates": cands, "params": p, "stats": {
        "duration": round(total, 2), "removable": round(removed, 2), "count": len(cands),
        "speechRatio": round(float(speech.mean()), 3), "newDuration": round(total - removed, 2)}}


# ---- auto director ----------------------------------------------------------------

def direct(signals: dict[str, TrackSignal], params: dict[str, Any]) -> dict[str, Any]:
    """signals: {"guest": ..., "host": ...}. Returns shots in sequence seconds."""
    g, h = signals["guest"], signals["host"]
    n = min(g.prob.size, h.prob.size)
    min_shot = float(params.get("minShot", 2.0))
    max_shot = float(params.get("maxShot", 0) or 0)
    both_policy = str(params.get("both", "wide"))  # wide | hold | louder
    silence_policy = str(params.get("silence", "hold"))  # hold | wide
    margin = float(params.get("dominanceDb", 6.0))
    sens = float(params.get("sensitivity", 0.5))  # 0..1, higher = reacts to quieter speech
    delay = float(params.get("delay", 0.0))
    cutaway = float(params.get("cutaway", 2.5))

    def active(s: TrackSignal) -> np.ndarray:
        thr = 0.65 - 0.3 * sens
        return (s.prob[:n] > thr) & (s.db[:n] > s.floor + 10 - 4 * sens)

    ga, ha = active(g), active(h)
    gd, hd = g.db[:n] - g.floor, h.db[:n] - h.floor
    # mic bleed: when both "hear" speech, the clearly louder mic wins
    both = ga & ha
    g_only = ga & ~ha | (both & (gd - hd > margin))
    h_only = ha & ~ga | (both & (hd - gd > margin))
    both = ga & ha & ~g_only & ~h_only
    state = np.full(n, 0, np.int8)  # 0 silence, 1 guest, 2 host, 3 both
    state[g_only] = 1
    state[h_only] = 2
    state[both] = 3
    state = median_filter(state, size=int(0.3 * RATE) | 1, mode="nearest")

    # states -> cameras
    cam = np.empty(n, dtype=object)
    cam[state == 1] = "guest"
    cam[state == 2] = "host"
    if both_policy == "wide":
        cam[state == 3] = "wide"
    elif both_policy == "louder":
        cam[(state == 3) & (gd >= hd)] = "guest"
        cam[(state == 3) & (gd < hd)] = "host"
    else:
        cam[state == 3] = None
    cam[state == 0] = "wide" if silence_policy == "wide" else None
    # hold: carry the previous camera through undecided frames
    last = "wide"
    for i in range(n):
        if cam[i] is None:
            cam[i] = last
        else:
            last = cam[i]

    # segments
    shots: list[list[Any]] = []
    start = 0
    for i in range(1, n + 1):
        if i == n or cam[i] != cam[start]:
            shots.append([start, i, cam[start]])
            start = i
    # hysteresis: absorb shots shorter than min_shot into the previous one
    min_f = int(min_shot * RATE)
    merged: list[list[Any]] = []
    for s in shots:
        if merged and (s[1] - s[0] < min_f or merged[-1][2] == s[2]):
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    if len(merged) > 1 and merged[0][1] - merged[0][0] < min_f:
        merged[1][0] = merged[0][0]
        merged.pop(0)
    # long single-camera shots get a wide cutaway in the middle (optional)
    if max_shot > 0:
        out = []
        for a, b, c in merged:
            if c != "wide" and (b - a) / RATE > max_shot and (b - a) / RATE > cutaway + 2 * min_shot:
                mid = (a + b) // 2
                w0, w1 = mid - int(cutaway * RATE / 2), mid + int(cutaway * RATE / 2)
                out += [[a, w0, c], [w0, w1, "wide"], [w1, b, c]]
            else:
                out.append([a, b, c])
        merged = out
    # snap cut points to the quietest moment nearby (between words) and apply delay
    energy = np.maximum(gd, hd)
    win = int(0.25 * RATE)
    cuts = []
    for k in range(1, len(merged)):
        t = merged[k][0]
        lo, hi = max(merged[k - 1][0] + 1, t - win), min(merged[k][1] - 1, t + win)
        if hi > lo:
            t = lo + int(np.argmin(energy[lo:hi]))
        t = int(round(t + delay * RATE))
        merged[k - 1][1] = merged[k][0] = t
        cuts.append(t / RATE)
    result = [{"start": round(a / RATE, 3), "end": round(b / RATE, 3), "camera": c} for a, b, c in merged if b > a]
    counts = {c: sum(1 for s in result if s["camera"] == c) for c in ("guest", "host", "wide")}
    return {"shots": result, "cuts": [round(c, 3) for c in cuts], "stats": {"shots": len(result), **counts}}
