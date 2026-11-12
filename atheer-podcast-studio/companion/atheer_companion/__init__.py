"""ATHEER PODCAST STUDIO local companion service.

The Premiere UXP panel cannot spawn processes, decode audio or run ML models.
This service does that work on the same machine and talks to the panel over
127.0.0.1 only.
"""

__version__ = "0.2.0"

# Bumped whenever a request/response shape changes incompatibly.
# The panel refuses to talk to a companion with a different API major version.
API_VERSION = 1

SERVICE_NAME = "atheer-companion"
DEFAULT_PORT = 47820
