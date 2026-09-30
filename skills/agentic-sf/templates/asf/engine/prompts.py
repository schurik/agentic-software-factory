"""Prompt rendering: load system/user refs from config, replace {{placeholders}}."""

from __future__ import annotations

import hashlib
from pathlib import Path

from . import frontmatter
from .utils import write_atomic


def render(template_path: str | Path, variables: dict[str, str]) -> str:
    """The file's prose with its placeholders filled. A leading YAML
    frontmatter block (an agent.md's config half) is not prose: it is
    stripped, so the model never reads the engine's settings."""
    text = frontmatter.body(Path(template_path).read_text(), str(template_path))
    for key, value in variables.items():
        text = text.replace("{{" + key + "}}", value)
    return text


def digest(system: str, prompt: str) -> str:
    """What names a prompt without carrying it: sha256 over the system prompt,
    a NUL, and the text sent — the two files `save` keeps, in that order."""
    return hashlib.sha256(f"{system}\0{prompt}".encode()).hexdigest()


def save(directory: str | Path, name: str, content: str) -> Path:
    """Save the exact prompt sent, before execution — the audit copy."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    write_atomic(path, content)
    return path
