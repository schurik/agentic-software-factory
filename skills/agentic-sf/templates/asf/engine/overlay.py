"""How an `asf/factory.yaml` overlay is written: the pointer line, then keys.

One renderer for both writers of that file — the installer, writing a fresh
stamp's, and `asf config --non-default`, shrinking a whole one — so a shrunk
config at today's defaults reads byte for byte as a fresh stamp's does.

STDLIB ONLY, and nothing from the rest of `engine`: `install.py` runs with no
dependencies at all and loads this file straight out of the skill's templates.
So the values are written as JSON, which is YAML, in block-style maps.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator

# The overlay's only comment, its first line. Everything else it says is a key.
HEAD = ("# Overlay on asf/factory-defaults.yaml, which holds every key, its default and "
        "what it means — say here only what differs.\n")
BARE_KEY = re.compile(r"[A-Za-z_][\w-]*")
# What YAML 1.1 reads as a boolean or a null rather than as the string it
# looks like: a route label `yes` written bare would come back as True.
NOT_A_STRING = re.compile(r"y|n|yes|no|true|false|on|off|null", re.IGNORECASE)


def render(keys: dict) -> str:
    """The pointer line, then `keys` in block style with JSON values."""
    return HEAD + "".join(_block(keys, 0))


def _block(mapping: dict, indent: int) -> Iterator[str]:
    for key, value in mapping.items():
        bare = BARE_KEY.fullmatch(key) and not NOT_A_STRING.fullmatch(key)
        name = key if bare else json.dumps(key)
        if isinstance(value, dict) and value:
            yield f"{' ' * indent}{name}:\n"
            yield from _block(value, indent + 2)
        else:
            yield f"{' ' * indent}{name}: {json.dumps(value)}\n"
