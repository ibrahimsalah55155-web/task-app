"""Entry point: `python -m atheer_companion` or the `atheer-companion` script."""

from __future__ import annotations

import argparse
import logging
import logging.handlers
import socket
import sys
from pathlib import Path

from . import DEFAULT_PORT, __version__
from .auth import Auth
from .config import Config, default_data_dir
from .store import Store


def _setup_logging(config: Config, verbose: bool) -> None:
    config.ensure_dirs()
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    file_handler = logging.handlers.RotatingFileHandler(
        config.log_path, maxBytes=2_000_000, backupCount=3, encoding="utf-8"
    )
    file_handler.setFormatter(fmt)
    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)
    root = logging.getLogger()
    root.handlers[:] = [file_handler, console]
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
        except OSError:
            return False
    return True


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="atheer-companion", description="ATHEER PODCAST STUDIO local companion")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"loopback port (default {DEFAULT_PORT})")
    p.add_argument("--data-dir", type=Path, default=None, help=f"data folder (default {default_data_dir()})")
    p.add_argument("--ffmpeg", default=None, help="path to ffmpeg")
    p.add_argument("--ffprobe", default=None, help="path to ffprobe")
    p.add_argument("--allow-origin", action="append", default=[],
                   help="extra request Origin to accept (only if the panel reports origin_rejected)")
    p.add_argument("--revoke-all", action="store_true", help="forget every paired panel, then exit")
    p.add_argument("--verbose", action="store_true")
    p.add_argument("--version", action="version", version=__version__)
    args = p.parse_args(argv)

    config = Config(port=args.port, ffmpeg=args.ffmpeg, ffprobe=args.ffprobe,
                    extra_allowed_origins=tuple(args.allow_origin))
    if args.data_dir:
        config.data_dir = args.data_dir
    _setup_logging(config, args.verbose)
    log = logging.getLogger("atheer")

    store = Store(config.db_path)
    if args.revoke_all:
        print(f"Revoked {store.revoke_all_clients()} paired panel(s).")
        return 0

    if not _port_free(config.host, config.port):
        log.error("Port %s is already in use. Is the companion already running? "
                  "Otherwise start with --port and set the same port in the panel's Settings.", config.port)
        return 2

    import uvicorn

    from .app import create_app

    auth = Auth(store)
    app = create_app(config, store=store, auth=auth)
    tools = app.state.tools
    bar = "=" * 60
    print(bar)
    print(f" ATHEER Companion {__version__}  ->  http://{config.host}:{config.port}")
    print(f" Pairing code:  {auth.pairing_code[:3]} {auth.pairing_code[3:]}")
    print(" Enter this code in the Premiere panel (Dashboard > Companion) once.")
    print(f" ffprobe: {tools.ffprobe or 'NOT FOUND'}")
    print(f" ffmpeg:  {tools.ffmpeg or 'NOT FOUND'}")
    print(f" Data:    {config.data_dir}")
    print(" Keep this window open while you edit. Ctrl+C to stop.")
    print(bar, flush=True)
    if not tools.ffprobe:
        log.warning("ffprobe not found: media inspection will fail until it is installed.")

    uvicorn.run(app, host=config.host, port=config.port, log_level="warning", ws="websockets")
    return 0


if __name__ == "__main__":
    sys.exit(main())
