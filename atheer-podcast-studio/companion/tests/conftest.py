from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from atheer_companion.app import create_app
from atheer_companion.auth import Auth
from atheer_companion.config import Config
from atheer_companion.store import Store

BASE = "http://127.0.0.1:47820"
FFMPEG = shutil.which("ffmpeg")

needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not installed")


def _ff(*args: str) -> None:
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


@pytest.fixture(scope="session")
def media(tmp_path_factory) -> dict[str, Path]:
    """Small synthetic files that mimic a podcast shoot."""
    if FFMPEG is None:
        pytest.skip("ffmpeg not installed")
    d = tmp_path_factory.mktemp("media")
    files = {
        # 25 fps camera with embedded timecode and 48 kHz audio
        "cam_tc": d / "CAM_A_0001.mov",
        # 29.97 fps camera, 44.1 kHz audio, no timecode
        "cam_2997": d / "CAM_B_0001.mp4",
        # video without audio
        "cam_silent": d / "CAM_C_noaudio.mp4",
        # external recorder track
        "wav": d / "ZOOM_TR1.wav",
        # same file name in another folder (camera cards)
        "dupe": d / "card2" / "CAM_A_0001.mov",
        # not media at all
        "junk": d / "notes.mov",
    }
    _ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-f", "lavfi", "-i", "sine=f=440:sample_rate=48000",
        "-t", "2", "-c:v", "mpeg4", "-c:a", "pcm_s16le", "-timecode", "10:00:00:00", "-shortest", str(files["cam_tc"]))
    _ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30000/1001", "-f", "lavfi",
        "-i", "sine=f=330:sample_rate=44100", "-t", "2", "-c:v", "mpeg4", "-c:a", "aac", "-shortest",
        str(files["cam_2997"]))
    _ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-t", "1", "-c:v", "mpeg4", str(files["cam_silent"]))
    _ff("-f", "lavfi", "-i", "sine=f=220:sample_rate=48000", "-t", "2", "-c:a", "pcm_s24le", str(files["wav"]))
    files["dupe"].parent.mkdir()
    shutil.copy(files["cam_tc"], files["dupe"])
    files["junk"].write_text("this is not a video")
    return files


@pytest.fixture()
def config(tmp_path) -> Config:
    return Config(data_dir=tmp_path / "data")


@pytest.fixture()
def app_bundle(config):
    store = Store(config.db_path)
    auth = Auth(store, pairing_code="ABC234")
    app = create_app(config, store=store, auth=auth)
    yield app, store, auth
    app.state.jobs.shutdown()
    store.close()


@pytest.fixture()
def client(app_bundle):
    app, _, _ = app_bundle
    with TestClient(app, base_url=BASE) as c:
        yield c


@pytest.fixture()
def token(client) -> str:
    r = client.post("/api/v1/pair", json={"code": "abc-234", "client": "pytest"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture()
def authed(client, token):
    client.headers["Authorization"] = f"Bearer {token}"
    return client
