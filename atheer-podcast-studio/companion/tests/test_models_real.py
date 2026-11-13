"""Real model runs, in CI where the bundled models are fetched (installer/fetch_models.py).

    RUN_REAL_MODELS=1 MAG_MODELS_DIR=build-models PIPER_VOICE=ar_JO-kareem-medium.onnx \
        pytest -s tests/test_models_real.py
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

import numpy as np
import pytest

from atheer_companion.analysis import diarize, translate
from atheer_companion.analysis.audio import AudioCache

from .conftest import FFMPEG

pytestmark = pytest.mark.skipif(not os.environ.get("RUN_REAL_MODELS"), reason="set RUN_REAL_MODELS=1")


def test_arabic_to_english():
    out = translate.OpusMT("ar", "en")(["أهلاً بكم في حلقة جديدة من البودكاست.", "شكراً جزيلاً على وجودك معنا اليوم."])
    print(out)
    assert re.search(r"(?i)welcome", out[0]) and re.search(r"(?i)episode|podcast", out[0])
    assert re.search(r"(?i)thank", out[1])


def test_english_to_arabic():
    out = translate.OpusMT("en", "ar")(["Welcome to a new episode.", "Thank you very much."])
    print(out)
    assert all(re.search(r"[؀-ۿ]", t) for t in out)
    assert "شكرا" in out[1].replace("ً", "")


def test_caption_translation_end_to_end():
    caps = [{"start": 0.0, "end": 1.4, "text": "أهلاً بكم في حلقة", "speaker": "host"},
            {"start": 1.4, "end": 2.9, "text": "جديدة من البودكاست.", "speaker": "host"},
            {"start": 3.2, "end": 4.5, "text": "شكراً جزيلاً.", "speaker": "guest"}]
    out = translate.translate_captions(caps, "ar", "en")
    print(out)
    assert out[0]["start"] == 0.0 and out[-1]["end"] == 4.5
    assert re.search(r"(?i)thank", out[-1]["text"])


def _say(text: str, path, shift: float = 1.0) -> np.ndarray:
    wav = path.with_suffix(".raw.wav")
    subprocess.run([sys.executable, "-m", "piper", "-m", os.environ["PIPER_VOICE"], "-f", str(wav)],
                   input=text.encode(), check=True)
    # A second "person": move pitch and formants (resampling trick) so the voice is clearly different.
    af = f"asetrate=22050*{shift},aresample=16000,atempo={1 / shift:.4f}" if shift != 1.0 else "aresample=16000"
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(wav), "-af", af, "-ac", "1", "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768


def test_two_speakers_on_one_mic(tmp_path):
    host = "أهلاً بكم في حلقة جديدة من البودكاست. معنا اليوم ضيف عزيز، اتفضل عرفنا بنفسك."
    guest = "شكراً جزيلاً على الدعوة. أنا سعيد جداً بوجودي معكم، وخلينا نتكلم عن دور الجدة في حياة الأحفاد."
    h1 = _say(host, tmp_path / "h1")
    g1 = _say(guest, tmp_path / "g1", 1.32)
    h2 = _say("طيب، احكيلنا أكتر عن الموضوع ده.", tmp_path / "h2")
    gap = np.zeros(int(0.6 * 16000), np.float32)
    x = np.concatenate([h1, gap, g1, gap, h2]).astype(np.float32)
    turns = [(0, h1.size / 16000), ((h1.size + gap.size) / 16000, (h1.size + gap.size + g1.size) / 16000)]
    segs = diarize.diarize_audio(x, num_speakers=2)
    print(segs)
    summ = diarize.summarise(segs)
    assert len(summ) == 2
    host_id = max(set(s["speaker"] for s in segs),
                  key=lambda k: sum(min(s["end"], turns[0][1]) - max(s["start"], turns[0][0])
                                    for s in segs if s["speaker"] == k and s["end"] > turns[0][0] and s["start"] < turns[0][1]))
    # Most of the guest turn must be labelled with the other speaker.
    g0, g1e = turns[1]
    other = sum(min(s["end"], g1e) - max(s["start"], g0) for s in segs
                if s["speaker"] != host_id and s["end"] > g0 and s["start"] < g1e)
    assert other > 0.7 * (g1e - g0), (other, g1e - g0)
    # And the director plumbing accepts it.
    signals = diarize.signals_from_segments(segs, {host_id: "host", 1 - host_id: "guest"}, x.size / 16000)
    assert signals["guest"].prob.sum() > 100 and signals["host"].prob.sum() > 100


def test_diarize_track_through_audio_cache(tmp_path):
    x = np.concatenate([_say("مرحبا بكم جميعا في هذه الحلقة.", tmp_path / "a"), np.zeros(8000, np.float32),
                        _say("أهلا وسهلا، شكرا لكم.", tmp_path / "b", 1.32)])
    wav = tmp_path / "mic.wav"
    import wave

    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes((x * 32767).astype("<i2").tobytes())
    res = diarize.diarize_track(AudioCache(FFMPEG, tmp_path / "c"),
                                {"pieces": [{"path": str(wav), "srcIn": 0, "seqStart": 1.0, "dur": x.size / 16000}]},
                                x.size / 16000 + 1.0, 2)
    print(res["speakers"])
    assert res["segments"][0]["start"] >= 0.9  # placed on the sequence timeline
    assert len(res["speakers"]) == 2
