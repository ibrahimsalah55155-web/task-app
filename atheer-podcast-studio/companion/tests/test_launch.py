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


def test_token_file_and_port_range_start_once(tmp_path):
    """Windows start-up mode: token comes from a file (created if missing); a second start is a no-op;
    a busy port is skipped."""
    import socket

    tok = tmp_path / "engine" / "autostart.token"
    env = {**os.environ, "MAG_ENGINE_HOME": str(tmp_path / "home")}
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", 47921))
    blocker.listen(1)
    args = [sys.executable, "-m", "atheer_companion", "--port-range", "47921-47923", "--token-file", str(tok)]
    proc = subprocess.Popen(args, cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        _wait_health(47922, timeout=20)
        token = tok.read_text().strip()
        assert len(token) == 48
        assert _get(47922, "/api/v1/capabilities", token)[0] == 200
        import urllib.error

        try:
            _get(47922, "/api/v1/capabilities", "0" * 48)
            raise AssertionError("wrong token accepted")
        except urllib.error.HTTPError as e:
            assert e.code == 401
        again = subprocess.run(args, cwd=ROOT, env=env, capture_output=True, text=True, timeout=30)
        assert again.returncode == 0  # already running: exits quietly, no second engine
        assert tok.read_text().strip() == token  # token kept
    finally:
        proc.terminate()
        proc.wait(timeout=10)
        blocker.close()


def test_trust_local_engine_needs_no_token_but_still_refuses_browsers(tmp_path):
    import urllib.error

    env = {**os.environ, "MAG_ENGINE_HOME": str(tmp_path / "home")}
    args = [sys.executable, "-m", "atheer_companion", "--port-range", "47931-47933", "--trust-local"]
    proc = subprocess.Popen(args, cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        _wait_health(47931, timeout=20)
        assert _get(47931, "/api/v1/capabilities")[0] == 200  # no token at all
        assert _get(47931, "/api/v1/capabilities", "anything-at-all-123")[0] == 200
        req = urllib.request.Request("http://127.0.0.1:47931/api/v1/capabilities", headers={"Origin": "https://evil.example"})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            opener.open(req, timeout=2)
            raise AssertionError("browser origin accepted")
        except urllib.error.HTTPError as e:
            assert e.code == 403
        again = subprocess.run(args, cwd=ROOT, env=env, capture_output=True, text=True, timeout=30)
        assert again.returncode == 0  # already running
    finally:
        proc.terminate()
        proc.wait(timeout=10)
