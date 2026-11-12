"""Pairing and bearer-token auth.

Any local program (including a web page in a browser) can reach 127.0.0.1, so
the API is not open by default. On start the companion prints a short pairing
code; the editor types it into the panel once and the panel receives a
long-lived token that is stored (hashed) here and in UXP secureStorage there.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time

from .store import Store

# No 0/O/1/I/L to avoid misreading the code from a console window.
_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
CODE_LENGTH = 6
MAX_FAILED_ATTEMPTS = 8
LOCKOUT_SECONDS = 60.0


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_pairing_code() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(CODE_LENGTH))


def normalise_code(code: str) -> str:
    return "".join(ch for ch in code.upper() if ch.isalnum())


class PairingError(Exception):
    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class Auth:
    def __init__(self, store: Store, pairing_code: str | None = None, session_token: str | None = None) -> None:
        self._store = store
        # Token handed over by the plugin that launched this engine (never stored on disk).
        self._session_token = session_token if session_token and len(session_token) >= 16 else None
        self._lock = threading.Lock()
        self._code = pairing_code or new_pairing_code()
        self._failed = 0
        self._locked_until = 0.0

    @property
    def pairing_code(self) -> str:
        return self._code

    def pair(self, code: str, client_name: str) -> str:
        """Exchange the pairing code for a token. The code is single use."""
        with self._lock:
            now = time.monotonic()
            if now < self._locked_until:
                raise PairingError("Too many wrong codes. Wait and try again.", self._locked_until - now)
            if not hmac.compare_digest(normalise_code(code), self._code):
                self._failed += 1
                if self._failed >= MAX_FAILED_ATTEMPTS:
                    self._failed = 0
                    self._locked_until = now + LOCKOUT_SECONDS
                    # Also rotate, so guessing across lockouts gains nothing.
                    self._code = new_pairing_code()
                raise PairingError("Wrong pairing code.")
            self._failed = 0
            self._code = new_pairing_code()  # single use
        token = secrets.token_urlsafe(32)
        self._store.add_client(hash_token(token), client_name[:120] or "unknown")
        return token

    def check(self, token: str | None) -> bool:
        if not token:
            return False
        if self._session_token and hmac.compare_digest(token, self._session_token):
            return True
        return self._store.touch_client(hash_token(token))
