"""What this machine can do: tools, hardware and optional AI packages."""

from __future__ import annotations

import importlib.util
import os
import platform
import shutil
import subprocess
import sys
from typing import Any

from .media import Tools

# Optional packages used by later phases. Presence only: nothing is imported here,
# so a broken optional install cannot take the service down.
OPTIONAL_MODULES = {
    "numpy": "Signal processing (sync, silence)",
    "faster_whisper": "Speech-to-text (captions, reels, silence boundaries)",
    "silero_vad": "Voice activity detection",
    "torch": "ML runtime for VAD/diarization",
    "onnxruntime": "ML runtime (CPU/GPU)",
    "cv2": "Face detection / reframing",
}


def _total_ram_bytes() -> int | None:
    try:
        if sys.platform == "win32":
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]

            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))  # type: ignore[attr-defined]
            return int(stat.ullTotalPhys)
        if sys.platform == "darwin":
            out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5)
            return int(out.stdout.strip())
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except Exception:  # noqa: BLE001
        return None


def _gpus() -> list[dict[str, Any]]:
    gpus: list[dict[str, Any]] = []
    smi = shutil.which("nvidia-smi")
    if smi:
        try:
            out = subprocess.run(
                [smi, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=10,
            )
            for line in out.stdout.splitlines():
                name, _, mem = line.partition(",")
                if name.strip():
                    gpus.append({"vendor": "nvidia", "name": name.strip(),
                                 "memoryMB": int(mem.strip()) if mem.strip().isdigit() else None, "cuda": True})
        except Exception:  # noqa: BLE001
            pass
    if sys.platform == "darwin" and platform.machine() == "arm64":
        gpus.append({"vendor": "apple", "name": "Apple Silicon GPU", "memoryMB": None, "cuda": False})
    return gpus


def capabilities(tools: Tools) -> dict[str, Any]:
    modules = {
        name: {"available": importlib.util.find_spec(name) is not None, "purpose": purpose}
        for name, purpose in OPTIONAL_MODULES.items()
    }
    return {
        "platform": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
        "python": platform.python_version(),
        "cpuCount": os.cpu_count(),
        "ramBytes": _total_ram_bytes(),
        "gpus": _gpus(),
        "tools": {
            "ffmpeg": {"path": tools.ffmpeg, "version": tools.ffmpeg_version},
            "ffprobe": {"path": tools.ffprobe, "version": tools.ffprobe_version},
        },
        "modules": modules,
    }
