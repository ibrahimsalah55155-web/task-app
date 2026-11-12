from __future__ import annotations

import threading
import time

import pytest

from atheer_companion.jobs import JobManager
from atheer_companion.media import Cancelled, _run_cancellable, parse_rational
from fractions import Fraction


def _wait(m: JobManager, job_id: str, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        j = m.get(job_id)
        if j.state in {"succeeded", "failed", "cancelled"}:
            return j
        time.sleep(0.02)
    raise AssertionError("timeout")


def test_job_success_failure_and_cancel():
    m = JobManager(max_workers=2)
    started = threading.Event()

    def ok(ctx, params):
        ctx.progress(0.5, "half")
        return {"x": params["x"] * 2}

    def boom(ctx, params):
        raise ValueError("bad input")

    def slow(ctx, params):
        started.set()
        while not ctx.cancelled():
            time.sleep(0.01)
        raise Cancelled("cancelled")

    m.register("ok", ok)
    m.register("boom", boom)
    m.register("slow", slow)

    assert _wait(m, m.submit("ok", {"x": 21}).id).result == {"x": 42}
    failed = _wait(m, m.submit("boom", {}).id)
    assert failed.state == "failed" and failed.error == {"type": "ValueError", "message": "bad input"}

    s = m.submit("slow", {})
    assert started.wait(5)
    m.cancel(s.id)
    assert _wait(m, s.id).state == "cancelled"

    with pytest.raises(KeyError):
        m.submit("nope", {})
    m.shutdown()


def test_cancel_queued_job_never_runs():
    m = JobManager(max_workers=1)
    gate = threading.Event()
    ran = []
    m.register("block", lambda ctx, p: gate.wait(5))
    m.register("rec", lambda ctx, p: ran.append(1))
    m.submit("block", {})
    q = m.submit("rec", {})
    m.cancel(q.id)
    gate.set()
    assert _wait(m, q.id).state == "cancelled"
    time.sleep(0.1)
    assert ran == []
    m.shutdown()


def test_subprocess_cancel_kills_process():
    import sys

    cancel = threading.Event()
    threading.Timer(0.2, cancel.set).start()
    t0 = time.time()
    with pytest.raises(Cancelled):
        _run_cancellable([sys.executable, "-c", "import time; time.sleep(30)"], 60, cancel)
    assert time.time() - t0 < 5


def test_subprocess_timeout():
    import sys

    with pytest.raises(TimeoutError):
        _run_cancellable([sys.executable, "-c", "import time; time.sleep(30)"], 0.3, None)


@pytest.mark.parametrize("raw,expected", [
    ("30000/1001", Fraction(30000, 1001)),
    ("25/1", Fraction(25)),
    ("0/0", None),
    ("", None),
    (None, None),
    ("abc", None),
    ("24", Fraction(24)),
])
def test_parse_rational(raw, expected):
    assert parse_rational(raw) == expected
