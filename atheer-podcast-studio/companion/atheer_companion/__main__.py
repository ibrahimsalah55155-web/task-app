"""Entry point: `python -m atheer_companion` or the `atheer-companion` script."""

from __future__ import annotations

import argparse
import logging
import logging.handlers
import os
import socket
import sys
import threading
import time
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
    handlers: list[logging.Handler] = [file_handler]
    if sys.stdout is not None:  # pythonw.exe (no window) has no stdout
        console = logging.StreamHandler(sys.stdout)
        console.setFormatter(fmt)
        handlers.append(console)
    root = logging.getLogger()
    root.handlers[:] = handlers
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def _parent_alive(pid: int) -> bool:
    if sys.platform == "win32":
        import ctypes

        SYNCHRONIZE = 0x00100000
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False
        try:
            return kernel32.WaitForSingleObject(handle, 0) == 0x00000102  # WAIT_TIMEOUT
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def watch_parent(pid: int, interval: float = 2.0) -> None:
    """Exit when the launching Premiere process is gone (backup to the Windows job object)."""
    log = logging.getLogger("atheer")

    def run() -> None:
        while True:
            time.sleep(interval)
            if not _parent_alive(pid):
                log.info("Premiere (pid %s) has exited; stopping the engine", pid)
                logging.shutdown()
                os._exit(0)

    threading.Thread(target=run, name="parent-watch", daemon=True).start()


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if sys.platform != "win32":
            # Same as uvicorn: connections in TIME_WAIT from a previous engine must not block a restart.
            # (On Windows SO_REUSEADDR would allow stealing a live port, and TIME_WAIT does not block bind.)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
        except OSError:
            return False
    return True


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="mag-engine", description="Multimedia & AI Group - local processing engine")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"loopback port (default {DEFAULT_PORT})")
    p.add_argument("--data-dir", type=Path, default=None, help=f"data folder (default {default_data_dir()})")
    p.add_argument("--ffmpeg", default=None, help="path to ffmpeg")
    p.add_argument("--ffprobe", default=None, help="path to ffprobe")
    p.add_argument("--allow-origin", action="append", default=[],
                   help="extra request Origin to accept (only if the panel reports origin_rejected)")
    p.add_argument("--parent-pid", type=int, default=None, help="exit when this process exits (set by the plugin)")
    p.add_argument("--token-env", default=None,
                   help="name of an environment variable holding a session token (set by the plugin; skips pairing)")
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
        log.error("Port %s is already in use by another program or engine.", config.port)
        return 2

    import uvicorn

    from .app import create_app

    session_token = os.environ.get(args.token_env) if args.token_env else None
    if args.token_env and not session_token:
        log.error("--token-env %s given but the variable is empty", args.token_env)
        return 3
    if args.parent_pid:
        watch_parent(args.parent_pid)
    auth = Auth(store, session_token=session_token)
    app = create_app(config, store=store, auth=auth)
    tools = app.state.tools
    bar = "=" * 60
    print(bar)
    print(f" Multimedia & AI Group engine {__version__}  ->  http://{config.host}:{config.port}")
    if session_token:
        print(" Started by the Premiere plugin (no pairing needed).")
    else:
        print(f" Pairing code:  {auth.pairing_code[:3]} {auth.pairing_code[3:]}")
        print(" Enter this code in the Premiere panel (Dashboard > Engine) once.")
    print(f" ffprobe: {tools.ffprobe or 'NOT FOUND'}")
    print(f" ffmpeg:  {tools.ffmpeg or 'NOT FOUND'}")
    print(f" Data:    {config.data_dir}")
    print(" Keep this window open while you edit. Ctrl+C to stop.")
    print(bar, flush=True)
    if not tools.ffprobe:
        log.warning("ffprobe not found: media inspection will fail until it is installed.")

    log.info("engine %s listening on %s:%s (pid %s)", __version__, config.host, config.port, os.getpid())
    # log_config=None: uvicorn's default config writes to stderr, which does not exist under pythonw.exe.
    uvicorn.run(app, host=config.host, port=config.port, log_level="warning", ws="websockets", log_config=None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
