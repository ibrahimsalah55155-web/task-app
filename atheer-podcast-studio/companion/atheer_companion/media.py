"""FFmpeg/FFprobe discovery and media inspection.

`probe_file` returns a normalised description of one file: container, video
and audio streams, frame rate as an exact rational, embedded timecode and a
list of warnings that matter for multicam podcast sync.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

# Bump when the shape or meaning of probe results changes, to invalidate caches.
PROBE_ANALYSER_VERSION = "probe-1"

_TC_RE = re.compile(r"^\d{1,2}[:;.]\d{2}[:;.]\d{2}[:;.]\d{2,3}$")


class ToolMissing(RuntimeError):
    pass


class Cancelled(RuntimeError):
    pass


@dataclass
class Tools:
    ffmpeg: str | None
    ffprobe: str | None
    ffmpeg_version: str | None
    ffprobe_version: str | None


def _bundled_bin_dir() -> Path:
    # installer/ puts static ffmpeg builds in <companion>/bin when the user has none.
    return Path(__file__).resolve().parent.parent / "bin"


def _find(name: str, explicit: str | None, env_var: str) -> str | None:
    for candidate in (explicit, os.environ.get(env_var)):
        if candidate and Path(candidate).is_file():
            return str(Path(candidate))
    exe = name + (".exe" if sys.platform == "win32" else "")
    bundled = _bundled_bin_dir() / exe
    if bundled.is_file():
        return str(bundled)
    return shutil.which(name)


def _version_line(binary: str) -> str | None:
    try:
        out = subprocess.run(
            [binary, "-hide_banner", "-version"], capture_output=True, text=True, timeout=15
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    first = (out.stdout or "").splitlines()
    return first[0].strip() if first else None


def discover_tools(ffmpeg: str | None = None, ffprobe: str | None = None) -> Tools:
    ffm = _find("ffmpeg", ffmpeg, "ATHEER_FFMPEG")
    ffp = _find("ffprobe", ffprobe, "ATHEER_FFPROBE")
    return Tools(
        ffmpeg=ffm,
        ffprobe=ffp,
        ffmpeg_version=_version_line(ffm) if ffm else None,
        ffprobe_version=_version_line(ffp) if ffp else None,
    )


def parse_rational(value: str | None) -> Fraction | None:
    """'30000/1001' -> Fraction(30000, 1001). '0/0' and junk -> None."""
    if not value:
        return None
    try:
        if "/" in value:
            num, den = value.split("/", 1)
            n, d = int(num), int(den)
            if n <= 0 or d <= 0:
                return None
            return Fraction(n, d)
        f = Fraction(value)
        return f if f > 0 else None
    except (ValueError, ZeroDivisionError):
        return None


def _rational_json(fr: Fraction | None) -> dict[str, Any] | None:
    if fr is None:
        return None
    return {"num": fr.numerator, "den": fr.denominator, "value": round(float(fr), 6)}


def _float(value: Any) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # drop NaN


def _find_timecode(data: dict[str, Any]) -> tuple[str | None, str | None]:
    """Embedded start timecode and where it was found."""
    for stream in data.get("streams", []):
        tc = (stream.get("tags") or {}).get("timecode")
        if tc and _TC_RE.match(tc):
            kind = "tmcd" if stream.get("codec_tag_string") == "tmcd" else stream.get("codec_type", "stream")
            return tc, f"{kind} stream #{stream.get('index')}"
    tc = ((data.get("format") or {}).get("tags") or {}).get("timecode")
    if tc and _TC_RE.match(tc):
        return tc, "container"
    return None, None


def normalise_probe(path: str, data: dict[str, Any], size: int) -> dict[str, Any]:
    fmt = data.get("format") or {}
    streams = data.get("streams") or []
    video: list[dict[str, Any]] = []
    audio: list[dict[str, Any]] = []
    warnings: list[dict[str, str]] = []

    for s in streams:
        ctype = s.get("codec_type")
        disposition = s.get("disposition") or {}
        if ctype == "video" and not disposition.get("attached_pic"):
            r = parse_rational(s.get("r_frame_rate"))
            avg = parse_rational(s.get("avg_frame_rate"))
            vfr = bool(r and avg and abs(float(r) - float(avg)) / float(r) > 0.002)
            rotation = 0
            for sd in s.get("side_data_list") or []:
                if "rotation" in sd:
                    rotation = int(_float(sd.get("rotation")) or 0)
            video.append({
                "index": s.get("index"),
                "codec": s.get("codec_name"),
                "profile": s.get("profile"),
                "width": s.get("width"),
                "height": s.get("height"),
                "pixFmt": s.get("pix_fmt"),
                "frameRate": _rational_json(r),
                "avgFrameRate": _rational_json(avg),
                "variableFrameRate": vfr,
                "fieldOrder": s.get("field_order"),
                "rotation": rotation,
                "duration": _float(s.get("duration")),
                "startTime": _float(s.get("start_time")),
            })
        elif ctype == "audio":
            audio.append({
                "index": s.get("index"),
                "codec": s.get("codec_name"),
                "sampleRate": int(s["sample_rate"]) if str(s.get("sample_rate", "")).isdigit() else None,
                "channels": s.get("channels"),
                "channelLayout": s.get("channel_layout"),
                "bitsPerSample": s.get("bits_per_raw_sample") or s.get("bits_per_sample") or None,
                "duration": _float(s.get("duration")),
                "startTime": _float(s.get("start_time")),
                "language": (s.get("tags") or {}).get("language"),
            })

    timecode, tc_source = _find_timecode(data)
    duration = _float(fmt.get("duration"))
    if duration is None:
        durations = [d for d in (x.get("duration") for x in video + audio) if d]
        duration = max(durations) if durations else None

    kind = "video" if video else ("audio" if audio else "unknown")
    if kind == "unknown":
        warnings.append({"code": "no_av_streams", "message": "No audio or video streams found."})
    if video and not audio:
        warnings.append({
            "code": "no_audio",
            "message": "Video has no audio stream. It cannot be synced by waveform; "
                       "timecode or manual offset is required.",
        })
    if any(v["variableFrameRate"] for v in video):
        warnings.append({
            "code": "variable_frame_rate",
            "message": "Variable frame rate detected (phone/screen recording?). "
                       "Sync can drift; transcoding to constant frame rate is recommended.",
        })
    if video and not timecode:
        warnings.append({
            "code": "no_timecode",
            "message": "No embedded timecode. Sync will rely on audio waveform matching.",
        })
    if duration is not None and duration <= 0:
        warnings.append({"code": "zero_duration", "message": "File reports zero duration."})

    return {
        "path": path,
        "name": Path(path).name,
        "sizeBytes": size,
        "kind": kind,
        "container": fmt.get("format_name"),
        "containerLongName": fmt.get("format_long_name"),
        "duration": duration,
        "startTime": _float(fmt.get("start_time")),
        "bitRate": int(fmt["bit_rate"]) if str(fmt.get("bit_rate", "")).isdigit() else None,
        "creationTime": (fmt.get("tags") or {}).get("creation_time"),
        "timecode": timecode,
        "timecodeSource": tc_source,
        "video": video,
        "audio": audio,
        "warnings": warnings,
    }


def _run_cancellable(cmd: list[str], timeout: float, cancel: threading.Event | None) -> subprocess.CompletedProcess:
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            encoding="utf-8", errors="replace")
    result: dict[str, Any] = {}

    def _communicate() -> None:
        result["out"], result["err"] = proc.communicate()

    t = threading.Thread(target=_communicate, daemon=True)
    t.start()
    waited = 0.0
    step = 0.1
    while t.is_alive():
        t.join(step)
        waited += step
        if cancel is not None and cancel.is_set():
            proc.kill()
            t.join(5)
            raise Cancelled("cancelled")
        if waited >= timeout:
            proc.kill()
            t.join(5)
            raise TimeoutError(f"{Path(cmd[0]).name} timed out after {timeout:.0f}s")
    return subprocess.CompletedProcess(cmd, proc.returncode, result.get("out", ""), result.get("err", ""))


def probe_file(ffprobe: str | None, path: str, timeout: float = 120.0,
               cancel: threading.Event | None = None) -> dict[str, Any]:
    """Probe one file. Raises FileNotFoundError, ToolMissing, Cancelled, TimeoutError, ValueError."""
    if not ffprobe:
        raise ToolMissing("ffprobe was not found. Run the installer or set ATHEER_FFPROBE.")
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(f"File not found or drive disconnected: {path}")
    size = p.stat().st_size
    cmd = [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(p)]
    out = _run_cancellable(cmd, timeout, cancel)
    if out.returncode != 0:
        msg = (out.stderr or "").strip().splitlines()
        raise ValueError(f"ffprobe could not read the file: {msg[-1] if msg else 'unknown error'}")
    try:
        data = json.loads(out.stdout or "{}")
    except json.JSONDecodeError as e:
        raise ValueError(f"ffprobe returned invalid JSON: {e}") from e
    return normalise_probe(str(p), data, size)
