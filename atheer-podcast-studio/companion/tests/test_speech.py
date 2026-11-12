"""Silence and director on synthetic two-mic conversations with known structure."""

from __future__ import annotations

import numpy as np
import pytest

from atheer_companion.analysis.speech import TrackSignal, detect_silences, direct
from atheer_companion.analysis.vad import RATE, runs, silero_available, smooth, speech_prob

SR = 16000


def sig(name: str, segments: list[tuple[float, float]], total: float, level=0.6, bleed=None, floor_db=-60.0) -> TrackSignal:
    """A TrackSignal built directly on the 10 ms grid (fast, deterministic)."""
    n = int(total * RATE)
    prob = np.full(n, 0.03, np.float32)
    db = np.full(n, floor_db + np.random.default_rng(len(name)).normal(0, 1, n), np.float32)
    for a, b in segments:
        prob[int(a * RATE):int(b * RATE)] = 0.95
        db[int(a * RATE):int(b * RATE)] = -20 + 20 * np.log10(level)
    for a, b in bleed or []:  # the other person heard through this mic
        prob[int(a * RATE):int(b * RATE)] = 0.8
        db[int(a * RATE):int(b * RATE)] = -38
    return TrackSignal(name, prob, db, floor_db)


GUEST = [(1.0, 6.0), (6.3, 12.0), (20.0, 30.0)]
HOST = [(13.0, 18.0), (25.0, 28.5), (34.0, 40.0)]


def test_silences_follow_presets_and_protect_speech():
    g = sig("guest", GUEST, 42)
    h = sig("host", HOST, 42)
    bal = detect_silences([g, h], {"preset": "balanced"})
    starts = [(c["gapStart"], c["gapEnd"]) for c in bal["candidates"]]
    # gaps: 0-1 (start), 12-13, 18-20, 30-34, 40-42 (end); 6.0-6.3 is a natural pause (< 0.7 s) and stays
    assert (12.0, 13.0) in starts and (18.0, 20.0) in starts and (30.0, 34.0) in starts
    assert not any(a < 6.3 and b > 6.0 and b - a < 0.5 for a, b in starts)
    for c in bal["candidates"]:
        # never inside speech, and padding kept on both sides of interior gaps
        for a, b in GUEST + HOST:
            assert c["end"] <= a or c["start"] >= b
        if c["gapStart"] > 0 and c["gapEnd"] < 42:
            assert c["start"] - c["gapStart"] >= 0.2 - 1e-6 and c["gapEnd"] - c["end"] >= 0.15 - 1e-6
    cons = detect_silences([g, h], {"preset": "conservative"})
    aggr = detect_silences([g, h], {"preset": "aggressive"})
    assert cons["stats"]["removable"] < bal["stats"]["removable"] < aggr["stats"]["removable"]


def test_laughter_and_protected_ranges_are_kept():
    g = sig("guest", GUEST, 42)
    h = sig("host", HOST, 42)
    # loud non-speech burst (laughter) in the 30-34 gap
    h.db[int(31 * RATE):int(32 * RATE)] = -15
    keep = detect_silences([g, h], {"preset": "balanced", "preserveLaughter": True})
    assert not any(c["start"] < 32 and c["end"] > 31 for c in keep["candidates"])
    drop = detect_silences([g, h], {"preset": "balanced", "preserveLaughter": False})
    assert any(c["start"] < 32 and c["end"] > 31 for c in drop["candidates"])
    prot = detect_silences([g, h], {"preset": "balanced", "protect": [{"start": 17, "end": 21}]})
    assert not any(c["start"] < 21 and c["end"] > 17 for c in prot["candidates"])


def test_director_picks_the_speaker_with_hysteresis_and_bleed():
    # each mic hears the other person quietly (bleed) — must not trigger a cut
    g = sig("guest", GUEST, 42, bleed=[(13.0, 18.0), (34.0, 40.0)])
    h = sig("host", HOST, 42, bleed=[(1.0, 12.0), (20.0, 25.0), (28.5, 30.0)])
    out = direct({"guest": g, "host": h}, {"minShot": 2.0, "both": "wide", "silence": "hold"})
    shots = out["shots"]

    def cam_at(t):
        return next(s["camera"] for s in shots if s["start"] <= t < s["end"])

    assert cam_at(3) == "guest" and cam_at(9) == "guest"
    assert cam_at(15) == "host"
    assert cam_at(22) == "guest"
    assert cam_at(26.7) == "wide"  # both talking for 3.5 s -> wide
    assert cam_at(37) == "host"
    assert cam_at(6.15) == "guest"  # short pause inside the guest's answer: no cut
    assert all(s["end"] - s["start"] >= 1.5 for s in shots[1:-1])  # min shot respected (cuts snap +-0.25 s)
    assert shots[0]["start"] == 0 and shots[-1]["end"] == 42


def test_director_long_shots_get_a_cutaway():
    g = sig("guest", [(0.5, 40.0)], 42)
    h = sig("host", [], 42)
    out = direct({"guest": g, "host": h}, {"minShot": 2.0, "maxShot": 12.0, "cutaway": 2.5})
    assert [s["camera"] for s in out["shots"]][:3] == ["guest", "wide", "guest"]


def test_smoothing_helpers():
    m = np.array([1, 1, 0, 1, 1, 0, 0, 0, 1, 0, 0], bool)
    assert smooth(m, fill_gaps=2, min_run=0).tolist() == [1, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0]
    assert runs(np.array([0, 1, 1, 0, 1], bool)) == [(1, 3), (4, 5)]


@pytest.mark.skipif(not silero_available(), reason="onnxruntime not installed")
def test_silero_hears_voice_not_noise():
    rng = np.random.default_rng(0)
    t = np.arange(int(3 * SR)) / SR
    # harmonic "voice" with syllable modulation vs. stationary hiss
    f0 = 140 + 20 * np.sin(2 * np.pi * 3 * t)
    voice = sum(np.sin(2 * np.pi * k * np.cumsum(f0) / SR) / k for k in range(1, 12))
    voice *= (0.5 + 0.5 * np.sin(2 * np.pi * 4 * t)) * 0.3
    hiss = rng.standard_normal(t.size) * 0.01
    x = np.concatenate([hiss, voice + hiss, hiss]).astype(np.float32)
    p = speech_prob(x)
    assert p[:250].mean() < 0.3
    assert p[350:550].mean() > p[:250].mean()
