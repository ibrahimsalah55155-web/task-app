"""Caption translation (Arabic <-> English), offline.

OPUS-MT models (Helsinki-NLP, CC-BY 4.0) converted to CTranslate2 int8 and
bundled under engine/models/mt/<src>-<tgt>/ (model.bin + source.spm +
target.spm). No internet, no key.

Captions are translated as whole sentences (fragments translate badly), then
the translation is spread back over the sentence's caption slots in
proportion to the original text length, split at word boundaries, so every
caption keeps its exact on-screen time.
"""

from __future__ import annotations

import re
import threading
from typing import Any, Callable, Protocol

from . import modelpaths

PAIRS = {("ar", "en"), ("en", "ar")}
_END = re.compile(r"[.!?؟。…]$")


class TranslateError(RuntimeError):
    pass


class Translator(Protocol):
    def __call__(self, texts: list[str]) -> list[str]: ...


def model_dir(src: str, tgt: str):
    return modelpaths.find("mt", f"{src}-{tgt}")


def available_pairs() -> list[str]:
    return sorted(f"{s}-{t}" for s, t in PAIRS if model_dir(s, t) is not None)


class OpusMT:
    _cache: dict[str, Any] = {}
    _lock = threading.Lock()

    def __init__(self, src: str, tgt: str) -> None:
        if (src, tgt) not in PAIRS:
            raise TranslateError(f"No model for {src} → {tgt}")
        d = model_dir(src, tgt)
        if d is None:
            raise TranslateError(f"Translation model {src}-{tgt} is missing from the plugin. Reinstall the .ccx.")
        self.dir = d
        self.prefix: str | None = None
        meta = d / "mag.json"
        if meta.is_file():
            import json

            self.prefix = json.loads(meta.read_text(encoding="utf-8")).get("prefix")  # e.g. ">>ara<<"

    def _load(self):
        import os

        import ctranslate2
        import sentencepiece as spm

        key = str(self.dir)
        with self._lock:
            if key not in self._cache:
                tr = ctranslate2.Translator(str(self.dir), device="cpu", compute_type="int8",
                                            intra_threads=max(1, (os.cpu_count() or 4) - 1))
                self._cache[key] = (tr, spm.SentencePieceProcessor(model_file=str(self.dir / "source.spm")),
                                    spm.SentencePieceProcessor(model_file=str(self.dir / "target.spm")))
            return self._cache[key]

    def __call__(self, texts: list[str]) -> list[str]:
        tr, sp_src, sp_tgt = self._load()
        head = [self.prefix] if self.prefix else []
        toks = [head + sp_src.encode(t, out_type=str) + ["</s>"] for t in texts]
        res = tr.translate_batch(toks, beam_size=4, max_batch_size=16, max_decoding_length=256)
        out = []
        for r in res:
            pieces = [p for p in r.hypotheses[0] if p not in ("</s>", "<pad>")]
            out.append(sp_tgt.decode(pieces).strip())
        return out


def sentences(captions: list[dict[str, Any]]) -> list[list[int]]:
    """Group caption indices into sentences: end punctuation, a speaker change or a pause > 1 s."""
    groups: list[list[int]] = []
    cur: list[int] = []
    for i, c in enumerate(captions):
        if cur:
            prev = captions[cur[-1]]
            if (_END.search(prev["text"].strip()) or prev.get("speaker") != c.get("speaker")
                    or c["start"] - prev["end"] > 1.0 or len(cur) >= 6):
                groups.append(cur)
                cur = []
        cur.append(i)
    if cur:
        groups.append(cur)
    return groups


def spread(text: str, weights: list[int]) -> list[str]:
    """Split `text` at word boundaries into len(weights) parts sized like `weights` (parts may be empty
    only when there are fewer words than parts)."""
    words = text.split()
    n = len(weights)
    if n == 1:
        return [" ".join(words)]
    w = [max(1, x) for x in weights]
    total = sum(w)
    cuts: list[int] = []
    acc = 0
    for k in range(n - 1):
        acc += w[k]
        c = round(acc / total * len(words))
        lo = (cuts[-1] if cuts else 0) + (1 if len(words) >= n else 0)
        hi = len(words) - (n - 1 - k) if len(words) >= n else len(words)
        cuts.append(max(lo, min(c, hi)))
    bounds = [0, *cuts, len(words)]
    return [" ".join(words[bounds[i]:bounds[i + 1]]) for i in range(n)]


def translate_captions(captions: list[dict[str, Any]], src: str, tgt: str, translator: Translator | None = None,
                       progress: Callable[[float, str], None] | None = None,
                       cancel: threading.Event | None = None) -> list[dict[str, Any]]:
    prog = progress or (lambda f, m: None)
    tr = translator or OpusMT(src, tgt)
    groups = sentences(captions)
    out = [dict(c) for c in captions]
    batch = 24
    for b in range(0, len(groups), batch):
        if cancel is not None and cancel.is_set():
            raise TranslateError("cancelled")
        gs = groups[b:b + batch]
        texts = [" ".join(captions[i]["text"].strip() for i in g) for g in gs]
        done = tr(texts)
        for g, t in zip(gs, done):
            parts = spread(t, [len(captions[i]["text"]) for i in g])
            for i, p in zip(g, parts):
                out[i]["text"] = p
                out[i]["source"] = captions[i]["text"]
                out[i]["lang"] = tgt
                out[i].pop("words", None)
                out[i].pop("lowConfidence", None)
        prog(min(1.0, (b + len(gs)) / max(1, len(groups))), "Translating")
    # A short translation can leave a slot empty: the previous caption stays up instead.
    final: list[dict[str, Any]] = []
    for c in out:
        if c["text"].strip():
            final.append(c)
        elif final:
            final[-1]["end"] = c["end"]
    return final
