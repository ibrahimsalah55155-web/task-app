"""Runtime configuration and per-user data directory."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

from . import DEFAULT_PORT


def default_data_dir() -> Path:
    """Per-user folder for the database, logs and caches."""
    override = os.environ.get("MAG_ENGINE_HOME") or os.environ.get("ATHEER_COMPANION_HOME")
    if override:
        return Path(override).expanduser()
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        return base / "MultimediaAIGroup" / "engine"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "MultimediaAIGroup" / "engine"
    base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / "multimedia-ai-group" / "engine"


@dataclass
class Config:
    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    data_dir: Path = field(default_factory=default_data_dir)
    ffmpeg: str | None = None   # explicit path; otherwise PATH / bundled lookup
    ffprobe: str | None = None
    # Origins (exact strings) that may call the API from a browser-like client in
    # addition to the defaults. Normally empty: UXP is accepted without this.
    extra_allowed_origins: tuple[str, ...] = ()
    probe_timeout_s: float = 120.0
    max_workers: int = 2

    @property
    def db_path(self) -> Path:
        return self.data_dir / "companion.sqlite3"

    @property
    def log_path(self) -> Path:
        return self.data_dir / "logs" / "companion.log"

    def ensure_dirs(self) -> None:
        (self.data_dir / "logs").mkdir(parents=True, exist_ok=True)
        (self.data_dir / "cache").mkdir(parents=True, exist_ok=True)
