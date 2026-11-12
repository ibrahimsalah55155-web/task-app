"""The engine as the plugin launches it: session token, no console, dies with its parent."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
TOKEN = "t" * 40


def _get(port: int, path: str, token: str | None = None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=2) as r:
        return r.status, json.loads(r.read())


def _wait_health(port: int, timeout: float = 15) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            _get(port, "/api/v1/health")
            return
        except Exception:  # noqa: BLE001
            time.sleep(0.1)
    raise AssertionError("engine did not start")


def _launch(port: int, tmp_path: Path, parent_pid: int, stdout=None):
    env = {**os.environ, "MAG_ENGINE_TOKEN": TOKEN, "NO_PROXY": "127.0.0.1"}
    return subprocess.Popen(
        [sys.executable, "-m", "atheer_companion", "--port", str(port), "--data-dir", str(tmp_path / "d"),
         "--parent-pid", str(parent_pid), "--token-env", "MAG_ENGINE_TOKEN"],
        cwd=ROOT, env=env, stdout=stdout, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
    )


def test_session_token_works_without_pairing(tmp_path):
    proc = _launch(47911, tmp_path, os.getpid(), stdout=subprocess.DEVNULL)
    try:
        _wait_health(47911)
        status, caps = _get(47911, "/api/v1/capabilities", TOKEN)
        assert status == 200 and "tools" in caps
        with pytest.raises(urllib.error.HTTPError) as e:
            _get(47911, "/api/v1/capabilities", "x" * 40)
        assert e.value.code == 401
    finally:
        proc.kill()
        proc.wait()


def test_engine_exits_when_parent_exits(tmp_path):
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    proc = _launch(47912, tmp_path, parent.pid, stdout=subprocess.DEVNULL)
    try:
        _wait_health(47912)
        parent.kill()
        parent.wait()
        assert proc.wait(timeout=10) == 0
    finally:
        if proc.poll() is None:
            proc.kill()


@pytest.mark.skipif(sys.platform == "win32", reason="posix-only simulation of pythonw")
def test_runs_without_stdout_like_pythonw(tmp_path):
    # pythonw.exe has sys.stdout = None; simulate by closing fd 1 and 2.
    code = (
        "import sys, runpy; sys.stdout = None; sys.stderr = None; "
        "sys.argv = ['mag', '--port', '47913', '--data-dir', r'%s', '--token-env', 'MAG_ENGINE_TOKEN']; "
        "runpy.run_module('atheer_companion', run_name='__main__')" % (tmp_path / "d")
    )
    env = {**os.environ, "MAG_ENGINE_TOKEN": TOKEN}
    proc = subprocess.Popen([sys.executable, "-c", code], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        _wait_health(47913)
        assert _get(47913, "/api/v1/capabilities", TOKEN)[0] == 200
        log = (tmp_path / "d" / "logs" / "companion.log").read_text()
        assert "listening on 127.0.0.1:47913" in log
    finally:
        proc.kill()
        proc.wait()


def test_missing_token_variable_refuses_to_start(tmp_path):
    env = {k: v for k, v in os.environ.items() if k != "MAG_ENGINE_TOKEN"}
    out = subprocess.run([sys.executable, "-m", "atheer_companion", "--port", "47914", "--data-dir", str(tmp_path / "d"),
                          "--token-env", "MAG_ENGINE_TOKEN"], cwd=ROOT, env=env, capture_output=True, timeout=30)
    assert out.returncode == 3
