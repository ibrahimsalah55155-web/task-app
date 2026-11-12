"""Speech-to-text with word timestamps (faster-whisper, local, no key).

The model is downloaded once into the engine's data folder (first use needs
internet; afterwards it works offline). GPU (CUDA) is used when available,
otherwise int8 on the CPU. Results are cached by audio + model + language.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Callable, Protocol

import numpy as np

from .audio import SR, AudioCache, Piece
from .speech import TrackSignal

log = logging.getLogger("atheer.asr")

MODELS = {
    "small": "Fast, rough (CPU friendly)",
    "medium": "Balanced",
    "large-v3-turbo": "Recommended: near large-v3 quality, much faster",
    "large-v3": "Best Arabic accuracy, slowest",
}


class Backend(Protocol):
    def transcribe(self, audio: np.ndarray, language: str | None, progress: Callable[[float], None],
                   cancel: threading.Event | None) -> dict[str, Any]: ...


TEST_MODELS = {"tiny", "base"}  # accepted but not offered in the panel


class WhisperBackend:
    _cache: dict[tuple[str, str], Any] = {}
    _lock = threading.Lock()

    def __init__(self, model: str, models_dir: Path) -> None:
        if model not in MODELS and model not in TEST_MODELS:
            raise ValueError(f"unknown model {model}")
        self.model_name = model
        self.models_dir = models_dir

    def _model(self):
        from faster_whisper import WhisperModel

        device, compute = "cpu", "int8"
        try:
            import ctranslate2

            if ctranslate2.get_cuda_device_count() > 0:
                device, compute = "cuda", "float16"
        except Exception:  # noqa: BLE001
            pass
        key = (self.model_name, device)
        with self._lock:
            if key not in self._cache:
                self.models_dir.mkdir(parents=True, exist_ok=True)
                log.info("loading whisper %s on %s (%s)", self.model_name, device, compute)
                self._cache[key] = WhisperModel(self.model_name, device=device, compute_type=compute,
                                                download_root=str(self.models_dir),
                                                cpu_threads=max(1, (os.cpu_count() or 4) - 1))
            return self._cache[key]

    def transcribe(self, audio, language, progress, cancel):
        model = self._model()
        total = audio.size / SR
        segments, info = model.transcribe(audio, language=language, word_timestamps=True, vad_filter=True,
                                          beam_size=5, condition_on_previous_text=False)
        out = []
        for seg in segments:
            if cancel is not None and cancel.is_set():
                raise RuntimeError("cancelled")
            out.append({"start": seg.start, "end": seg.end, "text": seg.text.strip(),
                        "words": [{"start": w.start, "end": w.end, "word": w.word.strip(), "prob": w.probability}
                                  for w in (seg.words or [])]})
            progress(min(0.99, seg.end / max(total, 1e-6)))
        return {"language": info.language, "languageProbability": info.language_probability, "segments": out}


def audio_key(pieces_by_track: list[dict[str, Any]], model: str, language: str | None) -> str:
    h = hashlib.sha1()
    for tr in pieces_by_track:
        for p in tr["pieces"]:
            st = os.stat(p["path"])
            h.update(f"{p['path']}|{st.st_size}|{st.st_mtime_ns}|{p.get('srcIn', 0)}|{p.get('seqStart', 0)}|{p['dur']}".encode())
    h.update(f"{model}|{language}|asr-1".encode())
    return h.hexdigest()[:20]


def attribute_speakers(words: list[dict[str, Any]], signals: dict[str, TrackSignal]) -> None:
    """Who said each word: the mic that is clearly louder (above its own floor) during it."""
    if len(signals) < 2:
        return
    for w in words:
        a, b = int(w["start"] * 100), max(int(w["start"] * 100) + 1, int(w["end"] * 100))
        best, best_v = None, -1e9
        for name, s in signals.items():
            seg = s.db[a:b]
            if seg.size == 0:
                continue
            v = float(np.mean(seg)) - s.floor
            if v > best_v:
                best, best_v = name, v
        w["speaker"] = best


def transcribe_tracks(cache: AudioCache, tracks: list[dict[str, Any]], total: float, backend: Backend,
                      language: str | None, cache_dir: Path, key: str,
                      signals: dict[str, TrackSignal] | None = None,
                      progress: Callable[[float, str], None] | None = None,
                      cancel: threading.Event | None = None) -> dict[str, Any]:
    prog = progress or (lambda f, m: None)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached = cache_dir / f"{key}.json"
    if cached.is_file():
        return {**json.loads(cached.read_text(encoding="utf-8")), "cached": True}
    prog(0.02, "Mixing microphones")
    mix = np.zeros(int(round(total * SR)) + 1, np.float32)
    for tr in tracks:
        x = cache.timeline([Piece.from_json(p) for p in tr["pieces"]], total, cancel)
        mix[: x.size] += x[: mix.size]
    peak = float(np.abs(mix).max()) or 1.0
    mix = (mix / peak * 0.9).astype(np.float32)
    prog(0.05, "Transcribing (the first run downloads the model)")
    res = backend.transcribe(mix, language, lambda f: prog(0.05 + 0.9 * f, "Transcribing"), cancel)
    words = [w for s in res["segments"] for w in s["words"]]
    if signals:
        attribute_speakers(words, signals)
    res["duration"] = total
    cached.write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
    prog(1.0, "Done")
    return {**res, "cached": False}
