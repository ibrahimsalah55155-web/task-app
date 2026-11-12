"""`probe` job: inspect a set of media files and report set-level problems."""

from __future__ import annotations

import os
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable

from .jobs import JobContext
from .media import PROBE_ANALYSER_VERSION, Cancelled, ToolMissing, probe_file
from .store import Store

MAX_PATHS = 500


def _error_code(e: Exception) -> str:
    if isinstance(e, FileNotFoundError):
        return "missing"
    if isinstance(e, PermissionError):
        return "permission_denied"
    if isinstance(e, ToolMissing):
        return "tool_missing"
    if isinstance(e, TimeoutError):
        return "timeout"
    return "unreadable"


def summarise(items: list[dict[str, Any]]) -> dict[str, Any]:
    """Cross-file checks that matter before building a multicam timeline."""
    ok = [i["info"] for i in items if i.get("ok")]
    warnings: list[dict[str, Any]] = []

    frame_rates = sorted({
        (v["frameRate"]["num"], v["frameRate"]["den"])
        for info in ok for v in info["video"][:1] if v.get("frameRate")
    })
    if len(frame_rates) > 1:
        warnings.append({
            "code": "mixed_frame_rates",
            "message": "Cameras use different frame rates: "
                       + ", ".join(f"{n / d:.3f}" for n, d in frame_rates),
        })

    sample_rates = sorted({a["sampleRate"] for info in ok for a in info["audio"] if a.get("sampleRate")})
    if len(sample_rates) > 1:
        warnings.append({
            "code": "mixed_sample_rates",
            "message": "Audio uses different sample rates: " + ", ".join(f"{r} Hz" for r in sample_rates)
                       + ". Sync analysis resamples to a common rate.",
        })

    by_name: dict[str, list[str]] = defaultdict(list)
    for i in items:
        by_name[Path(i["path"]).name.lower()].append(i["path"])
    dupes = {k: v for k, v in by_name.items() if len(v) > 1}
    if dupes:
        warnings.append({
            "code": "duplicate_filenames",
            "message": "Different files share a name (common with camera cards): "
                       + "; ".join(sorted(dupes)) + ". They are tracked by full path.",
            "paths": sorted(p for v in dupes.values() for p in v),
        })

    missing = [i["path"] for i in items if not i.get("ok") and i["error"]["code"] == "missing"]
    if missing:
        warnings.append({"code": "missing_media", "message": f"{len(missing)} file(s) are missing or offline.",
                         "paths": missing})

    return {
        "fileCount": len(items),
        "okCount": len(ok),
        "failedCount": len(items) - len(ok),
        "totalDuration": round(sum(info["duration"] or 0 for info in ok), 3),
        "frameRates": [{"num": n, "den": d, "value": round(n / d, 6)} for n, d in frame_rates],
        "sampleRates": sample_rates,
        "warnings": warnings,
    }


def make_probe_job(store: Store, ffprobe_getter: Callable[[], str | None], timeout: float):
    def run(ctx: JobContext, params: dict[str, Any]) -> dict[str, Any]:
        raw = params.get("paths")
        if not isinstance(raw, list) or not all(isinstance(p, str) for p in raw):
            raise ValueError("'paths' must be a list of strings")
        if len(raw) > MAX_PATHS:
            raise ValueError(f"At most {MAX_PATHS} files per probe job")
        # De-duplicate while keeping order. Paths are compared after normalisation.
        seen: set[str] = set()
        paths: list[str] = []
        for p in raw:
            norm = os.path.normpath(os.path.abspath(p)) if p else p
            if norm and norm not in seen:
                seen.add(norm)
                paths.append(norm)

        ffprobe = ffprobe_getter()
        items: list[dict[str, Any]] = []
        cache_hits = 0
        for n, path in enumerate(paths):
            if ctx.cancelled():
                raise Cancelled("cancelled")
            ctx.progress(n / max(1, len(paths)), f"Inspecting {Path(path).name}")
            try:
                st = os.stat(path)
                cached = store.cache_get("probe", path, st.st_size, st.st_mtime_ns, PROBE_ANALYSER_VERSION)
                if cached is not None:
                    cache_hits += 1
                    items.append({"path": path, "ok": True, "cached": True, "info": cached})
                    continue
                info = probe_file(ffprobe, path, timeout=timeout, cancel=ctx.cancel_event)
                store.cache_put("probe", path, st.st_size, st.st_mtime_ns, PROBE_ANALYSER_VERSION, info)
                items.append({"path": path, "ok": True, "cached": False, "info": info})
            except Cancelled:
                raise
            except FileNotFoundError as e:
                items.append({"path": path, "ok": False,
                              "error": {"code": "missing", "message": str(e) if "not found" in str(e)
                                        else f"File not found or drive disconnected: {path}"}})
            except Exception as e:  # noqa: BLE001 - one bad file must not fail the set
                items.append({"path": path, "ok": False, "error": {"code": _error_code(e), "message": str(e)}})
        ctx.progress(1.0, "Done")
        return {"items": items, "summary": summarise(items), "cacheHits": cache_hits}

    return run
