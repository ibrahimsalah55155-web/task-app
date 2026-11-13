"""Finishing tools: voice clean-up, colour match, glossary corrections, speaker separation plumbing,
translation plumbing. Real model runs (diarization, OPUS-MT) are in test_models_real.py."""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import pytest

from atheer_companion.analysis import cleanup, color, diarize, translate
from atheer_companion.analysis.transcribe import apply_replacements, audio_key

from .conftest import FFMPEG, needs_ffmpeg
from .test_api import wait_job
from .test_phases import words_from
from .test_sync import write_wav

FFPROBE = FFMPEG.replace("ffmpeg", "ffprobe") if FFMPEG else None


def noisy_voice(path: Path, sr: int = 48000, seconds: float = 8.0, hum: int = 50, seed: int = 3) -> None:
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * sr)) / sr
    f0 = 130 + 30 * np.sin(2 * np.pi * 1.7 * t)
    # harmonics with random phases: a crest factor like real voiced speech
    voice = sum(np.sin(2 * np.pi * k * np.cumsum(f0) / sr + rng.uniform(0, 2 * np.pi)) / k for k in range(1, 14))
    gate = (np.sin(2 * np.pi * 0.35 * t) > -0.2).astype(float)  # speech with pauses
    x = 0.25 * voice * gate * (0.6 + 0.4 * np.sin(2 * np.pi * 4 * t))
    x += 0.02 * rng.standard_normal(t.size) + 0.03 * np.sin(2 * np.pi * hum * t)
    write_wav(path, x.astype(np.float32), sr)


def _lag_and_len(a: Path, b: Path) -> tuple[float, float, float]:
    def dur(p):
        return float(subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                     str(p)], capture_output=True, text=True).stdout)
    return cleanup.measure_lag(FFMPEG, str(a), str(b), dur(a)), dur(a), dur(b)


@needs_ffmpeg
@pytest.mark.parametrize("preset", ["light", "standard", "strong"])
def test_cleanup_keeps_timing_and_hits_loudness(tmp_path, preset):
    src = tmp_path / "Guest Mic.wav"
    noisy_voice(src)
    out = tmp_path / "clean" / "g.wav"
    r = cleanup.clean_file(FFMPEG, FFPROBE, str(src), str(out), cleanup.settings(preset))
    lag, da, db = _lag_and_len(src, out)
    assert abs(lag) < 0.001, lag  # sample-aligned: the swap cannot break sync
    assert abs(da - db) < 1e-3
    assert r["sampleRate"] == 48000 and r["channels"] == 1
    assert abs(r["lufsAfter"] + 16) <= 0.5
    assert r["truePeakAfter"] <= -1.0
    if preset != "light":
        assert r["humHz"] == 50


@needs_ffmpeg
def test_cleanup_reduces_noise_between_words(tmp_path):
    src = tmp_path / "mic.wav"
    noisy_voice(src, hum=60)
    out = tmp_path / "o.wav"
    r = cleanup.clean_file(FFMPEG, FFPROBE, str(src), str(out), cleanup.settings("strong"))
    assert r["humHz"] == 60

    def snr(p):
        x = np.frombuffer(subprocess.run([FFMPEG, "-v", "error", "-i", str(p), "-ac", "1", "-ar", "16000", "-f",
                                          "s16le", "-"], capture_output=True).stdout, np.int16).astype(float)
        t = np.arange(x.size) / 16000
        gate = np.sin(2 * np.pi * 0.35 * t) > -0.2
        quiet = np.sin(2 * np.pi * 0.35 * t) < -0.5
        return 20 * np.log10(x[gate].std() / (x[quiet].std() + 1e-9))

    assert snr(out) > snr(src) + 8


@needs_ffmpeg
def test_cleanup_job_through_the_api(authed, tmp_path):
    a, b = tmp_path / "Guest Mic.wav", tmp_path / "Host Mic.wav"
    noisy_voice(a, seed=1)
    noisy_voice(b, seed=2, sr=44100)
    r = authed.post("/api/v1/jobs/cleanup", json={"files": [str(a), str(b)], "preset": "standard",
                                                  "target": "social", "outDir": str(tmp_path / "MAG Clean Audio")})
    job = wait_job(authed, r.json()["job"]["id"], timeout=120)
    assert job["state"] == "succeeded", job
    files = job["result"]["files"]
    assert [Path(f["output"]).name for f in files] == ["Guest Mic_MAG_clean_standard.wav",
                                                       "Host Mic_MAG_clean_standard.wav"]
    assert files[1]["sampleRate"] == 44100
    assert all(abs(f["lufsAfter"] + 14) <= 0.5 for f in files), files
    bad = authed.post("/api/v1/jobs/cleanup", json={"files": [str(tmp_path / "missing.wav")],
                                                    "outDir": str(tmp_path)})
    job = wait_job(authed, bad.json()["job"]["id"])
    assert job["state"] == "failed" and "not found" in job["error"]["message"].lower()


# ---- colour -------------------------------------------------------------------------

@pytest.fixture(scope="module")
def two_cameras(tmp_path_factory):
    if FFMPEG is None:
        pytest.skip("ffmpeg not installed")
    d = tmp_path_factory.mktemp("cams")
    ref, cam = d / "WIDE.mp4", d / "HOST.mp4"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=480x270:rate=25", "-t", "3",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(ref)], check=True)
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(ref), "-vf",
                    "colorbalance=rs=0.15:bs=-0.12:rm=0.1:bm=-0.1,eq=brightness=-0.06:contrast=0.85:saturation=0.8",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(cam)], check=True)
    return ref, cam


def test_lab_round_trip_and_identity_lut():
    rng = np.random.default_rng(0)
    rgb = rng.random((500, 3))
    assert np.abs(color.lab_to_rgb(color.rgb_to_lab(rgb)) - rgb).max() < 1e-6
    st = color.stats_from_rgb(rgb)
    assert np.abs(color.apply_lut(rgb, color.match_lut(st, st)) - rgb).max() < 1e-6


def test_color_match_lut_brings_camera_to_reference(two_cameras, tmp_path):
    ref, cam = two_cameras
    times = [0.4, 1.4, 2.4]
    res = color.measure(FFMPEG, [{"id": "wide", "path": str(ref), "times": times},
                                 {"id": "host", "path": str(cam), "times": times}], "wide")
    before = res["delta"]["host"]["error"]
    assert before > 15
    luts = color.write_luts(res, str(tmp_path))
    cube = Path(luts["host"])
    assert cube.read_text().splitlines()[1] == "LUT_3D_SIZE 33"
    # Apply the .cube with FFmpeg (an independent implementation) and measure again.
    png = tmp_path / "fixed.png"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", "1.4", "-i", str(cam), "-frames:v", "1", "-vf",
                    f"format=rgb24,lut3d=file={cube.name}", str(png)], check=True, cwd=str(cube.parent))
    after = color.compare_image(str(png), res["stats"]["wide"])["delta"]["error"]
    assert after < before / 3, (before, after)


def test_color_api_measure_and_compare(authed, two_cameras, tmp_path):
    ref, cam = two_cameras
    r = authed.post("/api/v1/jobs/color", json={"cameras": [
        {"id": "wide", "path": str(ref), "times": [1.0]},
        {"id": "host", "path": str(cam), "times": [1.0]}], "reference": "wide", "lutDir": str(tmp_path)})
    job = wait_job(authed, r.json()["job"]["id"], timeout=60)
    assert job["state"] == "succeeded", job
    res = job["result"]
    assert Path(res["luts"]["host"]).is_file() and "wide" not in res["luts"]
    png = tmp_path / "frame.png"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", "1", "-i", str(ref), "-frames:v", "1", str(png)], check=True)
    cmp = authed.post("/api/v1/color/compare", json={"path": str(png), "target": res["stats"]["wide"]}).json()
    assert cmp["delta"]["error"] < 5  # same picture, PNG vs. raw decode: small scaler differences only
    assert authed.post("/api/v1/color/compare", json={"path": str(tmp_path / "nope.png"),
                                                      "target": res["stats"]["wide"]}).status_code == 400


# ---- glossary / corrections ------------------------------------------------------------

def test_replacements_are_loose_and_keep_punctuation_and_times():
    ws = words_from("اهلا بيكم في بودكاست اثير، مع الجده. ودكتور احمد سامي")
    n = apply_replacements(ws, [("اثير", "أثير"), ("الجده", "الجدة"), ("دكتور احمد سامي", "د. أحمد سامي")])
    text = " ".join(w["word"] for w in ws)
    assert n == 2  # "ودكتور" is a different word: not touched
    assert "أثير،" in text and "الجدة." in text and "ودكتور" in text
    ws = words_from("مع دكتور احمد سامي.")
    start, end = ws[1]["start"], ws[3]["end"]
    assert apply_replacements(ws, [("دكتور احمد سامي", "د. أحمد سامي")]) == 1
    assert [w["word"] for w in ws] == ["مع", "د.", "أحمد", "سامي."] and ws[1]["start"] == start and ws[3]["end"] == end
    ws = words_from("السيسي قال")
    apply_replacements(ws, [("ال سيسي", "x")])  # rules never match inside a word
    assert ws[0]["word"] == "السيسي"


def test_glossary_changes_the_transcript_cache_key(tmp_path):
    f = tmp_path / "a.wav"
    write_wav(f, np.zeros(1600, np.float32))
    tr = [{"pieces": [{"path": str(f), "dur": 0.1}]}]
    assert audio_key(tr, "small", "ar") != audio_key(tr, "small", "ar", ["أثير"])


# ---- speaker separation plumbing ---------------------------------------------------------

SEGS = [{"start": 0.0, "end": 4.0, "speaker": 0}, {"start": 4.2, "end": 7.0, "speaker": 1},
        {"start": 5.0, "end": 9.0, "speaker": 0}, {"start": 9.5, "end": 16.0, "speaker": 1}]


def test_diarization_summary_activity_and_word_labels():
    summ = diarize.summarise(SEGS)
    assert [s["speaker"] for s in summ] == [1, 0]  # most talk first
    assert summ[0]["sample"] == [9.5, 16.0]
    act = diarize.activity(SEGS, 1, 16.0)
    assert act[500] and not act[100]
    ws = words_from("واحد اتنين تلاتة اربعة", start=3.0, rate=0.8)
    diarize.label_words(ws, SEGS, {0: "host", 1: "guest"})
    # 3.8-4.48 overlaps host 0.2 s and guest 0.28 s: the larger overlap wins.
    assert [w["speaker"] for w in ws] == ["host", "guest", "guest", "guest"]


def test_director_from_one_mic_with_speaker_separation(authed):
    r = authed.post("/api/v1/jobs/director", json={
        "diarization": {"segments": SEGS, "roles": {"0": "host", "1": "guest"}}, "duration": 16,
        "params": {"minShot": 1.0, "both": "wide"}})
    job = wait_job(authed, r.json()["job"]["id"])
    assert job["state"] == "succeeded", job
    shots = job["result"]["shots"]
    cams = [s["camera"] for s in shots]
    assert cams[0] == "host" and "guest" in cams and "wide" in cams  # 5.0-7.0 both talk
    assert shots[-1]["camera"] == "guest"
    bad = authed.post("/api/v1/jobs/director", json={"duration": 5})
    assert wait_job(authed, bad.json()["job"]["id"])["state"] == "failed"


def test_diarization_reports_missing_models(authed, tmp_path, monkeypatch):
    monkeypatch.setenv("MAG_MODELS_DIR", str(tmp_path / "empty"))
    if diarize.available():
        pytest.skip("models installed in another root")
    f = tmp_path / "m.wav"
    write_wav(f, np.zeros(16000, np.float32))
    r = authed.post("/api/v1/jobs/diarize", json={"track": {"name": "Mic", "pieces": [
        {"path": str(f), "dur": 1}]}, "duration": 1})
    job = wait_job(authed, r.json()["job"]["id"])
    assert job["state"] == "failed"


# ---- translation plumbing -------------------------------------------------------------

def test_translation_keeps_caption_times_and_groups_sentences():
    caps = [{"start": 0, "end": 1, "text": "أهلاً بيكم", "speaker": "host"},
            {"start": 1, "end": 2.5, "text": "في حلقة جديدة.", "speaker": "host"},
            {"start": 3, "end": 4, "text": "شكراً", "speaker": "guest"}]
    seen: list[str] = []

    def fake(texts):
        seen.extend(texts)
        return ["Welcome to a new episode." if "حلقة" in t else "Thanks" for t in texts]

    out = translate.translate_captions(caps, "ar", "en", fake)
    assert seen == ["أهلاً بيكم في حلقة جديدة.", "شكراً"]
    assert [(c["start"], c["end"]) for c in out] == [(0, 1), (1, 2.5), (3, 4)]
    assert " ".join(c["text"] for c in out[:2]) == "Welcome to a new episode."
    assert out[0]["source"] == "أهلاً بيكم" and out[0]["lang"] == "en"
    assert translate.spread("a b c d e f", [1, 2, 1]) == ["a b", "c d", "e f"] or \
        translate.spread("a b c d e f", [1, 2, 1])[1].count(" ") >= 1
    # Fewer words than slots: the previous caption stays on screen.
    out = translate.translate_captions(caps[:2], "ar", "en", lambda ts: ["Hi"])
    assert len(out) == 1 and out[0]["end"] == 2.5


def test_translation_reports_missing_models(monkeypatch, tmp_path):
    monkeypatch.setenv("MAG_MODELS_DIR", str(tmp_path / "empty"))
    if translate.model_dir("ar", "en") is None:
        with pytest.raises(translate.TranslateError):
            translate.OpusMT("ar", "en")
    with pytest.raises(translate.TranslateError):
        translate.OpusMT("ar", "fr")
