"""Who speaks when, from ONE microphone (speaker diarization).

For shoots where host and guest share a mic (or only a camera mic exists).
Uses sherpa-onnx (Apache-2.0) with the pyannote segmentation-3.0 model (MIT)
and a 3D-Speaker ERes2Net speaker-embedding model (Apache-2.0), both bundled
in the plugin under engine/models/diarization. Runs on the CPU, offline.

The result is turned into per-speaker activity that the Auto Director and the
caption speaker colours use exactly like two separate microphones.
"""

from __future__ import annotations

import threading
from typing import Any, Callable

import numpy as np

from . import modelpaths
from .audio import SR, AudioCache, Piece

SEGMENTATION = ("diarization", "segmentation.onnx")
EMBEDDING = ("diarization", "embedding.onnx")


class DiarizeError(RuntimeError):
    pass


def available() -> bool:
    try:
        import sherpa_onnx  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return modelpaths.find(*SEGMENTATION) is not None and modelpaths.find(*EMBEDDING) is not None


def _engine(num_speakers: int, threshold: float):
    import sherpa_onnx as so

    seg, emb = modelpaths.find(*SEGMENTATION), modelpaths.find(*EMBEDDING)
    if seg is None or emb is None:
        raise DiarizeError("Speaker models are missing from the plugin. Reinstall the .ccx.")
    import os

    threads = max(1, min(8, (os.cpu_count() or 4) - 1))
    cfg = so.OfflineSpeakerDiarizationConfig(
        segmentation=so.OfflineSpeakerSegmentationModelConfig(
            pyannote=so.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(seg)), num_threads=threads),
        embedding=so.SpeakerEmbeddingExtractorConfig(model=str(emb), num_threads=threads),
        clustering=so.FastClusteringConfig(num_clusters=num_speakers if num_speakers > 0 else -1, threshold=threshold),
        min_duration_on=0.3, min_duration_off=0.5,
    )
    if not cfg.validate():
        raise DiarizeError("Speaker model configuration is invalid")
    return so.OfflineSpeakerDiarization(cfg)


def diarize_audio(audio: np.ndarray, num_speakers: int = 2, threshold: float = 0.5,
                  progress: Callable[[float], None] | None = None,
                  cancel: threading.Event | None = None) -> list[dict[str, Any]]:
    """audio: float32 mono at 16 kHz. Returns [{start, end, speaker}] sorted by time."""
    sd = _engine(num_speakers, threshold)
    if sd.sample_rate != SR:
        raise DiarizeError(f"model expects {sd.sample_rate} Hz")

    def cb(done: int, total: int) -> int:
        if progress:
            progress(done / max(1, total))
        return 1 if (cancel is not None and cancel.is_set()) else 0

    res = sd.process(audio.astype(np.float32), callback=cb).sort_by_start_time()
    if cancel is not None and cancel.is_set():
        raise DiarizeError("cancelled")
    return [{"start": float(r.start), "end": float(r.end), "speaker": int(r.speaker)} for r in res]


def summarise(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Per speaker: total talk time and a long, clean sample (for "listen" in the panel)."""
    by: dict[int, dict[str, Any]] = {}
    for s in segments:
        d = by.setdefault(s["speaker"], {"speaker": s["speaker"], "talk": 0.0, "sample": None, "turns": 0})
        d["talk"] += s["end"] - s["start"]
        d["turns"] += 1
        if d["sample"] is None or (s["end"] - s["start"]) > (d["sample"][1] - d["sample"][0]):
            d["sample"] = [s["start"], s["end"]]
    return sorted(by.values(), key=lambda d: -d["talk"])


def activity(segments: list[dict[str, Any]], speaker: int, total: float, hz: int = 100) -> np.ndarray:
    """Boolean speech activity of one speaker on a 100 Hz grid."""
    a = np.zeros(int(round(total * hz)) + 1, bool)
    for s in segments:
        if s["speaker"] == speaker:
            a[int(s["start"] * hz):int(np.ceil(s["end"] * hz))] = True
    return a


def label_words(words: list[dict[str, Any]], segments: list[dict[str, Any]], roles: dict[int, str]) -> None:
    """Give each word the role of the speaker segment it overlaps most."""
    for w in words:
        best, best_ov = None, 0.0
        for s in segments:
            if s["end"] <= w["start"]:
                continue
            if s["start"] >= w["end"]:
                break
            ov = min(s["end"], w["end"]) - max(s["start"], w["start"])
            if ov > best_ov:
                best, best_ov = s["speaker"], ov
        if best is not None and best in roles:
            w["speaker"] = roles[best]


def diarize_track(cache: AudioCache, track: dict[str, Any], total: float, num_speakers: int = 2,
                  progress: Callable[[float, str], None] | None = None,
                  cancel: threading.Event | None = None) -> dict[str, Any]:
    prog = progress or (lambda f, m: None)
    prog(0.02, "Reading audio")
    x = cache.timeline([Piece.from_json(p) for p in track["pieces"]], total, cancel)
    peak = float(np.abs(x).max()) or 1.0
    x = (x / peak * 0.9).astype(np.float32)
    prog(0.1, "Separating speakers")
    segs = diarize_audio(x, num_speakers, progress=lambda f: prog(0.1 + 0.88 * f, "Separating speakers"),
                         cancel=cancel)
    prog(1.0, "Done")
    return {"segments": segs, "speakers": summarise(segs), "duration": total}


def signals_from_segments(segments: list[dict[str, Any]], roles: dict[int, str], total: float):
    """Diarization -> the same per-role signals the Auto Director gets from separate microphones."""
    from .speech import TrackSignal

    out = {}
    for role in ("guest", "host"):
        spk = [k for k, v in roles.items() if v == role]
        act = np.zeros(int(round(total * 100)) + 1, bool)
        for k in spk:
            act |= activity(segments, k, total)
        out[role] = TrackSignal(role, act.astype(np.float32), np.where(act, -20.0, -70.0).astype(np.float32), -70.0)
    return out
