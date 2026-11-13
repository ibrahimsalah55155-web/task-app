"""Collect the offline models that ship inside the .ccx (run on the CI Linux machine).

  python installer/fetch_models.py --out build-models

Produces:
  diarization/segmentation.onnx   pyannote segmentation-3.0 (MIT), sherpa-onnx export
  diarization/embedding.onnx      3D-Speaker ERes2Net base speaker embedding (Apache-2.0)
  mt/ar-en/                       OPUS-MT Arabic->English (CC-BY 4.0), CTranslate2 int8 + SentencePiece
  mt/en-ar/                       OPUS-MT English->Arabic (CC-BY 4.0), needs the ">>ara<<" target token
  NOTICE.txt                      attributions

Translation models are converted with CTranslate2's converter (needs transformers, torch,
sentencepiece at build time only; the plugin itself only needs ctranslate2 + sentencepiece).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

SHERPA = "k2-fsa/sherpa-onnx"
SEG_TAG, SEG_ASSET = "speaker-segmentation-models", "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
EMB_TAG, EMB_ASSET = "speaker-recongition-models", "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
MT = {"ar-en": ("Helsinki-NLP/opus-mt-ar-en", None), "en-ar": ("Helsinki-NLP/opus-mt-en-ar", ">>ara<<")}

NOTICE = """Models bundled with Multimedia & AI Group (all run locally, offline)

Speaker separation (engine/models/diarization)
  segmentation.onnx: pyannote/segmentation-3.0, MIT License, (c) CNRS / pyannote.audio authors;
                     ONNX export by the sherpa-onnx project (Apache-2.0).
  embedding.onnx:    3D-Speaker ERes2Net base (iic/speech_eres2net_base_sv_zh-cn_3dspeaker_16k),
                     Apache-2.0, (c) Alibaba DAMO Academy; ONNX export by sherpa-onnx.

Translation (engine/models/mt)
  ar-en, en-ar: OPUS-MT by Helsinki-NLP (Tiedemann & Thottingal, "OPUS-MT - Building open translation
  services for the World", EAMT 2020), CC-BY 4.0. Converted to CTranslate2 int8; weights otherwise unchanged.

Voice clean-up (inside the engine package)
  rnnoise_voice.rnnn: GregorR/rnnoise-models "beguiling-drafter" (not subject to copyright per its README).
"""


def _get(url: str, dest: Path, token: str | None = None, accept: str | None = None) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "mag-build"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if accept:
        req.add_header("Accept", accept)
    with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)


def _asset_url(tag: str, name: str, token: str | None) -> str:
    api = f"https://api.github.com/repos/{SHERPA}/releases/tags/{tag}"
    tmp = Path("_release.json")
    _get(api, tmp, token, "application/vnd.github+json")
    assets = json.loads(tmp.read_text())["assets"]
    tmp.unlink()
    for a in assets:
        if a["name"] == name:
            return a["browser_download_url"]
    raise SystemExit(f"{name} not found in {SHERPA} release {tag}; available: {[a['name'] for a in assets][:40]}")


def diarization(out: Path, token: str | None) -> None:
    d = out / "diarization"
    d.mkdir(parents=True, exist_ok=True)
    tar = out / SEG_ASSET
    _get(_asset_url(SEG_TAG, SEG_ASSET, token), tar)
    with tarfile.open(tar) as t:
        member = next(m for m in t.getmembers() if m.name.endswith("/model.onnx"))
        with t.extractfile(member) as src, open(d / "segmentation.onnx", "wb") as dst:  # type: ignore[union-attr]
            shutil.copyfileobj(src, dst)
    tar.unlink()
    _get(_asset_url(EMB_TAG, EMB_ASSET, token), d / "embedding.onnx")
    print("diarization:", sorted(p.name for p in d.iterdir()))


def translation(out: Path) -> None:
    for pair, (repo, prefix) in MT.items():
        d = out / "mt" / pair
        if d.exists():
            shutil.rmtree(d)
        subprocess.run([sys.executable, "-m", "ctranslate2.converters.transformers", "--model", repo,
                        "--output_dir", str(d), "--quantization", "int8",
                        "--copy_files", "source.spm", "target.spm"], check=True)
        (d / "mag.json").write_text(json.dumps({"prefix": prefix, "source": repo, "license": "CC-BY-4.0"}))
        print(pair, sorted(p.name for p in d.iterdir()))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="build-models")
    ap.add_argument("--skip-mt", action="store_true")
    a = ap.parse_args()
    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    token = os.environ.get("GITHUB_TOKEN")
    if not (out / "diarization" / "embedding.onnx").is_file():
        diarization(out, token)
    if not a.skip_mt:
        translation(out)
    (out / "NOTICE.txt").write_text(NOTICE)


if __name__ == "__main__":
    main()
