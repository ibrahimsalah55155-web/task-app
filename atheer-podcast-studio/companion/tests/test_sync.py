from __future__ import annotations

import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest

from atheer_companion.analysis.audio import AudioCache
from atheer_companion.analysis.sync import SyncFile, sync_files, tc_seconds

from .conftest import FFMPEG, needs_ffmpeg

SR = 48000


def speechlike(seconds: float, seed: int) -> np.ndarray:
    """Syllable-like bursts of filtered noise with pauses, like a conversation."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    x = np.zeros(n, np.float32)
    t = 0.0
    while t < seconds - 1:
        dur = rng.uniform(0.08, 0.35)
        a = int(t * SR)
        b = min(n, a + int(dur * SR))
        noise = rng.standard_normal(b - a).astype(np.float32)
        # crude formant colouring
        noise = np.convolve(noise, np.hanning(int(rng.uniform(8, 40))), mode="same")
        env = np.hanning(b - a).astype(np.float32)
        x[a:b] += noise * env * rng.uniform(0.2, 0.9)
        t += dur + (rng.uniform(0.02, 0.15) if rng.random() < 0.85 else rng.uniform(0.4, 1.5))
    return x / (np.abs(x).max() + 1e-9) * 0.7


def write_wav(path: Path, x: np.ndarray, sr: int = SR) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


def ff(*args: str) -> None:
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


@pytest.fixture(scope="module")
def shoot(tmp_path_factory):
    if FFMPEG is None:
        pytest.skip("ffmpeg missing")
    d = tmp_path_factory.mktemp("shoot")
    master = speechlike(200, 1)  # the "room": 200 s of conversation
    write_wav(d / "master.wav", master)
    files = {}
    # guest mic: starts at 5.000 s of the room, 48 kHz WAV (the reference)
    ff("-ss", "5", "-t", "150", "-i", str(d / "master.wav"), "-c:a", "pcm_s16le", str(d / "TR1_guest.wav"))
    files["guest_mic"] = (d / "TR1_guest.wav", 0.0)
    # host mic: starts at 3.250 s, 44.1 kHz, with its own noise
    noisy = master + np.random.default_rng(2).standard_normal(master.size).astype(np.float32) * 0.02
    write_wav(d / "noisy.wav", noisy)
    ff("-ss", "3.25", "-t", "160", "-i", str(d / "noisy.wav"), "-ar", "44100", "-c:a", "pcm_s16le", str(d / "TR2_host.wav"))
    files["host_mic"] = (d / "TR2_host.wav", -1.75)
    # wide camera: video + AAC audio starting at 8.040 s, timecode that agrees
    ff("-f", "lavfi", "-i", "color=c=gray:s=160x90:r=25", "-ss", "8.04", "-t", "140", "-i", str(d / "master.wav"),
       "-map", "0:v", "-map", "1:a", "-shortest", "-c:v", "mpeg4", "-c:a", "aac", "-b:a", "96k",
       "-timecode", "00:00:08:01", str(d / "CAM_wide.mov"))
    files["wide_cam"] = (d / "CAM_wide.mov", 3.04)
    # host camera with 150 ppm clock drift (runs slow), starting at 12.5 s
    ff("-ss", "12.5", "-t", "150", "-i", str(d / "master.wav"), "-af", "asetrate=48000*0.99985,aresample=48000",
       "-c:a", "pcm_s16le", str(d / "CAM_host_drift.wav"))
    files["host_cam"] = (d / "CAM_host_drift.wav", 7.5)
    # silent camera with timecode only
    ff("-f", "lavfi", "-i", "color=c=black:s=160x90:r=25", "-t", "20", "-c:v", "mpeg4",
       "-timecode", "00:00:15:00", str(d / "CAM_guest_silent.mov"))
    files["guest_cam"] = (d / "CAM_guest_silent.mov", None)
    return d, files


@needs_ffmpeg
def test_offsets_drift_and_fallbacks(shoot, tmp_path):
    d, files = shoot
    cache = AudioCache(FFMPEG, tmp_path / "cache")
    inputs = [
        SyncFile(str(files["guest_mic"][0]), "guest_mic", timecode="00:00:05:00", fps=25),
        SyncFile(str(files["host_mic"][0]), "host_mic"),
        SyncFile(str(files["wide_cam"][0]), "wide_cam", timecode="00:00:08:01", fps=25),
        SyncFile(str(files["host_cam"][0]), "host_cam"),
        SyncFile(str(files["guest_cam"][0]), "guest_cam", timecode="00:00:15:00", fps=25, has_audio=False),
    ]
    out = sync_files(inputs, cache)
    res = {r["role"]: r for r in out["results"]}
    assert out["reference"].endswith("TR1_guest.wav")
    assert res["guest_mic"]["method"] == "reference"
    assert abs(res["host_mic"]["offset"] - (-1.75)) < 0.002, res["host_mic"]
    assert res["host_mic"]["confidence"] == "high"
    assert abs(res["wide_cam"]["offset"] - 3.04) < 0.004, res["wide_cam"]
    assert res["wide_cam"]["method"] == "audio+timecode"
    # drift: the file runs 150 ppm slow -> detected, and the start is still right
    hc = res["host_cam"]
    assert abs(hc["offset"] - 7.5) < 0.01, hc
    assert hc["driftPpm"] is not None and 100 < abs(hc["driftPpm"]) < 200, hc
    # 150 ppm over 150 s is ~0.56 frames at 25 fps: reported, but below the 1-frame warning line
    assert 0.3 < hc["driftFrames"] < 0.9, hc
    assert not any("drift" in w.lower() for w in hc["warnings"])
    # silent camera: timecode only, flagged
    gc = res["guest_cam"]
    assert gc["method"] == "timecode" and abs(gc["offset"] - 10.0) < 1e-6
    assert gc["warnings"]
    # sequence layout: earliest file at 0
    assert min(r["seqStart"] for r in out["results"] if r["seqStart"] is not None) == 0
    assert abs(res["guest_mic"]["seqStart"] - 1.75) < 0.002


@needs_ffmpeg
def test_unrelated_audio_is_low_confidence(shoot, tmp_path):
    d, files = shoot
    other = speechlike(60, 99)
    write_wav(tmp_path / "other.wav", other)
    out = sync_files([SyncFile(str(files["guest_mic"][0]), "guest_mic"), SyncFile(str(tmp_path / "other.wav"), "extra")],
                     AudioCache(FFMPEG, tmp_path / "c"))
    r = next(x for x in out["results"] if x["role"] == "extra")
    assert r["confidence"] == "low" and r["warnings"]


def test_timecode_parsing():
    assert tc_seconds("01:00:00:00", 25) == 3600
    assert tc_seconds("00:00:01:12", 25) == 1.48
    assert abs(tc_seconds("00:01:00;02", 30000 / 1001) - 1800 / (30000 / 1001)) < 1e-9
    assert tc_seconds(None, 25) is None and tc_seconds("bad", 25) is None
