from __future__ import annotations

import time

from fastapi.testclient import TestClient

from atheer_companion import API_VERSION
from atheer_companion.app import origin_allowed

from .conftest import BASE, needs_ffmpeg


def wait_job(client, job_id: str, timeout: float = 30.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/v1/jobs/{job_id}").json()["job"]
        if job["state"] in {"succeeded", "failed", "cancelled"}:
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_health_is_public(client):
    r = client.get("/api/v1/health")
    assert r.status_code == 200
    body = r.json()
    assert body["service"] == "atheer-companion"
    assert body["apiVersion"] == API_VERSION


def test_protected_routes_need_token(client):
    for path in ("/api/v1/capabilities", "/api/v1/jobs", "/api/v1/logs"):
        r = client.get(path)
        assert r.status_code == 401
        assert r.json()["error"]["code"] == "unauthorized"
    r = client.get("/api/v1/capabilities", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


def test_pairing_code_is_single_use_and_normalised(client, app_bundle):
    _, _, auth = app_bundle
    r = client.post("/api/v1/pair", json={"code": " abc 234 ", "client": "p1"})
    assert r.status_code == 200
    assert auth.pairing_code != "ABC234"  # rotated after use
    r2 = client.post("/api/v1/pair", json={"code": "ABC234"})
    assert r2.status_code == 403


def test_pairing_lockout_after_repeated_failures(client):
    for _ in range(7):
        assert client.post("/api/v1/pair", json={"code": "ZZZZZZ"}).status_code == 403
    r = client.post("/api/v1/pair", json={"code": "ZZZZZZ"})
    assert r.status_code == 403
    # now locked out, even the old correct code is refused (and it has been rotated)
    r = client.post("/api/v1/pair", json={"code": "ABC234"})
    assert r.status_code == 429
    assert "Retry-After" in r.headers


def test_token_survives_restart(config, token, app_bundle):
    # A new app instance on the same database accepts the old token.
    from atheer_companion.app import create_app
    from atheer_companion.store import Store

    store2 = Store(config.db_path)
    app2 = create_app(config, store=store2)
    with TestClient(app2, base_url=BASE) as c:
        r = c.get("/api/v1/capabilities", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200
    app2.state.jobs.shutdown()
    store2.close()


def test_non_loopback_host_rejected(app_bundle):
    app, _, _ = app_bundle
    with TestClient(app, base_url="http://evil.example:47820") as c:
        assert c.get("/api/v1/health").status_code == 421


def test_web_origins_rejected_but_uxp_like_allowed(client):
    r = client.get("/api/v1/health", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "origin_rejected"
    for origin in (None, "null", "uxp://com.atheer.podcaststudio", "file://"):
        headers = {"Origin": origin} if origin else {}
        r = client.get("/api/v1/health", headers=headers)
        assert r.status_code == 200, origin
        if origin:
            assert r.headers["access-control-allow-origin"] == origin
    pre = client.options("/api/v1/pair", headers={"Origin": "null"})
    assert pre.status_code == 204


def test_origin_policy_unit():
    assert origin_allowed(None, ())
    assert not origin_allowed("http://localhost:3000", ())
    assert origin_allowed("http://localhost:3000", ("http://localhost:3000",))


def test_capabilities_report_tools_and_modules(authed):
    caps = authed.get("/api/v1/capabilities").json()
    assert "ffprobe" in caps["tools"]
    assert "faster_whisper" in caps["modules"]
    assert {"probe", "render_graphic", "sync", "silence", "director", "transcribe", "render_captions", "faces"} <= set(caps["jobKinds"])


@needs_ffmpeg
def test_probe_job_end_to_end(authed, media, tmp_path):
    paths = [str(media[k]) for k in ("cam_tc", "cam_2997", "cam_silent", "wav", "dupe", "junk")]
    missing = str(tmp_path / "unplugged_drive" / "CAM_D.mov")
    r = authed.post("/api/v1/jobs/probe", json={"paths": paths + [missing, paths[0]]})
    assert r.status_code == 202
    job = wait_job(authed, r.json()["job"]["id"])
    assert job["state"] == "succeeded", job
    items = {i["path"]: i for i in job["result"]["items"]}
    assert len(items) == 7  # duplicate path collapsed

    tc = items[paths[0]]["info"]
    assert tc["kind"] == "video"
    assert tc["timecode"] == "10:00:00:00"
    assert tc["video"][0]["frameRate"] == {"num": 25, "den": 1, "value": 25.0}
    assert tc["audio"][0]["sampleRate"] == 48000

    ntsc = items[paths[1]]["info"]
    assert (ntsc["video"][0]["frameRate"]["num"], ntsc["video"][0]["frameRate"]["den"]) == (30000, 1001)
    assert any(w["code"] == "no_timecode" for w in ntsc["warnings"])

    silent = items[paths[2]]["info"]
    assert any(w["code"] == "no_audio" for w in silent["warnings"])

    wav = items[paths[3]]["info"]
    assert wav["kind"] == "audio" and wav["audio"][0]["sampleRate"] == 48000

    assert items[paths[5]]["ok"] is False and items[paths[5]]["error"]["code"] == "unreadable"
    assert items[missing]["ok"] is False and items[missing]["error"]["code"] == "missing"

    codes = {w["code"] for w in job["result"]["summary"]["warnings"]}
    assert {"mixed_frame_rates", "mixed_sample_rates", "duplicate_filenames", "missing_media"} <= codes

    # Second run is served from the cache.
    r2 = authed.post("/api/v1/jobs/probe", json={"paths": paths[:4]})
    job2 = wait_job(authed, r2.json()["job"]["id"])
    assert job2["result"]["cacheHits"] == 4


@needs_ffmpeg
def test_cache_invalidated_when_file_changes(authed, media, tmp_path):
    import shutil

    f = tmp_path / "clip.wav"
    shutil.copy(media["wav"], f)
    j1 = wait_job(authed, authed.post("/api/v1/jobs/probe", json={"paths": [str(f)]}).json()["job"]["id"])
    assert j1["result"]["cacheHits"] == 0
    shutil.copy(media["cam_tc"], f)  # replaced with different content
    j2 = wait_job(authed, authed.post("/api/v1/jobs/probe", json={"paths": [str(f)]}).json()["job"]["id"])
    assert j2["result"]["cacheHits"] == 0
    assert j2["result"]["items"][0]["info"]["kind"] == "video"


def test_bad_probe_request(authed):
    assert authed.post("/api/v1/jobs/probe", json={"paths": []}).status_code == 422
    assert authed.get("/api/v1/jobs/doesnotexist").status_code == 404


def test_websocket_requires_token_and_streams_events(client, token, media):
    from starlette.websockets import WebSocketDisconnect

    try:
        with client.websocket_connect("ws://127.0.0.1:47820/api/v1/events?token=wrong") as ws:
            ws.receive_json()
        raise AssertionError("expected close")
    except WebSocketDisconnect as e:
        assert e.code == 4401

    with client.websocket_connect(f"ws://127.0.0.1:47820/api/v1/events?token={token}") as ws:
        assert ws.receive_json()["type"] == "hello"
        client.post("/api/v1/jobs/probe", json={"paths": [str(media["wav"])]},
                    headers={"Authorization": f"Bearer {token}"})
        states = []
        for _ in range(50):
            ev = ws.receive_json()
            if ev["type"] == "job":
                states.append(ev["job"]["state"])
                if ev["job"]["state"] == "succeeded":
                    assert ev["job"]["result"]["items"][0]["ok"]
                    break
        assert states[0] == "queued" and states[-1] == "succeeded"


def test_logs_endpoint(authed):
    r = authed.get("/api/v1/logs?tail=5")
    assert r.status_code == 200 and isinstance(r.json()["lines"], list)
