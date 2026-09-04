"""Helper to load modules from the hyphen-named directory via importlib.

Python can't import packages whose names contain hyphens, so we load each
script file by its path. Tests use `load_module("migrate_openclaw_registry")`
to get a module object whose attributes (`migrate`, `render`, `_migrate_entry`,
`main`, ...) match the originals.
"""
import importlib.util
import sys
from pathlib import Path


DIR = Path(__file__).resolve().parents[1]  # todoist-github-sync/


def load_module(name: str) -> object:
    """Load `todoist-github-sync/<name>.py` as a fresh module and return it.

    Caches in sys.modules so a second call returns the same object (lets tests
    assert against the same `main` function as the CLI runs).
    """
    full = f"todoist_github_sync__{name}"
    if full in sys.modules:
        return sys.modules[full]
    path = DIR / f"{name}.py"
    spec = importlib.util.spec_from_file_location(full, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load spec for {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[full] = module
    spec.loader.exec_module(module)
    return module
