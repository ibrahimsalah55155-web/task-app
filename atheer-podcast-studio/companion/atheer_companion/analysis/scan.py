"""Podcast folder scan: find the camera and microphone files and guess who is who.

The editor points at the shoot folder; every media file inside (any depth) is probed and
given a role from its name and folder (guest/host/wide, Arabic or English, camera letters,
recorder track names). Files recorded in parts (split by the camera at 4 GB / 30 min) stay
together because they share a folder. Whatever cannot be guessed gets the most likely
remaining role; the editor corrects it in the panel before syncing.
"""

from __future__ import annotations

import re
import threading
from pathlib import Path
from typing import Any, Callable

from ..media import probe_file

VIDEO_EXT = {"mov", "mp4", "mxf", "m4v", "avi", "mts", "m2ts", "mkv", "braw", "r3d", "crm"}
AUDIO_EXT = {"wav", "bwf", "mp3", "m4a", "aac", "aif", "aiff", "flac"}
SKIP_DIRS = {"mag captions", "mag graphics", "mag clean audio", "mag colour", "adobe premiere pro auto-save",
             "adobe premiere pro video previews", "adobe premiere pro audio previews", "proxies", "proxy",
             "__macosx", ".git"}

WORDS = {
    "guest": ["guest", "ضيف", "الضيف", "dayf", "daif"],
    "host": ["host", "مذيع", "المذيع", "مقدم", "anchor", "presenter", "interviewer"],
    "wide": ["wide", "وايد", "واسع", "master", "ws", "general", "عام"],
}


def _has(text: str, words: list[str]) -> bool:
    t = text.lower()
    for w in words:
        if re.search(r"[a-z]", w):
            if re.search(rf"(^|[^a-z]){re.escape(w)}([^a-z]|$)", t):
                return True
        elif w in t:
            return True
    return False


def _who(text: str) -> str | None:
    for who in ("guest", "host", "wide"):
        if _has(text, WORDS[who]):
            return who
    return None


def scan_folder(ffprobe: str | None, root: str, progress: Callable[[float, str], None] | None = None,
                cancel: threading.Event | None = None, limit: int = 400) -> dict[str, Any]:
    prog = progress or (lambda f, m: None)
    base = Path(root)
    if not base.is_dir():
        raise ValueError(f"Not a folder: {root}")
    files: list[Path] = []
    for p in sorted(base.rglob("*"), key=lambda x: str(x).lower()):
        if any(part.lower() in SKIP_DIRS for part in p.relative_to(base).parts[:-1]):
            continue
        if p.is_file() and not p.name.startswith(".") and p.suffix.lower().lstrip(".") in VIDEO_EXT | AUDIO_EXT:
            files.append(p)
        if len(files) >= limit:
            break
    items: list[dict[str, Any]] = []
    for i, p in enumerate(files):
        if cancel is not None and cancel.is_set():
            raise RuntimeError("cancelled")
        prog(i / max(1, len(files)), f"Reading {p.name}")
        try:
            info = probe_file(ffprobe, str(p))
        except Exception as e:  # noqa: BLE001
            items.append({"path": str(p), "kind": "unknown", "error": str(e)})
            continue
        kind = info.get("kind", "unknown")
        if kind == "unknown":
            continue
        items.append({"path": str(p), "kind": kind, "duration": info.get("duration"),
                      "hasAudio": bool(info.get("audio")), "timecode": info.get("timecode"),
                      "group": str(p.parent.relative_to(base)) if p.parent != base else ""})
    assign_roles(items, base)
    prog(1.0, "Done")
    return {"root": str(base), "items": items}


def assign_roles(items: list[dict[str, Any]], base: Path) -> None:
    """Role per file: from names first, then the most likely free role, per folder group."""
    def label(it: dict[str, Any]) -> str:
        return f"{it.get('group', '')}/{Path(it['path']).stem}"

    # Groups: same folder + same kind (a camera card, a recorder).
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for it in items:
        if it["kind"] in ("video", "audio"):
            groups.setdefault((it["kind"], it.get("group", "")), []).append(it)

    used: set[str] = set()
    pending: list[tuple[str, list[dict[str, Any]]]] = []
    for (kind, _g), members in groups.items():
        # Name decides per file when the folder is shared by several cameras/mics.
        decided = []
        for it in members:
            who = _who(label(it))
            if who:
                it["role"] = f"{who}_{'cam' if kind == 'video' else 'mic'}" if who != "wide" or kind == "video" else "extra"
                it["reason"] = "name"
                used.add(it["role"])
                decided.append(it)
        rest = [it for it in members if it not in decided]
        if rest:
            pending.append((kind, rest))

    # Undecided files: one role per remaining file-name stem family (split recordings share a prefix).
    order = {"video": ["host_cam", "guest_cam", "wide_cam"], "audio": ["guest_mic", "host_mic"]}
    for kind, members in pending:
        fams: dict[str, list[dict[str, Any]]] = {}
        for it in members:
            name = Path(it["path"]).stem.lower()
            if kind == "audio":
                # Recorder tracks (TR1, TR2, Track 1, CH2, MIC 1) are different people.
                m = re.search(r"(tr|track|ch|mic|input)[\s_\-]*(\d+)", name)
                key = f"track{m.group(2)}" if m else name
            else:
                # Camera clips split by the camera (C0001, C0002 ...) are the same camera.
                key = re.sub(r"[_\-\s]*\d+$", "", name) or name
            fams.setdefault(f"{it.get('group', '')}|{key}", []).append(it)
        for fam in fams.values():
            free = [r for r in order[kind] if r not in used]
            role = free[0] if free else ("extra" if kind == "audio" else order[kind][-1])
            used.add(role)
            for it in fam:
                it["role"] = role
                it["reason"] = "guess"
