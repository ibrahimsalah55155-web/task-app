from __future__ import annotations

import base64
import io
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

from atheer_companion.graphics.render import draw_frame, render_video
from atheer_companion.graphics.templates import TEMPLATES
from atheer_companion.graphics.text import direction_runs, shape_line, word_spans

from .conftest import FFMPEG, needs_ffmpeg
from .test_api import wait_job


def test_bidi_runs_keep_english_and_numbers_left_to_right():
    base, runs = direction_runs("حط In و Out على التايم لاين")
    assert base == "rtl"
    assert [d for d, _ in runs] == ["rtl", "ltr", "rtl", "ltr", "rtl"]
    assert direction_runs("Multimedia & AI Group")[0] == "ltr"
    assert [s for d, s in direction_runs("الحلقة 12 من 2026")[1] if d == "ltr"] == ["12", "2026"]


def test_arabic_is_shaped_not_isolated_letters():
    # Joined (shaped) Arabic is much narrower than the same letters drawn in isolation.
    joined = shape_line("حياتك", 64).width
    isolated = sum(shape_line(ch, 64).width for ch in "حياتك")
    assert joined < isolated * 0.8


def test_words_are_ordered_right_to_left_in_arabic():
    text = "أنشطة جماعية"
    spans = word_spans(text, shape_line(text, 60))
    assert len(spans) == 2
    assert spans[0][0] > spans[1][1]  # first word is on the right


def test_every_template_draws_something_at_its_hold_time_in_both_orientations():
    for tid, tpl in TEMPLATES.items():
        for w, h in ((1080, 1920), (1920, 1080)):
            f = draw_frame(tid, {}, w, h, tpl.hold_time(tpl.default_duration))
            alpha = f.to_rgba8()[..., 3]
            assert alpha.max() == 255, (tid, w, h)
            if not tpl.full_frame:
                # overlays leave most of the picture untouched
                assert (alpha > 0).mean() < 0.35, (tid, w, h)


def test_overlays_are_transparent_before_they_start():
    for tid in ("lower_third", "title_card", "emphasis", "cta"):
        assert draw_frame(tid, {}, 1080, 1920, 0.0).to_rgba8()[..., 3].max() <= 40, tid


def test_logo_replaces_the_default_icon(tmp_path):
    logo = tmp_path / "logo.png"
    Image.new("RGBA", (200, 200), (0, 255, 0, 255)).save(logo)
    f = draw_frame("lower_third", {}, 1080, 1920, 3.0, opts={"icon": str(logo)})
    px = f.to_rgba8()
    green = (px[..., 1] > 200) & (px[..., 0] < 80) & (px[..., 3] > 200)
    assert green.sum() > 200


@needs_ffmpeg
def test_render_prores_4444_with_alpha_and_cache(tmp_path):
    r = render_video(FFMPEG, "caption", {"text": "اختبار", "speaker": "host"}, 540, 960, 25, 0.4, tmp_path)
    out = Path(r["path"])
    assert out.is_file() and r["frames"] == 10 and not r["cached"]
    meta = json.loads(out.with_suffix(".json").read_text(encoding="utf-8"))
    assert meta["fields"]["text"] == "اختبار"
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,pix_fmt,nb_frames",
                            "-of", "json", str(out)], capture_output=True, text=True, check=True)
    st = json.loads(probe.stdout)["streams"][0]
    assert st["codec_name"] == "prores" and st["pix_fmt"].startswith("yuva444")
    again = render_video(FFMPEG, "caption", {"text": "اختبار", "speaker": "host"}, 540, 960, 25, 0.4, tmp_path)
    assert again["cached"] and again["path"] == r["path"]


def test_api_lists_templates_and_previews(authed):
    tpls = authed.get("/api/v1/graphics/templates").json()["templates"]
    ids = {t["id"] for t in tpls}
    assert {"lower_third", "title_card", "emphasis", "caption", "cta", "outro"} <= ids
    lt = next(t for t in tpls if t["id"] == "lower_third")
    assert lt["title"]["ar"] == "اسم الضيف"
    r = authed.post("/api/v1/graphics/preview", json={"template": "lower_third", "fields": {"name": "د. سارة"}})
    img = Image.open(io.BytesIO(base64.b64decode(r.json()["png"])))
    assert img.size == (360, 640) and np.asarray(img)[..., 3].max() == 255
    assert authed.post("/api/v1/graphics/preview", json={"template": "nope"}).status_code == 400


@needs_ffmpeg
def test_api_render_job(authed, tmp_path):
    r = authed.post("/api/v1/jobs/render_graphic", json={"template": "emphasis", "fields": {"text": "كلمة"},
                                                          "width": 540, "height": 960, "duration": 0.4,
                                                          "outDir": str(tmp_path / "MAG Graphics")})
    job = wait_job(authed, r.json()["job"]["id"], timeout=120)
    assert job["state"] == "succeeded", job
    assert Path(job["result"]["path"]).parent == tmp_path / "MAG Graphics"


@needs_ffmpeg
def test_ntsc_rates_are_exact(tmp_path):
    r = render_video(FFMPEG, "caption", {}, 320, 568, 29.97, 1.0, tmp_path)
    rate = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0",
                           r["path"]], capture_output=True, text=True, check=True).stdout.strip()
    assert rate == "30000/1001" and r["frames"] == 30
