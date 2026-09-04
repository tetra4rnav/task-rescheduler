#!/usr/bin/env python3
"""Deterministic gate and verifier for Project Hub cron.

PROJECT_MAP.md is the canonical identity/routing registry. Project memories are
canonical evidence. The Hub is a generated dashboard only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

from project_registry import parse_registry, validate as validate_registry

ROOT = Path(__file__).resolve().parents[1]
HUB = ROOT / "memory/project-hub-master.md"
PROJECT_MAP = ROOT / "PROJECT_MAP.md"
REQUIRED = (
    "## Metadata",
    "## Immediate Attention",
    "## Active Projects",
    "## Waiting / On Hold",
    "## Completed / Archived",
    "## Normalization Rules",
)
FORBIDDEN = ("## Project Registry",)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def registry_sources() -> tuple[list[Path], dict]:
    projects = parse_registry()
    validation = validate_registry(projects)
    if not validation["valid"]:
        raise ValueError("invalid PROJECT_MAP.md: " + "; ".join(validation["errors"]))
    sources = [ROOT / item["memory_path"] for item in projects if item["hub"].casefold() == "yes"]
    return sorted(set(sources)), validation


def check() -> dict:
    sources, registry = registry_sources()
    hub_mtime = HUB.stat().st_mtime_ns
    changed = [p for p in sources if p.stat().st_mtime_ns > hub_mtime]
    return {
        "hub": str(HUB.relative_to(ROOT)),
        "hub_sha256": digest(HUB),
        "hub_mtime_ns": hub_mtime,
        "project_map": str(PROJECT_MAP.relative_to(ROOT)),
        "project_map_sha256": digest(PROJECT_MAP),
        "registry_project_count": registry["project_count"],
        "registry_warnings": registry["warnings"],
        "changed": [str(p.relative_to(ROOT)) for p in changed],
        "changed_count": len(changed),
    }


def context() -> int:
    result = check()
    print(json.dumps(result, ensure_ascii=False))
    if not result["changed"]:
        return 0
    print("\n===== HUB BEGIN =====")
    print(HUB.read_text(encoding="utf-8"))
    print("===== HUB END =====")
    for rel in result["changed"]:
        path = ROOT / rel
        print(f"\n===== CHANGED SOURCE BEGIN: {rel} =====")
        print(path.read_text(encoding="utf-8"))
        print(f"===== CHANGED SOURCE END: {rel} =====")
    return 0


def verify(before_hash: str, changed: list[str]) -> int:
    errors: list[str] = []
    try:
        _, registry = registry_sources()
    except Exception as exc:
        registry = {"valid": False, "errors": [str(exc)], "warnings": []}
        errors.append(str(exc))
    text = HUB.read_text(encoding="utf-8")  # mandatory persisted re-read
    after_hash = digest(HUB)
    if after_hash == before_hash:
        errors.append("Hub hash did not change")
    for heading in REQUIRED:
        if heading not in text:
            errors.append(f"missing heading: {heading}")
    for heading in FORBIDDEN:
        if heading in text:
            errors.append(f"forbidden dashboard duplication: {heading}")
    if "../PROJECT_MAP.md" not in text:
        errors.append("Hub does not point to PROJECT_MAP.md")
    hub_mtime = HUB.stat().st_mtime_ns
    registered = {str(p.relative_to(ROOT)) for p in registry_sources()[0]} if registry.get("valid") else set()
    for rel in changed:
        path = (ROOT / rel).resolve()
        if rel not in registered:
            errors.append(f"changed source is not a Hub-enabled PROJECT_MAP entry: {rel}")
        elif not path.exists():
            errors.append(f"missing changed source: {rel}")
        elif hub_mtime <= path.stat().st_mtime_ns:
            errors.append(f"Hub mtime is not newer than changed source: {rel}")
    result = {
        "verified": not errors,
        "hub_sha256_before": before_hash,
        "hub_sha256_after": after_hash,
        "persisted_re_read": True,
        "registry_valid": registry.get("valid", False),
        "project_map_sha256": digest(PROJECT_MAP),
        "changed_sources": changed,
        "errors": errors,
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0 if not errors else 2


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check")
    sub.add_parser("context")
    sub.add_parser("registry")
    verify_parser = sub.add_parser("verify")
    verify_parser.add_argument("--before-hash", required=True)
    verify_parser.add_argument("--changed", action="append", default=[])
    args = parser.parse_args()
    if args.command == "check":
        print(json.dumps(check(), ensure_ascii=False))
        return 0
    if args.command == "context":
        return context()
    if args.command == "registry":
        print(json.dumps(validate_registry(parse_registry()), ensure_ascii=False, indent=2))
        return 0
    return verify(args.before_hash, args.changed)


if __name__ == "__main__":
    sys.exit(main())
