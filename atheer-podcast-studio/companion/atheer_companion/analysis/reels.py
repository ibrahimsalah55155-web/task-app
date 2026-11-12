"""Reel candidates from a transcript: authentic hooks, self-contained windows.

Everything is a transparent heuristic over what was actually said; the hook is
always a verbatim sentence. Scores are editorial estimates, not predictions
of views. Works for Egyptian/Gulf/Levantine colloquial and MSA (word lists
cover common forms of each) and for English.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Any

QUESTION_WORDS = {
    "ليه", "ليش", "لماذا", "لمذا", "إزاي", "ازاي", "كيف", "كيفاش", "هل", "إيه", "ايه", "ماذا", "شو", "وش", "متى", "امتى",
    "إمتى", "فين", "وين", "أين", "مين", "من", "كم", "قديش", "why", "how", "what", "when", "where", "who", "is", "do",
}
STRONG = {
    "أهم", "اهم", "أكبر", "اكبر", "أول", "اول", "سر", "السر", "الحقيقة", "حقيقة", "المشكلة", "مشكلة", "لازم", "أبداً",
    "ابدا", "أبدا", "دايماً", "دايما", "دائماً", "ممنوع", "خطأ", "غلط", "تخيل", "تخيّل", "صدقني", "بصراحة", "الصراحة",
    "أخطر", "اخطر", "أصعب", "اصعب", "أجمل", "اجمل", "نصيحة", "النصيحة", "never", "always", "secret", "truth", "mistake",
}
EMOTION = {
    "حب", "بحب", "خوف", "خايف", "خايفة", "ألم", "وجع", "فرح", "فرحة", "بكيت", "عيطت", "صعب", "صعبة", "أمي", "امي", "أبويا",
    "ابويا", "أبي", "الموت", "مات", "ماتت", "النجاح", "الفشل", "فشلت", "نجحت", "حلم", "الحلم", "خسرت", "قلبي", "ندمت",
    "اكتئاب", "قلق", "سعادة", "حزن", "love", "fear", "cried", "failed", "dream", "lost", "happy",
}
CONNECTORS = {"و", "ف", "لكن", "بس", "عشان", "علشان", "لذلك", "يعني", "وبعدين", "فـ", "ثم", "كمان", "برضه", "and", "but", "so",
              "because", "then"}
ANAPHORA = {"هو", "هي", "ده", "دي", "دا", "ذلك", "هذا", "هذه", "هيك", "it", "this", "that", "they"}
BACKREF = ("زي ما قلت", "زي ما قلنا", "قلت قبل", "اللي قلناه", "كما ذكرت", "as i said", "like i said")
STOP = {"في", "من", "على", "إلى", "الى", "عن", "مع", "أن", "ان", "إن", "اللي", "الذي", "التي", "كان", "يكون", "هو", "هي",
        "ده", "دي", "يعني", "بس", "و", "ما", "لا", "مش", "the", "a", "to", "of", "and", "in", "is", "it", "that"}

_AR_STRIP = re.compile(r"[ً-ْـ]")


def norm(w: str) -> str:
    w = _AR_STRIP.sub("", w.lower()).strip(".,،؟?!؛:\"'()[]")
    return w.replace("أ", "ا").replace("إ", "ا").replace("آ", "ا").replace("ة", "ه").replace("ى", "ي")


NQ = {norm(w) for w in QUESTION_WORDS}
NS = {norm(w) for w in STRONG}
NE = {norm(w) for w in EMOTION}
NC = {norm(w) for w in CONNECTORS}
NA = {norm(w) for w in ANAPHORA}
NSTOP = {norm(w) for w in STOP}


def sentences(words: list[dict[str, Any]], pause: float = 0.7) -> list[dict[str, Any]]:
    out, cur = [], []
    for w in words:
        if cur and (w["start"] - cur[-1]["end"] > pause):
            out.append(cur)
            cur = []
        cur.append(w)
        if w["word"].strip().endswith((".", "؟", "?", "!", "؛")):
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return [{"start": s[0]["start"], "end": s[-1]["end"], "text": " ".join(x["word"].strip() for x in s).strip(),
             "words": s, "speakers": Counter(x.get("speaker") for x in s)} for s in out]


def hook_score(sent: dict[str, Any]) -> tuple[float, list[str]]:
    toks = [norm(w["word"]) for w in sent["words"]]
    text = sent["text"]
    score, why = 0.0, []
    if text.endswith(("؟", "?")) or (toks and toks[0] in NQ) or any(t in NQ for t in toks[:3]):
        score += 0.35
        why.append("question")
    if any(t in NS for t in toks):
        score += 0.25
        why.append("strong claim")
    if any(t in NE for t in toks):
        score += 0.2
        why.append("emotion")
    if any(ch.isdigit() for ch in text) or any(t in {"مليون", "الف", "ألف", "مية", "مائة", "percent"} for t in toks):
        score += 0.1
        why.append("number")
    n = len(toks)
    score += 0.15 if 4 <= n <= 14 else (0.05 if n <= 20 else -0.1)
    if toks and (toks[0] in NC or toks[0] in NA):
        score -= 0.3
        why.append("starts mid-thought")
    return max(0.0, min(1.0, score)), why


def integrity_score(window: list[dict[str, Any]]) -> tuple[float, list[str]]:
    first = window[0]
    toks = [norm(w["word"]) for w in first["words"]]
    score, notes = 1.0, []
    if toks and toks[0] in NC:
        score -= 0.35
        notes.append("opens with a connector")
    if toks and toks[0] in NA:
        score -= 0.3
        notes.append("opens with a pronoun that needs context")
    full = " ".join(s["text"] for s in window).lower()
    if any(b in full for b in BACKREF):
        score -= 0.3
        notes.append("refers to something said earlier")
    last = window[-1]["text"]
    if not last.endswith((".", "؟", "?", "!", "؛")):
        score -= 0.1
    if last and norm(last.split()[-1]) in NC:
        score -= 0.25
        notes.append("ends mid-sentence")
    return max(0.0, score), notes


def find_reels(words: list[dict[str, Any]], count: int = 10, min_dur: float = 30, max_dur: float = 60) -> list[dict[str, Any]]:
    sents = sentences(words)
    if not sents:
        return []
    # distinctive vocabulary: frequent here but not filler
    vocab = Counter(t for s in sents for t in (norm(w["word"]) for w in s["words"]) if t not in NSTOP and len(t) > 2)
    total_words = sum(vocab.values()) or 1
    cands = []
    for i, s in enumerate(sents):
        j = i
        while j < len(sents) and sents[j]["end"] - s["start"] < min_dur:
            j += 1
        if j >= len(sents):
            break
        while j + 1 < len(sents) and sents[j + 1]["end"] - s["start"] <= max_dur and not sents[j]["text"].endswith(("؟", "?")):
            if sents[j]["end"] - s["start"] >= (min_dur + max_dur) / 2:
                break
            j += 1
        window = sents[i:j + 1]
        dur = window[-1]["end"] - s["start"]
        if not (min_dur * 0.9 <= dur <= max_dur * 1.05):
            continue
        hook, why = hook_score(s)
        integ, notes = integrity_score(window)
        toks = [norm(w["word"]) for x in window for w in x["words"]]
        content = [t for t in toks if t in vocab]
        relevance = min(1.0, (sum(math.log(1 + vocab[t]) for t in set(content)) / (len(set(content)) + 5)) / 2.5)
        density = len(toks) / max(dur, 1)
        relevance = 0.7 * relevance + 0.3 * min(1.0, density / 2.5)
        spk = Counter(sp for x in window for sp, c in x["speakers"].items() for _ in range(c) if sp)
        if spk and max(spk.values()) / sum(spk.values()) > 0.8:
            relevance = min(1.0, relevance + 0.05)
        overall = 0.45 * hook + 0.30 * relevance + 0.25 * integ
        title_words = s["text"].split()
        cands.append({
            "start": round(s["start"], 2), "end": round(window[-1]["end"] + 0.25, 2), "duration": round(dur, 1),
            "title": " ".join(title_words[:9]) + ("…" if len(title_words) > 9 else ""),
            "hook": s["text"], "transcript": " ".join(x["text"] for x in window),
            "scores": {"hook": round(hook * 100), "relevance": round(relevance * 100), "context": round(integ * 100),
                       "overall": round(overall * 100)},
            "why": why, "notes": notes,
        })
    cands.sort(key=lambda c: -c["scores"]["overall"])
    chosen: list[dict[str, Any]] = []
    for c in cands:
        if all(min(c["end"], o["end"]) - max(c["start"], o["start"]) < 0.2 * c["duration"] for o in chosen):
            chosen.append(c)
        if len(chosen) >= count:
            break
    return chosen
