"""API for phases 2-6: sync, silence, director, transcription, captions, reels, faces."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, Callable

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field

from .analysis.audio import AudioCache
from .analysis.captions import STYLES, build_captions, render_caption_stills, to_srt
from .analysis.faces import face_centres
from .analysis.reels import find_reels
from .analysis.speech import PRESETS, analyse_tracks, detect_silences, direct
from .analysis.sync import SyncFile, sync_files
from .analysis.transcribe import MODELS, WhisperBackend, audio_key, transcribe_tracks
from .analysis.vad import silero_available
from .jobs import JobManager
from .media import PROBE_ANALYSER_VERSION, probe_file
from .store import Store

PREFIX = "/api/v1"


class PieceIn(BaseModel):
    path: str
    srcIn: float = 0
    seqStart: float = 0
    dur: float = Field(gt=0)


class TrackIn(BaseModel):
    name: str = "track"
    role: str | None = None  # guest | host | other
    pieces: list[PieceIn]


class SyncFileIn(BaseModel):
    path: str
    role: str


class SyncBody(BaseModel):
    files: list[SyncFileIn] = Field(min_length=1, max_length=64)
    reference: str | None = None


class SilenceBody(BaseModel):
    tracks: list[TrackIn] = Field(min_length=1)
    duration: float = Field(gt=0)
    params: dict[str, Any] = Field(default_factory=dict)


class DirectorBody(BaseModel):
    guest: TrackIn
    host: TrackIn
    duration: float = Field(gt=0)
    params: dict[str, Any] = Field(default_factory=dict)


class TranscribeBody(BaseModel):
    tracks: list[TrackIn] = Field(min_length=1)
    duration: float = Field(gt=0)
    model: str = "large-v3-turbo"
    language: str | None = "ar"


class CaptionBuildBody(BaseModel):
    words: list[dict[str, Any]]
    maxChars: int = Field(default=32, ge=10, le=80)
    maxDur: float = Field(default=5.0, ge=1, le=10)


class CaptionRenderBody(BaseModel):
    captions: list[dict[str, Any]]
    style: str = "podcast"
    width: int = 1080
    height: int = 1920
    accent: str | None = None
    outDir: str


class SrtBody(BaseModel):
    captions: list[dict[str, Any]]
    path: str


class ReelsBody(BaseModel):
    words: list[dict[str, Any]]
    count: int = Field(default=10, ge=1, le=30)
    minDur: float = Field(default=30, ge=5)
    maxDur: float = Field(default=60, le=180)


class FacesBody(BaseModel):
    path: str
    ranges: list[tuple[float, float]] = Field(min_length=1, max_length=500)


def _tracks(ts: list[TrackIn]) -> list[dict[str, Any]]:
    return [{"name": t.name, "role": t.role, "pieces": [p.model_dump() for p in t.pieces]} for t in ts]


def register(app: FastAPI, jobs: JobManager, store: Store, data_dir: Path, ffmpeg_get: Callable[[], str | None],
             ffprobe_get: Callable[[], str | None], authed: list) -> None:
    cache = AudioCache(ffmpeg_get(), data_dir / "cache" / "audio")
    models_dir = data_dir / "models" / "whisper"
    transcripts = data_dir / "cache" / "transcripts"

    # ---- jobs -------------------------------------------------------------------

    def sync_job(ctx, p):
        body = SyncBody(**p)
        files = []
        for f in body.files:
            info = None
            try:
                st = os.stat(f.path)
                info = store.cache_get("probe", os.path.normpath(os.path.abspath(f.path)), st.st_size, st.st_mtime_ns,
                                       PROBE_ANALYSER_VERSION) or probe_file(ffprobe_get(), f.path)
            except Exception:  # noqa: BLE001
                info = None
            fps = None
            if info and info.get("video") and info["video"][0].get("frameRate"):
                fps = info["video"][0]["frameRate"]["value"]
            files.append(SyncFile(f.path, f.role, timecode=(info or {}).get("timecode"), fps=fps,
                                  duration=(info or {}).get("duration"), has_audio=bool((info or {}).get("audio", [1]))))
        return sync_files(files, cache, body.reference, progress=lambda x, m: ctx.progress(x, m), cancel=ctx.cancel_event)

    def silence_job(ctx, p):
        body = SilenceBody(**p)
        sig = analyse_tracks(cache, _tracks(body.tracks), body.duration, lambda x, m: ctx.progress(x * 0.9, m),
                             ctx.cancel_event)
        ctx.progress(0.92, "Finding pauses")
        return {**detect_silences(sig, body.params), "silero": silero_available()}

    def director_job(ctx, p):
        body = DirectorBody(**p)
        sig = analyse_tracks(cache, _tracks([body.guest, body.host]), body.duration,
                             lambda x, m: ctx.progress(x * 0.9, m), ctx.cancel_event)
        ctx.progress(0.92, "Choosing cameras")
        return direct({"guest": sig[0], "host": sig[1]}, body.params)

    def transcribe_job(ctx, p):
        body = TranscribeBody(**p)
        tracks = _tracks(body.tracks)
        key = audio_key(tracks, body.model, body.language)
        signals = None
        roles = [t["role"] for t in tracks]
        if "guest" in roles and "host" in roles:
            sig = analyse_tracks(cache, tracks, body.duration, lambda x, m: ctx.progress(0.02, "Preparing"),
                                 ctx.cancel_event)
            signals = {t["role"]: s for t, s in zip(tracks, sig) if t["role"] in ("guest", "host")}
        return transcribe_tracks(cache, tracks, body.duration, WhisperBackend(body.model, models_dir), body.language,
                                 transcripts, key, signals, progress=lambda x, m: ctx.progress(x, m),
                                 cancel=ctx.cancel_event)

    def captions_job(ctx, p):
        body = CaptionRenderBody(**p)
        items = render_caption_stills(body.captions, body.style, body.width, body.height, Path(body.outDir),
                                      body.accent, progress=lambda x, m: ctx.progress(x, m), cancel=ctx.cancel_event)
        return {"items": items}

    def faces_job(ctx, p):
        body = FacesBody(**p)
        return {"faces": face_centres(ffmpeg_get(), body.path, [tuple(r) for r in body.ranges], cancel=ctx.cancel_event)}

    for kind, fn in (("sync", sync_job), ("silence", silence_job), ("director", director_job),
                     ("transcribe", transcribe_job), ("render_captions", captions_job), ("faces", faces_job)):
        jobs.register(kind, fn)

    def submit(kind: str, model: type[BaseModel]):
        async def handler(body):
            job = jobs.submit(kind, body.model_dump())
            return {"job": job.to_json(include_result=False)}
        # Real type objects (not strings): this module uses postponed annotations,
        # which FastAPI cannot resolve for a closure variable.
        handler.__annotations__ = {"body": model, "return": dict}
        return handler

    app.post(PREFIX + "/jobs/sync", dependencies=authed, status_code=202)(submit("sync", SyncBody))
    app.post(PREFIX + "/jobs/silence", dependencies=authed, status_code=202)(submit("silence", SilenceBody))
    app.post(PREFIX + "/jobs/director", dependencies=authed, status_code=202)(submit("director", DirectorBody))
    app.post(PREFIX + "/jobs/transcribe", dependencies=authed, status_code=202)(submit("transcribe", TranscribeBody))
    app.post(PREFIX + "/jobs/render_captions", dependencies=authed, status_code=202)(submit("render_captions", CaptionRenderBody))
    app.post(PREFIX + "/jobs/faces", dependencies=authed, status_code=202)(submit("faces", FacesBody))

    # ---- quick (synchronous) helpers ---------------------------------------------------

    @app.get(PREFIX + "/analysis/info", dependencies=authed)
    async def info() -> dict[str, Any]:
        downloaded = sorted(p.name for p in models_dir.glob("models--*")) if models_dir.is_dir() else []
        return {"silencePresets": PRESETS, "silero": silero_available(), "asrModels": MODELS,
                "asrDownloaded": downloaded, "captionStyles": STYLES}

    @app.post(PREFIX + "/captions/build", dependencies=authed)
    async def captions_build(body: CaptionBuildBody) -> dict[str, Any]:
        return {"captions": build_captions(body.words, body.maxChars, body.maxDur)}

    @app.post(PREFIX + "/captions/srt", dependencies=authed)
    async def captions_srt(body: SrtBody) -> dict[str, Any]:
        path = Path(body.path)
        if not path.is_absolute() or path.suffix.lower() != ".srt":
            raise HTTPException(400, detail={"code": "bad_request", "message": "path must be an absolute .srt path"})
        path.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(path.write_text, to_srt(body.captions), "utf-8-sig")
        return {"path": str(path)}

    @app.post(PREFIX + "/reels/find", dependencies=authed)
    async def reels(body: ReelsBody) -> dict[str, Any]:
        return {"reels": await asyncio.to_thread(find_reels, body.words, body.count, body.minDur, body.maxDur)}
