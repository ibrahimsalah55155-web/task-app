"""Real speech-to-text, run in CI where the network allows model downloads.

    RUN_REAL_ASR=1 PIPER_VOICE=/path/ar_JO-kareem-medium.onnx pytest tests/test_asr_real.py
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

import numpy as np
import pytest

from atheer_companion.analysis.audio import AudioCache
from atheer_companion.analysis.transcribe import WhisperBackend, transcribe_tracks

from .conftest import FFMPEG

pytestmark = pytest.mark.skipif(not os.environ.get("RUN_REAL_ASR"), reason="set RUN_REAL_ASR=1 (downloads a model)")


def test_arabic_speech_is_transcribed_with_word_times(tmp_path):
    voice = os.environ["PIPER_VOICE"]
    wav = tmp_path / "ar.wav"
    text = "أهلاً بكم في حلقة جديدة من البودكاست. اليوم نتحدث عن دور الجدة في حياة الأحفاد."
    subprocess.run([sys.executable, "-m", "piper", "-m", voice, "-f", str(wav)], input=text.encode(), check=True)
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(wav)],
                               capture_output=True, text=True).stdout)
    cache = AudioCache(FFMPEG, tmp_path / "c")
    tracks = [{"name": "mic", "pieces": [{"path": str(wav), "srcIn": 0, "seqStart": 2.0, "dur": dur}]}]
    res = transcribe_tracks(cache, tracks, dur + 2.0, WhisperBackend(os.environ.get("ASR_MODEL", "small"),
                            tmp_path / "models"), "ar", tmp_path / "t", "real")
    words = [w for s in res["segments"] for w in s["words"]]
    joined = " ".join(w["word"] for w in words)
    print(joined)
    assert re.search(r"[؀-ۿ]", joined)
    assert len(words) >= 6
    starts = [w["start"] for w in words]
    assert starts == sorted(starts)
    assert starts[0] >= 1.5  # speech starts at 2.0 s on the sequence
    assert any(k in joined for k in ("الجدة", "البودكاست", "حلقة", "الأحفاد"))
