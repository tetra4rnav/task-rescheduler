#!/usr/bin/env python3
"""
migrate_openclaw_registry.py — convert legacy openclaw-mirror registry to the
new todoist-github-sync config schema.

Old schema (openclaw-mirror/scripts/project_registry.json):
    [
      {
        "key": "...",
        "name": "...",
        "github": [{"owner": "...", "repo": "...", "github_project": {"number": N}}],
        "todoist_project": "...",
      },
      ...
    ]

New schema (todoist-github-sync/github-projects.json):
    {
      "$schema_version": "1.0",
      "projects": [
        {
          "name": "...",
          "github_owner": "...",
          "github_repos": ["..."],
          "todoist_project": "...",
          "github_project_number": N | null,
          "issue_labels_include": [],
          "issue_labels_exclude": [],
        },
        ...
      ]
    }

Usage:
    # Dry-run (print to stdout):
    python3 migrate_openclaw_registry.py --source <old.json> --dry-run

    # Write new config:
    python3 migrate_openclaw_registry.py --source <old.json> --output <new.json>

Skip rules:
    - entry.github == [] or missing      → skipped
    - entry.todoist_project missing/null → skipped
    - entry.github entries without owner/repo → skipped with warning

Error rules (fail loud):
    - Multiple distinct github owners across an entry's repos
    - Multiple distinct github_project numbers across an entry's repos
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SCHEMA_VERSION = "1.0"


def _load_legacy(path: Path) -> list[dict]:
    """Load and parse the legacy registry. Raises on bad JSON."""
    if not path.exists():
        raise FileNotFoundError(f"source not found: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"source is not valid JSON: {path}: {exc}") from exc
    if not isinstance(data, list):
        raise ValueError(
            f"legacy registry must be a JSON array; got {type(data).__name__}"
        )
    return data


def _migrate_entry(entry: dict) -> tuple[dict | None, list[str]]:
    """
    Convert one legacy entry to the new schema, or return None to skip.
    Returns (new_entry_or_None, list_of_warnings).
    """
    warnings: list[str] = []
    entry_key = entry.get("key") or entry.get("name") or "<unnamed>"

    # Skip rule 1: no github repos.
    github_list = entry.get("github") or []
    if not github_list:
        warnings.append(f"skip {entry_key}: github is empty")
        return None, warnings

    # Skip rule 2: no todoist project.
    todoist_project = entry.get("todoist_project")
    if not todoist_project:
        warnings.append(f"skip {entry_key}: todoist_project is null/empty")
        return None, warnings

    # Validate every repo entry has owner and repo.
    valid_repos = []
    for repo in github_list:
        owner = repo.get("owner")
        repo_name = repo.get("repo")
        if not owner or not repo_name:
            warnings.append(
                f"skip repo in {entry_key}: missing owner/repo ({repo})"
            )
            continue
        valid_repos.append(repo)
    if not valid_repos:
        warnings.append(f"skip {entry_key}: no valid repos after filtering")
        return None, warnings

    # Detect distinct owners — fail loud on multi-owner entries.
    distinct_owners = {r["owner"] for r in valid_repos}
    if len(distinct_owners) > 1:
        raise ValueError(
            f"{entry_key}: multiple distinct github owners across repos "
            f"({sorted(distinct_owners)}); split into separate entries first"
        )
    github_owner = next(iter(distinct_owners))

    # Detect distinct github_project numbers — fail loud.
    project_numbers = set()
    for r in valid_repos:
        gp = r.get("github_project") or {}
        n = gp.get("number")
        if n is not None:
            project_numbers.add(n)
    if len(project_numbers) > 1:
        raise ValueError(
            f"{entry_key}: multiple distinct github_project numbers across "
            f"repos ({sorted(project_numbers)}); split into separate entries first"
        )
    github_project_number = next(iter(project_numbers)) if project_numbers else None

    name = entry.get("name") or entry.get("canonical_name") or entry_key

    new_entry = {
        "name": name,
        "github_owner": github_owner,
        "github_repos": [r["repo"] for r in valid_repos],
        "todoist_project": todoist_project,
        "github_project_number": github_project_number,
        "issue_labels_include": [],
        "issue_labels_exclude": [],
    }
    return new_entry, warnings


def migrate(legacy: list[dict]) -> tuple[list[dict], list[str], list[str]]:
    """
    Migrate the full legacy list.

    Returns (new_projects, all_warnings, all_errors).
    `all_errors` is a list of human-readable error strings; an exception-raising
    implementation would be simpler, but collecting errors lets us report them
    all at once instead of failing on the first one.
    """
    new_projects: list[dict] = []
    warnings: list[str] = []
    errors: list[str] = []

    for entry in legacy:
        try:
            new_entry, entry_warnings = _migrate_entry(entry)
        except ValueError as exc:
            errors.append(str(exc))
            continue
        warnings.extend(entry_warnings)
        if new_entry is not None:
            new_projects.append(new_entry)

    return new_projects, warnings, errors


def render(new_projects: list[dict]) -> dict:
    """Wrap the new project list in the full config dict."""
    return {
        "$schema_version": SCHEMA_VERSION,
        "$comment": (
            "Migrated from openclaw-mirror/scripts/project_registry.json. "
            "Edit freely; the sync engine only reads the `projects` list."
        ),
        "projects": new_projects,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Migrate legacy openclaw project_registry.json → new "
        "todoist-github-sync config schema."
    )
    parser.add_argument(
        "--source",
        required=True,
        help="path to legacy openclaw-mirror/scripts/project_registry.json",
    )
    parser.add_argument(
        "--output",
        help="path to write the new config; required unless --dry-run",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the rendered JSON to stdout instead of writing",
    )
    args = parser.parse_args(argv)

    if not args.dry_run and not args.output:
        print("error: --output is required unless --dry-run is set", file=sys.stderr)
        return 2

    source = Path(args.source)
    try:
        legacy = _load_legacy(source)
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    new_projects, warnings, errors = migrate(legacy)
    rendered = render(new_projects)
    text = json.dumps(rendered, indent=2, ensure_ascii=False) + "\n"

    if args.dry_run:
        # In dry-run, summary goes to stderr; JSON goes to stdout so callers
        # can pipe it.
        print(
            f"# migrated {len(new_projects)} of {len(legacy)} legacy entries "
            f"({len(warnings)} warnings, {len(errors)} errors)",
            file=sys.stderr,
        )
        for w in warnings:
            print(f"# warn: {w}", file=sys.stderr)
        for e in errors:
            print(f"# error: {e}", file=sys.stderr)
        sys.stdout.write(text)
        return 1 if errors else 0

    if errors:
        # Refuse to write a partially-migrated file: surface all errors first.
        print(
            f"refusing to write {args.output}: {len(errors)} error(s) in source",
            file=sys.stderr,
        )
        for e in errors:
            print(f"  error: {e}", file=sys.stderr)
        return 1

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text, encoding="utf-8")

    print(
        f"wrote {output} with {len(new_projects)} projects "
        f"({len(warnings)} warning(s) skipped)",
        file=sys.stderr,
    )
    for w in warnings:
        print(f"  warn: {w}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
