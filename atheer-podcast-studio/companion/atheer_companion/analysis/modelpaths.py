"""Where bundled and downloaded models live.

Search order for a model folder:
  1. $MAG_MODELS_DIR (developers, tests)
  2. <plugin>/engine/models  (shipped inside the .ccx; the engine runs from <plugin>/engine/python)
  3. <data dir>/models       (downloaded later)
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

_extra: list[Path] = []


def add_root(p: Path) -> None:
    if p not in _extra:
        _extra.append(p)


def roots() -> list[Path]:
    out: list[Path] = []
    env = os.environ.get("MAG_MODELS_DIR")
    if env:
        out.append(Path(env))
    out.append(Path(sys.executable).resolve().parent.parent / "models")
    out.extend(_extra)
    return out


def find(*parts: str) -> Path | None:
    for r in roots():
        p = r.joinpath(*parts)
        if p.exists():
            return p
    return None
