"""Background jobs with progress, cancellation and event fan-out.

Heavy work runs on worker threads. Every state change is published to
subscribers (the WebSocket endpoint) and can also be polled over HTTP, so the
panel keeps working even if WebSockets are unavailable in its UXP build.
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import threading
import time
import traceback
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

log = logging.getLogger("atheer.jobs")

TERMINAL = {"succeeded", "failed", "cancelled"}
MAX_KEPT_JOBS = 200


class JobContext:
    """Handed to job functions: progress reporting and cancellation checks."""

    def __init__(self, manager: "JobManager", job: "Job") -> None:
        self._m = manager
        self._job = job

    @property
    def cancel_event(self) -> threading.Event:
        return self._job.cancel_event

    def cancelled(self) -> bool:
        return self._job.cancel_event.is_set()

    def progress(self, fraction: float, message: str | None = None) -> None:
        self._m._update(self._job, progress=max(0.0, min(1.0, fraction)), message=message)


@dataclass
class Job:
    id: str
    kind: str
    params: dict[str, Any]
    state: str = "queued"
    progress: float = 0.0
    message: str | None = None
    result: Any = None
    error: dict[str, str] | None = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    seq: int = 0
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)

    def to_json(self, include_result: bool = True) -> dict[str, Any]:
        d = {
            "id": self.id,
            "kind": self.kind,
            "state": self.state,
            "progress": round(self.progress, 4),
            "message": self.message,
            "error": self.error,
            "createdAt": self.created_at,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "seq": self.seq,
        }
        if include_result:
            d["result"] = self.result
        return d


JobFn = Callable[[JobContext, dict[str, Any]], Any]


class JobManager:
    def __init__(self, max_workers: int = 2) -> None:
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="atheer-job")
        self._jobs: "OrderedDict[str, Job]" = OrderedDict()
        self._lock = threading.Lock()
        self._seq = itertools.count(1)
        self._subscribers: set[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = set()
        self._handlers: dict[str, JobFn] = {}

    def register(self, kind: str, fn: JobFn) -> None:
        self._handlers[kind] = fn

    def kinds(self) -> list[str]:
        return sorted(self._handlers)

    # ---- subscription -------------------------------------------------------

    def subscribe(self, loop: asyncio.AbstractEventLoop) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        with self._lock:
            self._subscribers.add((loop, q))
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._subscribers = {s for s in self._subscribers if s[1] is not q}

    def _publish(self, event: dict[str, Any]) -> None:
        with self._lock:
            subs = list(self._subscribers)
        for loop, q in subs:
            def _put(q=q, event=event) -> None:
                if q.full():  # slow consumer: drop oldest rather than block workers
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                q.put_nowait(event)
            try:
                loop.call_soon_threadsafe(_put)
            except RuntimeError:
                pass  # loop closed

    # ---- lifecycle ----------------------------------------------------------

    def submit(self, kind: str, params: dict[str, Any]) -> Job:
        if kind not in self._handlers:
            raise KeyError(kind)
        job = Job(id=uuid.uuid4().hex[:12], kind=kind, params=params)
        with self._lock:
            job.seq = next(self._seq)
            self._jobs[job.id] = job
            while len(self._jobs) > MAX_KEPT_JOBS:
                oldest_id, oldest = next(iter(self._jobs.items()))
                if oldest.state not in TERMINAL:
                    break
                self._jobs.pop(oldest_id)
        self._publish({"type": "job", "job": job.to_json(include_result=False)})
        self._pool.submit(self._run, job)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            return list(self._jobs.values())

    def cancel(self, job_id: str) -> Job | None:
        job = self.get(job_id)
        if job is None:
            return None
        job.cancel_event.set()
        if job.state == "queued":
            self._update(job, state="cancelled", finished_at=time.time(), message="Cancelled before start")
        return job

    def shutdown(self) -> None:
        for job in self.list():
            job.cancel_event.set()
        self._pool.shutdown(wait=True, cancel_futures=True)

    def _update(self, job: Job, **changes: Any) -> None:
        with self._lock:
            for k, v in changes.items():
                if k == "message" and v is None:
                    continue
                setattr(job, k, v)
            job.seq = next(self._seq)
            snapshot = job.to_json(include_result=job.state in TERMINAL)
        self._publish({"type": "job", "job": snapshot})

    def _run(self, job: Job) -> None:
        if job.cancel_event.is_set():
            if job.state != "cancelled":
                self._update(job, state="cancelled", finished_at=time.time())
            return
        self._update(job, state="running", started_at=time.time())
        ctx = JobContext(self, job)
        try:
            result = self._handlers[job.kind](ctx, job.params)
        except Exception as e:  # noqa: BLE001 - every failure must reach the panel
            from .media import Cancelled

            if isinstance(e, Cancelled) or job.cancel_event.is_set():
                self._update(job, state="cancelled", finished_at=time.time(), message="Cancelled")
                return
            log.error("job %s (%s) failed: %s\n%s", job.id, job.kind, e, traceback.format_exc())
            self._update(job, state="failed", finished_at=time.time(),
                         error={"type": type(e).__name__, "message": str(e)})
            return
        if job.cancel_event.is_set():
            self._update(job, state="cancelled", finished_at=time.time(), result=result,
                         message="Cancelled (partial result kept)")
        else:
            self._update(job, state="succeeded", progress=1.0, finished_at=time.time(), result=result)
