"""Phases 3-6 through the API and the pure helpers (captions, SRT, reels, transcription plumbing)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

from atheer_companion.analysis.audio import AudioCache
from atheer_companion.analysis.captions import build_captions, render_caption_stills, to_srt
from atheer_companion.analysis.reels import find_reels, hook_score, sentences
from atheer_companion.analysis.transcribe import transcribe_tracks

from .conftest import FFMPEG, needs_ffmpeg
from .test_api import wait_job
from .test_sync import speechlike, write_wav


def W(start, end, word, prob=0.9, speaker=None):
    d = {"start": start, "end": end, "word": word, "prob": prob}
    if speaker:
        d["speaker"] = speaker
    return d


def words_from(text: str, start: float = 0.0, rate: float = 0.35, speaker=None, prob=0.9):
    out, t = [], start
    for w in text.split():
        out.append(W(round(t, 2), round(t + rate * 0.85, 2), w, prob, speaker))
        t += rate
    return out


def test_captions_break_on_punctuation_pauses_and_length():
    words = words_from("أهلاً بيكم في الحلقة. النهارده هنتكلم عن الجدة ودورها في حياة الأحفاد", speaker="host")
    words += words_from("وده موضوع مهم جداً؟", start=words[-1]["end"] + 1.2, speaker="guest")
    words[3]["prob"] = 0.3
    caps = build_captions(words, max_chars=32)
    assert caps[0]["text"] == "أهلاً بيكم في الحلقة."
    assert all(len(c["text"]) <= 32 for c in caps)
    assert caps[-1]["text"].endswith("؟") and caps[-1]["speaker"] == "guest"
    assert caps[0]["lowConfidence"] == [3]
    for a, b in zip(caps, caps[1:]):
        assert a["end"] <= b["start"]  # no overlaps
    srt = to_srt(caps)
    assert srt.startswith("1\n00:00:00,000 --> ") and "أهلاً بيكم في الحلقة." in srt


def test_caption_stills_per_style(tmp_path):
    caps = build_captions(words_from("نحرص على الزيارات العائلية", speaker="guest"))
    for style in ("podcast", "clean", "minimal"):
        items = render_caption_stills(caps, style, 540, 960, tmp_path / style)
        assert len(items) == 1
        im = np.asarray(Image.open(items[0]["path"]))
        assert im.shape == (960, 540, 4) and im[..., 3].max() == 255 and (im[..., 3] > 0).mean() < 0.2
    word = render_caption_stills(caps, "word", 540, 960, tmp_path / "word")
    assert len(word) == 4  # one still per highlighted word, back to back
    assert [round(w["start"], 2) for w in word][1:] == [round(w["start"], 2) for w in caps[0]["words"][1:]]


def test_reels_prefer_authentic_hooks_with_context():
    talk = []
    t = 0.0
    filler = "وبعدين كان في كلام كتير عن الموضوع ده من ناحية تانية خالص ومش مهم قوي"
    strong = "ليه أهم حاجة في حياة الطفل هي علاقته بجدته؟"
    body = "لأن الجدة بتدي الأمان والحكايات والقيم اللي مش بنعرف ندّيها احنا في زحمة الشغل والحياة اليومية كل يوم"
    for k in range(6):
        for sentence in (filler + ".", filler + ".", strong if k == 3 else filler + ".", body + ".", body + "."):
            ws = words_from(sentence, start=t, speaker="guest")
            talk += ws
            t = ws[-1]["end"] + 0.9
    reels = find_reels(talk, count=3, min_dur=15, max_dur=40)
    assert reels, "no reels found"
    best = reels[0]
    assert best["hook"] == strong
    assert best["scores"]["hook"] > 50 and "question" in best["why"]
    assert 15 * 0.9 <= best["duration"] <= 40 * 1.05
    # a window that opens with "وبعدين" is penalised for context
    h, why = hook_score(sentences(words_from("وبعدين هو قال كده"))[0])
    assert "starts mid-thought" in why


class FakeBackend:
    def __init__(self):
        self.calls = 0

    def transcribe(self, audio, language, progress, cancel):
        self.calls += 1
        progress(0.5)
        return {"language": language or "ar", "languageProbability": 0.99,
                "segments": [{"start": 1.0, "end": 2.0, "text": "اهلا", "words": [W(1.0, 1.4, "اهلا")]}]}


@needs_ffmpeg
def test_transcription_is_cached_and_attributes_speakers(tmp_path):
    x = speechlike(4, 3)
    write_wav(tmp_path / "a.wav", x)
    cache = AudioCache(FFMPEG, tmp_path / "c")
    tracks = [{"name": "Guest Mic", "role": "guest", "pieces": [{"path": str(tmp_path / "a.wav"), "srcIn": 0, "seqStart": 0, "dur": 4}]}]
    be = FakeBackend()
    r1 = transcribe_tracks(cache, tracks, 4.0, be, "ar", tmp_path / "t", "k1")
    r2 = transcribe_tracks(cache, tracks, 4.0, be, "ar", tmp_path / "t", "k1")
    assert be.calls == 1 and r2["cached"] and r1["segments"][0]["words"][0]["word"] == "اهلا"


@needs_ffmpeg
def test_silence_job_through_the_api(authed, tmp_path):
    # 2 s speech, 3 s silence, 2 s speech on one mic
    rng = np.random.default_rng(5)
    sr = 48000
    t = np.arange(2 * sr) / sr
    f0 = 140 + 25 * np.sin(2 * np.pi * 2.5 * t)
    voice = sum(np.sin(2 * np.pi * k * np.cumsum(f0) / sr) / k for k in range(1, 12)) * (0.5 + 0.5 * np.sin(2 * np.pi * 4 * t)) * 0.3
    hiss = lambda n: rng.standard_normal(n) * 0.002  # noqa: E731
    x = np.concatenate([voice + hiss(t.size), hiss(3 * sr), voice + hiss(t.size)]).astype(np.float32)
    write_wav(tmp_path / "mic.wav", x)
    r = authed.post("/api/v1/jobs/silence", json={"tracks": [{"name": "Guest Mic", "pieces": [
        {"path": str(tmp_path / "mic.wav"), "srcIn": 0, "seqStart": 0, "dur": 7}]}], "duration": 7,
        "params": {"preset": "balanced"}})
    job = wait_job(authed, r.json()["job"]["id"], timeout=120)
    assert job["state"] == "succeeded", job
    cands = job["result"]["candidates"]
    assert any(c["start"] >= 2.0 and c["end"] <= 5.0 and c["dur"] > 2.0 for c in cands), cands


def test_quick_endpoints(authed, tmp_path):
    info = authed.get("/api/v1/analysis/info").json()
    assert "balanced" in info["silencePresets"] and "large-v3-turbo" in info["asrModels"]
    caps = authed.post("/api/v1/captions/build", json={"words": words_from("مرحبا بكم. كيف الحال؟", rate=0.5)}).json()["captions"]
    assert len(caps) == 2
    out = authed.post("/api/v1/captions/srt", json={"captions": caps, "path": str(tmp_path / "ep.srt")}).json()
    assert Path(out["path"]).read_text(encoding="utf-8-sig").count("-->") == 2
    assert authed.post("/api/v1/captions/srt", json={"captions": caps, "path": "relative.srt"}).status_code == 400
    reels = authed.post("/api/v1/reels/find", json={"words": words_from("ليه ده مهم؟ " * 60), "count": 2,
                                                     "minDur": 10, "maxDur": 20}).json()["reels"]
    assert len(reels) >= 1
