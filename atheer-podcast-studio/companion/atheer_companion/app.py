"""HTTP + WebSocket API used by the Premiere panel.

All routes live under /api/v1. Only /health and /pair work without a token.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from . import API_VERSION, SERVICE_NAME, __version__
from .auth import Auth, PairingError
from .config import Config
from .jobs import JobManager
from .media import discover_tools
from .graphics.render import RenderError, preview_png, render_video
from .graphics.templates import TEMPLATES
from .probe_job import make_probe_job
from .store import Store
from .system import capabilities

log = logging.getLogger("atheer.api")

PREFIX = "/api/v1"
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "[::1]"}


def origin_allowed(origin: str | None, extra: tuple[str, ...]) -> bool:
    """Requests from ordinary web pages are refused.

    A web page in the user's browser can send requests to 127.0.0.1. Browsers
    always attach an http(s) Origin to those, so any http(s) origin that was not
    explicitly allowed is rejected. UXP panels and native clients either send no
    Origin, "null", or a non-web scheme. The exact UXP value is logged so it can
    be confirmed on a real Premiere install (see QA checklist).
    """
    if origin is None or origin == "" or origin == "null":
        return True
    if origin in extra:
        return True
    lowered = origin.lower()
    return not (lowered.startswith("http://") or lowered.startswith("https://"))


def _host_ok(host_header: str | None) -> bool:
    if not host_header:
        return False
    host = host_header.rsplit(":", 1)[0] if not host_header.startswith("[") else host_header.split("]")[0] + "]"
    return host.lower() in ALLOWED_HOSTS


class PairBody(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    client: str = Field(default="Premiere panel", max_length=120)


class ProbeBody(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=500)


class GraphicBody(BaseModel):
    template: str = Field(max_length=40)
    fields: dict[str, str] = Field(default_factory=dict)
    width: int = Field(default=1080, ge=64, le=8192)
    height: int = Field(default=1920, ge=64, le=8192)
    fps: float = Field(default=25, ge=12, le=120)  # 29.97 etc. allowed
    duration: float | None = Field(default=None, ge=0.2, le=120)
    accent: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")
    icon: str | None = Field(default=None, max_length=1000)
    outDir: str | None = Field(default=None, max_length=1000)


def create_app(config: Config, store: Store | None = None, auth: Auth | None = None) -> FastAPI:
    config.ensure_dirs()
    store = store or Store(config.db_path)
    auth = auth or Auth(store)
    tools = discover_tools(config.ffmpeg, config.ffprobe)
    jobs = JobManager(max_workers=config.max_workers)
    jobs.register("probe", make_probe_job(store, lambda: tools.ffprobe, config.probe_timeout_s))

    def graphics_dir(requested: str | None) -> Path:
        if requested:
            d = Path(requested)
            if d.is_absolute():
                try:
                    d.mkdir(parents=True, exist_ok=True)
                    return d
                except OSError:
                    log.warning("cannot use graphics folder %s; using the engine folder", d)
        return config.data_dir / "graphics"

    def render_graphic_job(ctx, params):
        body = GraphicBody(**params)
        return render_video(tools.ffmpeg, body.template, body.fields, body.width, body.height, body.fps,
                            body.duration, graphics_dir(body.outDir), {"accent": body.accent, "icon": body.icon},
                            progress=lambda x: ctx.progress(x, "Rendering"), cancel=ctx.cancel_event)

    jobs.register("render_graphic", render_graphic_job)
    seen_origins: deque[str] = deque(maxlen=20)
    started_at = time.time()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        jobs.shutdown()
        store.close()

    app = FastAPI(title="ATHEER Companion", version=__version__, docs_url=None, redoc_url=None,
                  openapi_url=None, lifespan=lifespan)
    app.state.config = config
    app.state.store = store
    app.state.auth = auth
    app.state.jobs = jobs
    app.state.tools = tools

    @app.middleware("http")
    async def guard(request: Request, call_next):
        # DNS-rebinding guard: only literal loopback host names are served.
        if not _host_ok(request.headers.get("host")):
            return JSONResponse({"error": {"code": "bad_host", "message": "Loopback only"}}, status_code=421)
        origin = request.headers.get("origin")
        if origin is not None and origin not in seen_origins:
            seen_origins.append(origin)
            log.info("first request from Origin %r", origin)
        if not origin_allowed(origin, config.extra_allowed_origins):
            log.warning("rejected request from web origin %r to %s. If this is the Premiere panel, "
                        "restart the companion with --allow-origin %s", origin, request.url.path, origin)
            return JSONResponse({"error": {"code": "origin_rejected", "origin": origin,
                                           "message": f"Origin {origin} is not allowed"}}, status_code=403)
        if request.method == "OPTIONS":
            response: Response = Response(status_code=204)
        else:
            response = await call_next(request)
        if origin is not None:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
            response.headers["Vary"] = "Origin"
        response.headers["Cache-Control"] = "no-store"
        return response

    def require_token(request: Request) -> None:
        header = request.headers.get("authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else None
        if not auth.check(token):
            raise HTTPException(status_code=401, detail={"code": "unauthorized",
                                                         "message": "Not paired. Enter the pairing code shown "
                                                                    "in the companion window."})

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException):
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "error", "message": str(exc.detail)}
        return JSONResponse({"error": detail}, status_code=exc.status_code, headers=exc.headers)

    # ---- public --------------------------------------------------------------

    @app.get(PREFIX + "/health")
    async def health() -> dict[str, Any]:
        return {
            "service": SERVICE_NAME,
            "version": __version__,
            "apiVersion": API_VERSION,
            "uptimeSeconds": round(time.time() - started_at, 1),
            "ffprobeAvailable": tools.ffprobe is not None,
        }

    @app.post(PREFIX + "/pair")
    async def pair(body: PairBody) -> dict[str, Any]:
        try:
            token = auth.pair(body.code, body.client)
        except PairingError as e:
            headers = {"Retry-After": str(int(e.retry_after) + 1)} if e.retry_after else None
            raise HTTPException(status_code=429 if e.retry_after else 403,
                                detail={"code": "pairing_failed", "message": str(e)}, headers=headers) from e
        log.info("paired new client %r", body.client)
        return {"token": token, "version": __version__, "apiVersion": API_VERSION}

    # ---- authenticated -------------------------------------------------------

    authed = [Depends(require_token)]

    @app.get(PREFIX + "/capabilities", dependencies=authed)
    async def get_capabilities() -> dict[str, Any]:
        caps = await asyncio.to_thread(capabilities, tools)
        caps["jobKinds"] = jobs.kinds()
        caps["service"] = {"version": __version__, "apiVersion": API_VERSION,
                           "dataDir": str(config.data_dir), "logPath": str(config.log_path)}
        caps["seenOrigins"] = list(seen_origins)
        return caps

    @app.post(PREFIX + "/jobs/probe", dependencies=authed, status_code=202)
    async def submit_probe(body: ProbeBody) -> dict[str, Any]:
        job = jobs.submit("probe", {"paths": body.paths})
        return {"job": job.to_json(include_result=False)}

    @app.get(PREFIX + "/graphics/templates", dependencies=authed)
    async def graphics_templates() -> dict[str, Any]:
        return {"templates": [t.describe() for t in TEMPLATES.values()]}

    @app.post(PREFIX + "/graphics/preview", dependencies=authed)
    async def graphics_preview(body: GraphicBody) -> dict[str, Any]:
        try:
            png = await asyncio.to_thread(preview_png, body.template, body.fields, body.width, body.height,
                                          body.duration, {"accent": body.accent, "icon": body.icon})
        except RenderError as e:
            raise HTTPException(400, detail={"code": "bad_request", "message": str(e)}) from e
        return {"png": png}

    @app.post(PREFIX + "/jobs/render_graphic", dependencies=authed, status_code=202)
    async def submit_render(body: GraphicBody) -> dict[str, Any]:
        if body.template not in TEMPLATES:
            raise HTTPException(400, detail={"code": "bad_request", "message": f"unknown template {body.template}"})
        job = jobs.submit("render_graphic", body.model_dump())
        return {"job": job.to_json(include_result=False)}

    @app.get(PREFIX + "/jobs", dependencies=authed)
    async def list_jobs() -> dict[str, Any]:
        return {"jobs": [j.to_json(include_result=False) for j in jobs.list()]}

    @app.get(PREFIX + "/jobs/{job_id}", dependencies=authed)
    async def get_job(job_id: str) -> dict[str, Any]:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(404, detail={"code": "not_found", "message": "Unknown job (companion restarted?)"})
        return {"job": job.to_json()}

    @app.post(PREFIX + "/jobs/{job_id}/cancel", dependencies=authed)
    async def cancel_job(job_id: str) -> dict[str, Any]:
        job = jobs.cancel(job_id)
        if job is None:
            raise HTTPException(404, detail={"code": "not_found", "message": "Unknown job"})
        return {"job": job.to_json(include_result=False)}

    @app.delete(PREFIX + "/cache", dependencies=authed)
    async def clear_cache() -> dict[str, Any]:
        return {"removed": store.cache_clear()}

    @app.get(PREFIX + "/logs", dependencies=authed)
    async def get_logs(tail: int = 200) -> dict[str, Any]:
        tail = max(1, min(tail, 2000))
        try:
            with open(config.log_path, encoding="utf-8", errors="replace") as fh:
                lines = list(deque(fh, maxlen=tail))
        except FileNotFoundError:
            lines = []
        return {"lines": [ln.rstrip("\n") for ln in lines]}

    @app.websocket(PREFIX + "/events")
    async def events(ws: WebSocket) -> None:
        # UXP's WebSocket cannot set headers, so the token travels as a query parameter.
        if not _host_ok(ws.headers.get("host")) or not origin_allowed(ws.headers.get("origin"),
                                                                     config.extra_allowed_origins):
            await ws.close(code=4403)
            return
        if not auth.check(ws.query_params.get("token")):
            await ws.close(code=4401)
            return
        await ws.accept()
        queue = jobs.subscribe(asyncio.get_running_loop())
        try:
            await ws.send_json({"type": "hello", "version": __version__, "apiVersion": API_VERSION})
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    event = {"type": "ping", "t": time.time()}
                await ws.send_json(event)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            jobs.unsubscribe(queue)

    return app
