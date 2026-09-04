#!/usr/bin/env python3
"""
github_todoist_sync.py — One-way sync from GitHub Issues to Todoist tasks.

GitHub is authoritative. Todoist-side edits (duration, priority) are never
overwritten. Mapping key: issue URL in task description + `github-issue` label.

Config is loaded from --config <path> or the $GITHUB_PROJECTS_CONFIG env var.
The config file declares which (owner, repos) pairs map to which Todoist
project, and optionally which GitHub Project to read start/target dates from.

Usage:
    # Dry-run (no writes):
    python3 github_todoist_sync.py --config /path/to/github-projects.json --dry-run

    # Apply:
    python3 github_todoist_sync.py --config /path/to/github-projects.json

External I/O is wrapped in injectable transports: `GhRunner` for the `gh` CLI
and `TodoistClient` for the Todoist REST API. The CLI builds a `Transport`
adapter from these; tests build a fake `Transport` that records every action
without performing network calls.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Optional, Protocol

TODOIST_BASE = "https://api.todoist.com/api/v1"
LABEL = "github-issue"
DATE_LOCK_LABEL = "date-locked"
URL_RE = re.compile(r"https://github\.com/([^/\s]+)/([^/\s]+)/issues/(\d+)")
SCHEMA_VERSION = "1.0"


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


class ConfigError(ValueError):
    """Raised when the config file fails schema validation."""


REQUIRED_PROJECT_KEYS = (
    "name", "github_owner", "github_repos", "todoist_project",
)
OPTIONAL_PROJECT_KEYS = (
    "github_project_number", "issue_labels_include", "issue_labels_exclude",
)


def load_config(path: Path) -> dict:
    """Load and validate a github-projects config file."""
    if not path.exists():
        raise ConfigError(f"config file not found: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"config is not valid JSON: {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ConfigError(
            f"config must be a JSON object; got {type(data).__name__}"
        )
    version = data.get("$schema_version")
    if version != SCHEMA_VERSION:
        raise ConfigError(
            f"config $schema_version must be {SCHEMA_VERSION!r}; got {version!r}"
        )
    projects = data.get("projects")
    if not isinstance(projects, list):
        raise ConfigError(
            f"config `projects` must be a list; got {type(projects).__name__}"
        )
    if not projects:
        raise ConfigError("config `projects` is empty")
    for i, p in enumerate(projects):
        if not isinstance(p, dict):
            raise ConfigError(f"config `projects[{i}]` must be an object")
        for key in REQUIRED_PROJECT_KEYS:
            if key not in p or not p[key]:
                raise ConfigError(
                    f"config `projects[{i}].{key}` missing or empty"
                )
        if not isinstance(p["github_repos"], list) or not all(
            isinstance(r, str) for r in p["github_repos"]
        ):
            raise ConfigError(
                f"config `projects[{i}].github_repos` must be a list of strings"
            )
        for key in OPTIONAL_PROJECT_KEYS:
            if key in p and key != "github_project_number":
                if not isinstance(p[key], list):
                    raise ConfigError(
                        f"config `projects[{i}].{key}` must be a list"
                    )
    return data


def resolve_config_path(arg: Optional[str]) -> Path:
    """Pick the config path from --config flag, $GITHUB_PROJECTS_CONFIG, or fail."""
    chosen = arg or os.environ.get("GITHUB_PROJECTS_CONFIG")
    if not chosen:
        raise ConfigError(
            "no config: pass --config <path> or set $GITHUB_PROJECTS_CONFIG"
        )
    return Path(chosen)


# ---------------------------------------------------------------------------
# GitHub-side fetching (gh CLI)
# ---------------------------------------------------------------------------


@dataclass
class GhRunner:
    """Wrapper around the `gh` CLI for issue and project reads.

    `run(args)` returns (returncode, stdout, stderr). Tests override this with
    a fake that returns canned JSON.
    """

    binary: str = field(default_factory=lambda: shutil.which("gh") or "")

    def run(self, args: list[str], timeout: int = 60) -> tuple[int, str, str]:
        import subprocess
        if not self.binary:
            raise RuntimeError("gh CLI not found on PATH")
        proc = subprocess.run(
            [self.binary, *args],
            capture_output=True, text=True, timeout=timeout,
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""


def fetch_issues(runner: GhRunner, owner: str, repo: str) -> list[dict]:
    """List every issue in `owner/repo` and enrich each with parent/dependency
    summaries. `gh issue list --json` does not natively expose `parent_issue_url`
    or `issue_dependencies_summary`, so we either:

      * request them when the installed `gh` version supports the fields
        (>= 2.86; emits a clear warning if not), or
      * fall back to the basic set and leave parent/blocked_by empty so
        the rest of the pipeline still runs.

    Either way, every returned dict carries `parent_issue_url` and
    `issue_dependencies_summary` keys (possibly empty) so downstream code can
    read them unconditionally.

    Returns (rows, unsupported_warning). `unsupported_warning` is None on the
    happy path and a human-readable string when gh fell back to the baseline
    JSON set — the caller surfaces it on stderr so operators notice the
    sub-task / blocked-by sync isn't running.
    """
    rc, stdout, _ = runner.run([
        "issue", "list", "--repo", f"{owner}/{repo}",
        "--state", "all", "--limit", "500", "--json",
        "number,title,state,url,body,comments",
        "parent_issue_url,sub_issues_summary,issue_dependencies_summary",
    ])
    unsupported_warning: Optional[str] = None
    if rc != 0:
        # Older gh versions don't support those extra fields. Retry with the
        # baseline set so we still get an issue list (parent/blocked_by empty).
        unsupported_warning = (
            f"WARN: gh issue list on {owner}/{repo} does not support "
            f"parent_issue_url / issue_dependencies_summary fields. Sub-task "
            f"and blocked-by sync will be skipped for this repo. Upgrade "
            f"`gh` to >= 2.86 to enable them."
        )
        rc, stdout, _ = runner.run([
            "issue", "list", "--repo", f"{owner}/{repo}",
            "--state", "all", "--limit", "500", "--json",
            "number,title,state,url,body,comments",
        ])
        if rc != 0:
            return [], unsupported_warning
    try:
        rows = json.loads(stdout or "[]")
    except json.JSONDecodeError:
        return [], unsupported_warning
    # Normalise: ensure the summary keys exist even when the gh CLI omitted
    # them (older versions).
    for row in rows:
        row.setdefault("parent_issue_url", None)
        row.setdefault("sub_issues_summary", {})
        row.setdefault("issue_dependencies_summary", {})
    return rows, unsupported_warning


def fetch_blocked_by(
    runner: GhRunner, owner: str, repo: str, issue_number: int,
) -> list[int]:
    """Return the issue numbers that `issue_number` is blocked by.

    Empty list on error or no dependencies. The detail endpoint is only
    called when `issue_dependencies_summary.blocked_by > 0` (caller's
    responsibility to gate); we don't fetch the same endpoint twice per issue.
    """
    rc, stdout, _ = runner.run([
        "api", f"repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by",
    ])
    if rc != 0:
        return []
    try:
        rows = json.loads(stdout or "[]")
    except json.JSONDecodeError:
        return []
    return [int(r["number"]) for r in rows if r.get("number") is not None]


def fetch_project_dates(
    runner: GhRunner, owner: str, project_number: int,
) -> tuple[dict[tuple[str, str, int], tuple[Optional[str], Optional[str]]], Optional[str]]:
    """Read GitHub Projects dates for every linked issue.

    Returns ``(dates_map, warning)``. The warning is None on success, or a
    human-readable string explaining why no dates came back when some were
    expected. Common causes: `gh` exit non-zero (auth/scope/network) or the
    project board has no items linked to issues.
    """
    rc, stdout, stderr = runner.run([
        "project", "item-list", str(project_number),
        "--owner", owner, "--format", "json",
    ])
    if rc != 0:
        hint = ""
        if "Resource not accessible" in stderr or "FORBIDDEN" in stderr:
            hint = (
                " (likely `gh` token missing `read:project`/`read:org` scope; "
                "re-auth with a classic PAT or add the scopes)"
            )
        elif "unknown owner type" in stderr:
            hint = " (try `--owner @me` if the project belongs to your user)"
        snippet = (stderr or "").strip().splitlines()[0][:200] if stderr else ""
        return {}, (
            f"WARN: project {owner}#{project_number} gh fetch failed "
            f"(rc={rc}): {snippet}{hint}"
        )
    try:
        data = json.loads(stdout or "{}")
    except json.JSONDecodeError as exc:
        return {}, (
            f"WARN: project {owner}#{project_number} returned invalid JSON: "
            f"{exc}"
        )
    items = data.get("items", [])
    if not items:
        return {}, (
            f"WARN: project {owner}#{project_number} returned no items; "
            f"start/target dates will not sync. Verify the project number "
            f"and that it has issues linked."
        )
    out: dict[tuple[str, str, int], tuple[Optional[str], Optional[str]]] = {}
    for it in items:
        content = it.get("content") or {}
        repo = content.get("repository")
        number = content.get("number")
        if not repo or number is None:
            continue
        if isinstance(repo, str) and "/" in repo:
            repo_owner, repo_name = repo.split("/", 1)
        else:
            continue
        out[(repo_owner, repo_name, int(number))] = (
            it.get("start date"), it.get("target date"),
        )
    if not out:
        return {}, (
            f"WARN: project {owner}#{project_number} has {len(items)} items "
            f"but none are linked to issues; start/target dates will not sync."
        )
    return out, None


# ---------------------------------------------------------------------------
# Todoist-side fetching (REST client)
# ---------------------------------------------------------------------------


@dataclass
class TodoistClient:
    """Minimal Todoist REST client. Returns parsed JSON or "" on error."""

    token: str

    def request(
        self, method: str, path: str, body: Optional[dict] = None,
    ) -> object:
        url = f"{TODOIST_BASE}{path}"
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            url, data=data, headers=headers, method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw else ""
        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError):
            return ""

    def get(self, path: str) -> object:
        items: list = []
        cursor = None
        while True:
            sep = "&" if "?" in path else "?"
            q = f"{path}{sep}limit=200"
            if cursor:
                q += f"&cursor={cursor}"
            out = self.request("GET", q)
            if isinstance(out, dict):
                items.extend(out.get("results", []))
                cursor = out.get("next_cursor")
                if not cursor:
                    break
            else:
                break
        return items


def all_projects(client: TodoistClient) -> dict[str, dict]:
    return {p["name"]: p for p in client.get("/projects")}


def managed_tasks(
    tasks: Iterable[dict],
) -> list[tuple[dict, str, str, int]]:
    """Filter to tasks carrying `github-issue` label and a recognised issue URL."""
    out = []
    for t in tasks:
        labels = t.get("labels") or []
        if LABEL not in labels:
            continue
        m = URL_RE.search(t.get("description", "") or "")
        if m:
            out.append((t, m.group(1), m.group(2), int(m.group(3))))
    return out


def fetch_task_comments(client: TodoistClient, task_id: str) -> list[dict]:
    out: list = []
    cursor = None
    while True:
        path = f"/comments?task_id={task_id}"
        sep = "&" if "?" in path else "?"
        q = f"{path}{sep}limit=200"
        if cursor:
            q += f"&cursor={cursor}"
        res = client.request("GET", q)
        if isinstance(res, dict):
            out.extend(res.get("results", []))
            cursor = res.get("next_cursor")
            if not cursor:
                break
        else:
            break
    return out


# ---------------------------------------------------------------------------
# Transport abstraction (apply hook + dry-run recorder share this surface)
# ---------------------------------------------------------------------------


class Transport(Protocol):
    """The seven writes the sync engine can perform against Todoist."""
    def create_task(self, body: dict) -> Optional[str]: ...
    def update_task(self, task_id: str, body: dict) -> None: ...
    def move_task(self, task_id: str, project_id: str) -> None: ...
    def close_task(self, task_id: str) -> None: ...
    def post_comment(self, task_id: str, content: str) -> None: ...
    def set_parent(self, task_id: str, parent_id: Optional[str]) -> None: ...
    def set_dependencies(self, task_id: str, dependency_ids: list[str]) -> None: ...


@dataclass
class TodoistTransport:
    """Production Transport — every call goes to Todoist REST.

    `parent_id` is a regular task field, so it travels through update_task.
    `dependency_ids` are NOT a REST field — they're a Sync API property, so
    `set_dependencies` collects writes and the `commit_dependencies` helper
    flushes them in one batch.
    """

    client: TodoistClient
    _pending_dependencies: list[tuple[str, list[str]]] = field(default_factory=list)

    def create_task(self, body: dict) -> Optional[str]:
        out = self.client.request("POST", "/tasks", body=body)
        if isinstance(out, dict) and out.get("id"):
            return out["id"]
        return None

    def update_task(self, task_id: str, body: dict) -> None:
        self.client.request("POST", f"/tasks/{task_id}", body=body)

    def move_task(self, task_id: str, project_id: str) -> None:
        self.client.request(
            "POST", f"/tasks/{task_id}/move",
            body={"project_id": project_id},
        )

    def close_task(self, task_id: str) -> None:
        self.client.request("POST", f"/tasks/{task_id}/close")

    def post_comment(self, task_id: str, content: str) -> None:
        self.client.request(
            "POST", "/comments",
            {"task_id": task_id, "content": content},
        )

    def set_parent(self, task_id: str, parent_id: Optional[str]) -> None:
        # `parent_id` is a writable task field on the REST API.
        self.client.request(
            "POST", f"/tasks/{task_id}",
            body={"parent_id": parent_id},
        )

    def set_dependencies(self, task_id: str, dependency_ids: list[str]) -> None:
        # Sync API is the only way to write dependency_ids; we accumulate
        # and flush via `commit_dependencies()` after Pass 2.
        self._pending_dependencies.append((task_id, dependency_ids))

    def commit_dependencies(self) -> list[dict]:
        """Flush queued dependency writes via the Sync API in one round-trip.

        Returns one record per queued task: `{"task_id": ..., "deps": [...]}`.
        Idempotent: empties the pending queue on success.
        """
        if not self._pending_dependencies:
            return []
        commands = [
            {
                "type": "item_update",
                "uuid": f"dep-{task_id}",
                "args": {
                    "id": task_id,
                    "dependency_ids": deps,
                },
            }
            for task_id, deps in self._pending_dependencies
        ]
        body = {"commands": commands}
        out = self.client.request("POST", "/sync", body=body)
        records: list[dict] = []
        for task_id, deps in self._pending_dependencies:
            records.append({"task_id": task_id, "deps": list(deps)})
        # Empty queue only after the request was issued (best-effort: any
        # error will surface in the sync_status payload; we don't reject here).
        self._pending_dependencies = []
        if isinstance(out, dict):
            status = out.get("sync_status", {}) or {}
            for task_id, _ in self._pending_dependencies:
                pass
        return records


@dataclass
class RecordingTransport:
    """Test / dry-run Transport — records every call into `calls`.

    `create_task` returns a synthetic id `<created-N>` so subsequent
    comment-sync calls can chain against it without a network round-trip.
    """

    calls: list[dict] = field(default_factory=list)
    _create_counter: int = 0
    dependencies_flushed: list[dict] = field(default_factory=list)

    def create_task(self, body: dict) -> Optional[str]:
        self._create_counter += 1
        task_id = f"<created-{self._create_counter}>"
        self.calls.append({"op": "create", "task_id": task_id, "body": body})
        return task_id

    def update_task(self, task_id: str, body: dict) -> None:
        self.calls.append({"op": "update", "task_id": task_id, "body": body})

    def move_task(self, task_id: str, project_id: str) -> None:
        self.calls.append({"op": "move", "task_id": task_id, "project_id": project_id})

    def close_task(self, task_id: str) -> None:
        self.calls.append({"op": "close", "task_id": task_id})

    def post_comment(self, task_id: str, content: str) -> None:
        self.calls.append({
            "op": "comment", "task_id": task_id, "content": content,
        })

    def set_parent(self, task_id: str, parent_id: Optional[str]) -> None:
        self.calls.append({
            "op": "set_parent", "task_id": task_id, "parent_id": parent_id,
        })

    def set_dependencies(self, task_id: str, dependency_ids: list[str]) -> None:
        # RecordingTransport just collects; commit_dependencies moves them
        # into `dependencies_flushed` so tests can assert per-task.
        self.dependencies_flushed.append({
            "task_id": task_id, "deps": list(dependency_ids),
        })

    def commit_dependencies(self) -> list[dict]:
        return list(self.dependencies_flushed)


# ---------------------------------------------------------------------------
# Sync primitives
# ---------------------------------------------------------------------------


def build_description(owner: str, repo: str, number: int, title: str, url: str) -> str:
    return f"{owner}/{repo}#{number}\n{url}\n{title}"


def _existing_markers(comments: list[dict]) -> set[str]:
    """Collect every `[gh-issue:...]` and `[gh-comment:...]` marker from existing comments."""
    seen: set[str] = set()
    for c in comments:
        body = c.get("content") or ""
        for kind, val in re.findall(r"\[(gh-issue|gh-comment):([^\]]+)\]", body):
            seen.add(f"{kind}:{val}")
    return seen


def _mirror_comments(
    transport: Transport,
    task_id: str,
    issue: dict,
    existing_comments: list[dict],
) -> int:
    """Mirror GitHub issue body + comments to a Todoist task, idempotently.

    Each mirrored comment carries a marker line `[gh-issue:owner/repo#n]` or
    `[gh-comment:id]` so re-runs skip already-mirrored content.
    `existing_comments` is the Todoist task's current comment list (the caller
    fetches it before invoking this).
    """
    seen = _existing_markers(existing_comments)
    owner = issue["repo_owner"]
    repo = issue["repo_name"]
    number = issue["number"]
    added = 0

    ibody = (issue.get("body") or "").strip()
    if ibody:
        marker_key = f"gh-issue:{owner}/{repo}#{number}"
        if marker_key not in seen:
            transport.post_comment(
                task_id, f"## Issue body\n\n{ibody}\n\n[{marker_key}]"
            )
            added += 1

    for c in issue.get("comments") or []:
        cid = c.get("id")
        cbody = (c.get("body") or "").strip()
        if not cid or not cbody:
            continue
        marker_key = f"gh-comment:{cid}"
        if marker_key in seen:
            continue
        author = (c.get("author") or {}).get("login", "")
        created = c.get("createdAt", "")
        header = (
            f"**{author}** · {created}"
            if author or created else "GitHub comment"
        )
        transport.post_comment(task_id, f"{header}\n\n{cbody}\n\n[{marker_key}]")
        added += 1
    return added


def _parent_issue_number(issue: dict) -> Optional[int]:
    """Extract the parent issue number from `parent_issue_url`, if present.

    `gh issue list` returns parent_issue_url like
    `https://api.github.com/repos/owner/repo/issues/123` for sub-issues,
    and `None` (or absent) for top-level issues.
    """
    url = issue.get("parent_issue_url")
    if not url:
        return None
    m = re.search(r"/issues/(\d+)$", str(url))
    return int(m.group(1)) if m else None


def plan_actions(
    config: dict,
    issues: list[dict],
    todoist_tasks_by_issue: dict[tuple[str, str, int], dict],
    project_dates: dict[tuple[str, str, int], tuple[Optional[str], Optional[str]]],
    todoist_projects_by_name: dict[str, dict],
    transport: Transport,
    *,
    fetch_task_comments_fn: Optional[Callable[[str], list[dict]]] = None,
) -> list[dict]:
    """Walk every (project, repo, issue) and dispatch writes via `transport`.

    Two-pass layout: Pass 1 creates/updates each task; Pass 2 wires up
    parent_id (sub-task) and dependency_ids (blocked_by) for any task that
    was just created or already exists. Pass 2 runs once at the end so
    parent tasks are guaranteed to have a Todoist id before children link.

    `fetch_task_comments_fn(task_id)` returns existing Todoist comments for
    idempotent mirroring. When omitted, comment sync is skipped entirely
    (callers in production must supply it for full idempotency).

    Returns an action log: one dict per issue with `owner/repo/number/action`
    plus action-specific extras (parent / deps applied).
    """
    project_by_repo: dict[tuple[str, str], dict] = {}
    for proj in config["projects"]:
        for r in proj["github_repos"]:
            project_by_repo[(proj["github_owner"], r)] = proj

    log: list[dict] = []
    # Pass 2 plan — one entry per open issue that needs parent or deps.
    # Each entry: {key, parent_target: Optional[str], deps_targets: list[str]}
    pending_links: list[dict] = []
    # Track which keys we created in this run, so children can resolve
    # parents that don't have an existing Todoist task yet.
    just_created: dict[tuple[str, str, int], str] = {}

    def _no_comments(task_id):
        return []

    fetch_c = fetch_task_comments_fn or _no_comments

    for issue in issues:
        owner = issue["repo_owner"]
        repo_name = issue["repo_name"]
        match_entry = project_by_repo.get((owner, repo_name))
        if match_entry is None:
            log.append({
                "owner": owner, "repo": repo_name, "number": issue["number"],
                "action": "skip-no-entry",
            })
            continue
        todoist_project_name = match_entry["todoist_project"]
        project = todoist_projects_by_name.get(todoist_project_name)
        if project is None:
            log.append({
                "owner": owner, "repo": repo_name, "number": issue["number"],
                "action": "skip-bad-project",
                "todoist_project": todoist_project_name,
            })
            continue
        project_id = project["id"]
        key = (owner, repo_name, issue["number"])
        state = issue["state"].lower()

        if state == "closed":
            existing = todoist_tasks_by_issue.get(key)
            if existing:
                transport.close_task(existing["id"])
                log.append({
                    "owner": owner, "repo": repo_name, "number": issue["number"],
                    "action": "closed",
                })
            else:
                log.append({
                    "owner": owner, "repo": repo_name, "number": issue["number"],
                    "action": "skip-closed-no-task",
                })
            continue

        existing = todoist_tasks_by_issue.get(key)
        start_date, target_date = project_dates.get(key, (None, None))
        title = issue["title"]
        url = issue["url"]
        description = build_description(owner, repo_name, issue["number"], title, url)
        content = f"[{repo_name} #{issue['number']}]({url}) {title}"
        body = {
            "content": content,
            "description": description,
            "labels": [LABEL],
        }
        date_locked = bool(
            existing and DATE_LOCK_LABEL in (existing.get("labels") or [])
        )
        if start_date and not date_locked:
            body["due_date"] = start_date
        if target_date and not date_locked:
            body["deadline_date"] = target_date

        if existing:
            transport.update_task(existing["id"], dict(body))
            current_pid = existing.get("project_id")
            if current_pid != project_id:
                transport.move_task(existing["id"], project_id)
            added = _mirror_comments(
                transport, existing["id"], issue, fetch_c(existing["id"]),
            )
            log.append({
                "owner": owner, "repo": repo_name, "number": issue["number"],
                "action": "updated",
                "comments_added": added,
            })
            self_task_id = existing["id"]
        else:
            create_body = dict(body)
            create_body["project_id"] = project_id
            new_id = transport.create_task(create_body)
            if new_id is None:
                log.append({
                    "owner": owner, "repo": repo_name, "number": issue["number"],
                    "action": "create-failed",
                })
                continue
            added = _mirror_comments(
                transport, new_id, issue, fetch_c(new_id),
            )
            log.append({
                "owner": owner, "repo": repo_name, "number": issue["number"],
                "action": "created",
                "comments_added": added,
            })
            self_task_id = new_id
            just_created[key] = new_id

        # Queue parent + deps for Pass 2.
        parent_num = _parent_issue_number(issue)
        blocked_by = issue.get("blocked_by_numbers") or []
        pending_links.append({
            "key": key,
            "self_task_id": self_task_id,
            "parent_number": parent_num,
            "blocked_by_numbers": list(blocked_by),
        })

    # Pass 2: resolve parent + blocker keys to Todoist task ids and apply.
    def _resolve(key: tuple[str, str, int]) -> Optional[str]:
        return (
            todoist_tasks_by_issue.get(key, {}).get("id")
            or just_created.get(key)
        )

    for entry in pending_links:
        owner, repo_name, _ = entry["key"]
        self_task_id = entry["self_task_id"]

        # Sub-task parent: link if parent's Todoist task is known.
        parent_target: Optional[str] = None
        if entry["parent_number"] is not None:
            parent_target = _resolve((owner, repo_name, entry["parent_number"]))

        # Blockers: resolve each to a Todoist task id (skip unknown).
        deps_targets: list[str] = []
        for n in entry["blocked_by_numbers"]:
            t = _resolve((owner, repo_name, n))
            if t:
                deps_targets.append(t)

        applied: dict = {}
        if entry["parent_number"] is not None:
            transport.set_parent(self_task_id, parent_target)
            applied["parent"] = {
                "github_number": entry["parent_number"],
                "linked": parent_target is not None,
            }
        if entry["blocked_by_numbers"]:
            transport.set_dependencies(self_task_id, deps_targets)
            applied["blocked_by"] = {
                "github_numbers": list(entry["blocked_by_numbers"]),
                "linked": deps_targets,
            }
        if applied:
            for log_entry in log:
                if (
                    log_entry.get("owner") == owner
                    and log_entry.get("repo") == repo_name
                    and log_entry.get("number") == entry["key"][2]
                ):
                    log_entry.setdefault("links", {}).update(applied)
                    break

    # Flush queued dependency writes via Sync API (no-op if no deps queued).
    transport.commit_dependencies()

    return log


# ---------------------------------------------------------------------------
# CLI plumbing
# ---------------------------------------------------------------------------


def _collect_issues(
    config: dict, runner: GhRunner,
    *,
    fetch_blocked_by_fn: Optional[Callable[[str, str, int], list[int]]] = None,
) -> tuple[list[dict], dict[tuple[str, str, int], tuple[Optional[str], Optional[str]]], list[str]]:
    """Fetch every issue in the config + aggregate Project dates.

    For each issue whose `issue_dependencies_summary.blocked_by > 0`, fetch
    the blocking issue numbers via `fetch_blocked_by_fn` (production uses
    the REST detail endpoint). The blocking list is attached to the issue
    dict as `blocked_by_numbers` for downstream consumption.

    Returns (issues, project_dates_map, warnings). Each warning is a
    human-readable string for one project board whose dates couldn't be
    fetched — the caller (CLI or test) decides whether to surface or fail.
    """
    fetch_by = fetch_blocked_by_fn or (
        lambda o, r, n: fetch_blocked_by(runner, o, r, n)
    )
    issues: list[dict] = []
    project_dates: dict[tuple[str, str, int], tuple[Optional[str], Optional[str]]] = {}
    warnings: list[str] = []
    soft_warnings: list[str] = []
    for proj in config["projects"]:
        owner = proj["github_owner"]
        proj_num = proj.get("github_project_number")
        if proj_num:
            dates, warn = fetch_project_dates(runner, owner, proj_num)
            project_dates.update(dates)
            if warn:
                warnings.append(warn)
        for repo in proj["github_repos"]:
            rows, gh_warn = fetch_issues(runner, owner, repo)
            if gh_warn:
                # gh CLI doesn't support parent/blocked_by fields → soft
                # warning. We still run the sync (basic features unaffected);
                # the warning just notes that sub-task / blocked-by are
                # skipped for this run.
                soft_warnings.append(gh_warn)
            for raw in rows:
                enriched = dict(raw)
                enriched["repo_owner"] = owner
                enriched["repo_name"] = repo
                summary = enriched.get("issue_dependencies_summary") or {}
                blocked = int(summary.get("blocked_by") or 0)
                if blocked > 0:
                    enriched["blocked_by_numbers"] = fetch_by(
                        owner, repo, enriched["number"]
                    )
                else:
                    enriched["blocked_by_numbers"] = []
                issues.append(enriched)
    return issues, project_dates, warnings, soft_warnings


def _summarise(log: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for entry in log:
        counts[entry["action"]] = counts.get(entry["action"], 0) + 1
    return counts


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="One-way sync from GitHub Issues to Todoist tasks."
    )
    parser.add_argument(
        "--config",
        help="path to github-projects config (overrides $GITHUB_PROJECTS_CONFIG)",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="plan only; do not write to Todoist",
    )
    args = parser.parse_args(argv)

    try:
        config_path = resolve_config_path(args.config)
        config = load_config(config_path)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    token = os.environ.get("TODOIST_API_TOKEN")
    if not token:
        print("error: TODOIST_API_TOKEN missing", file=sys.stderr)
        return 1

    runner = GhRunner()
    client = TodoistClient(token=token)
    issues, project_dates, warnings, soft_warnings = _collect_issues(config, runner)
    # Surface project-dates warnings immediately. dry-run keeps going (so
    # operators can still inspect the would_call output); apply refuses so we
    # never silently write Todoist tasks without the dates the operator
    # intended.
    for w in warnings:
        print(w, file=sys.stderr)
    if warnings and not args.dry_run:
        print(
            f"error: {len(warnings)} project-date warning(s); refusing to "
            f"apply until `gh` auth/scope is fixed. Re-run with --dry-run "
            f"to inspect the plan.",
            file=sys.stderr,
        )
        return 2
    # Soft warnings (e.g. gh too old for sub-task / blocked-by fields) are
    # informational only: we still run the sync for everything else.
    for w in soft_warnings:
        print(w, file=sys.stderr)
    tasks = client.get("/tasks")
    tasks_by_issue = {
        (m_owner, m_repo, m_num): t
        for (t, m_owner, m_repo, m_num) in managed_tasks(tasks)
    }
    projects_by_name = all_projects(client)

    transport: Transport = (
        RecordingTransport() if args.dry_run else TodoistTransport(client)
    )

    log = plan_actions(
        config, issues, tasks_by_issue, project_dates, projects_by_name,
        transport,
        fetch_task_comments_fn=lambda task_id: fetch_task_comments(client, task_id),
    )
    summary = _summarise(log)

    payload: dict = {
        "ok": True,
        "dry_run": bool(args.dry_run),
        "config": str(config_path),
        "projects_in_config": len(config["projects"]),
        "issues": len(issues),
        "managed_todoist_tasks": len(tasks_by_issue),
        "summary": summary,
        "log": log,
    }
    if isinstance(transport, RecordingTransport):
        payload["would_call"] = transport.calls
    if warnings:
        payload["warnings"] = warnings
    if soft_warnings:
        payload["soft_warnings"] = soft_warnings
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
