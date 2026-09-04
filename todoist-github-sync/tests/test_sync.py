"""Tests for github_todoist_sync.py.

Covers config loading, URL parsing, plan_actions dispatch logic,
comment idempotency, fetch_project_dates warnings, and CLI surface.
"""
import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _loader import load_module

_sync_mod = load_module("github_todoist_sync")

load_config = _sync_mod.load_config
resolve_config_path = _sync_mod.resolve_config_path
ConfigError = _sync_mod.ConfigError
plan_actions = _sync_mod.plan_actions
build_description = _sync_mod.build_description
managed_tasks = _sync_mod.managed_tasks
LABEL = _sync_mod.LABEL
DATE_LOCK_LABEL = _sync_mod.DATE_LOCK_LABEL
RecordingTransport = _sync_mod.RecordingTransport
TodoistTransport = _sync_mod.TodoistTransport
fetch_task_comments = _sync_mod.fetch_task_comments
fetch_project_dates = _sync_mod.fetch_project_dates
fetch_blocked_by = _sync_mod.fetch_blocked_by
main = _sync_mod.main


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _basic_config() -> dict:
    return {
        "$schema_version": "1.0",
        "projects": [
            {
                "name": "RZDC Philippines VH",
                "github_owner": "tetra4rnav",
                "github_repos": ["RZDC_Philippines_VH"],
                "todoist_project": "RZDC Philippines",
                "github_project_number": 4,
            },
            {
                "name": "DAGpedia",
                "github_owner": "diaphana-io",
                "github_repos": ["diaphana-corporate", "dagpedia-meta"],
                "todoist_project": "DAGpedia/Diaphana",
                "github_project_number": None,
            },
        ],
    }


def _issue(
    owner: str, repo: str, n: int, title: str = "x",
    state: str = "OPEN", body: str = "body text",
    url: str = "https://example.com",
    comments: list | None = None,
    parent_issue_url: object = None,
    blocked_by_numbers: list | None = None,
    issue_dependencies_summary: dict | None = None,
) -> dict:
    return {
        "number": n, "title": title, "state": state,
        "url": url, "body": body, "comments": comments or [],
        "repo_owner": owner, "repo_name": repo,
        "parent_issue_url": parent_issue_url,
        "sub_issues_summary": {},
        "issue_dependencies_summary": issue_dependencies_summary or {},
        "blocked_by_numbers": list(blocked_by_numbers or []),
    }


def _projects_by_name() -> dict[str, dict]:
    return {
        "RZDC Philippines": {"id": "p1", "name": "RZDC Philippines"},
        "DAGpedia/Diaphana": {"id": "p2", "name": "DAGpedia/Diaphana"},
    }


# ---------------------------------------------------------------------------
# Config tests
# ---------------------------------------------------------------------------


class LoadConfigTests(unittest.TestCase):

    def test_loads_minimal_valid_config(self):
        p = Path("/tmp/_test_cfg_ok.json")
        p.write_text(json.dumps(_basic_config()))
        try:
            data = load_config(p)
            self.assertEqual(data["$schema_version"], "1.0")
            self.assertEqual(len(data["projects"]), 2)
        finally:
            p.unlink(missing_ok=True)

    def test_missing_file_raises(self):
        with self.assertRaises(ConfigError) as cm:
            load_config(Path("/tmp/_does_not_exist_cfg.json"))
        self.assertIn("not found", str(cm.exception))

    def test_bad_json_raises(self):
        p = Path("/tmp/_test_cfg_bad.json")
        p.write_text("{not valid")
        try:
            with self.assertRaises(ConfigError):
                load_config(p)
        finally:
            p.unlink(missing_ok=True)

    def test_wrong_schema_version_raises(self):
        p = Path("/tmp/_test_cfg_version.json")
        p.write_text(json.dumps({"$schema_version": "0.9", "projects": [{}]}))
        try:
            with self.assertRaises(ConfigError) as cm:
                load_config(p)
            self.assertIn("schema_version", str(cm.exception))
        finally:
            p.unlink(missing_ok=True)

    def test_empty_projects_raises(self):
        p = Path("/tmp/_test_cfg_empty.json")
        p.write_text(json.dumps({"$schema_version": "1.0", "projects": []}))
        try:
            with self.assertRaises(ConfigError) as cm:
                load_config(p)
            self.assertIn("empty", str(cm.exception))
        finally:
            p.unlink(missing_ok=True)

    def test_missing_required_key_raises(self):
        cfg = _basic_config()
        cfg["projects"][0].pop("todoist_project")
        p = Path("/tmp/_test_cfg_missing.json")
        p.write_text(json.dumps(cfg))
        try:
            with self.assertRaises(ConfigError) as cm:
                load_config(p)
            self.assertIn("todoist_project", str(cm.exception))
        finally:
            p.unlink(missing_ok=True)

    def test_non_list_github_repos_raises(self):
        cfg = _basic_config()
        cfg["projects"][0]["github_repos"] = "not a list"
        p = Path("/tmp/_test_cfg_repos.json")
        p.write_text(json.dumps(cfg))
        try:
            with self.assertRaises(ConfigError) as cm:
                load_config(p)
            self.assertIn("github_repos", str(cm.exception))
        finally:
            p.unlink(missing_ok=True)

    def test_resolve_config_path_prefers_flag(self):
        self.assertEqual(resolve_config_path("/tmp/_from_flag.json"),
                         Path("/tmp/_from_flag.json"))

    def test_resolve_config_path_falls_back_to_env(self):
        old = os.environ.get("GITHUB_PROJECTS_CONFIG")
        os.environ["GITHUB_PROJECTS_CONFIG"] = "/tmp/_from_env.json"
        try:
            self.assertEqual(resolve_config_path(None),
                             Path("/tmp/_from_env.json"))
        finally:
            if old is None:
                os.environ.pop("GITHUB_PROJECTS_CONFIG", None)
            else:
                os.environ["GITHUB_PROJECTS_CONFIG"] = old

    def test_resolve_config_path_no_source_raises(self):
        old = os.environ.pop("GITHUB_PROJECTS_CONFIG", None)
        try:
            with self.assertRaises(ConfigError):
                resolve_config_path(None)
        finally:
            if old is not None:
                os.environ["GITHUB_PROJECTS_CONFIG"] = old


# ---------------------------------------------------------------------------
# URL / label parsing tests
# ---------------------------------------------------------------------------


class ManagedTasksTests(unittest.TestCase):

    def test_picks_label_and_url(self):
        tasks = [
            {
                "id": "t1", "labels": [LABEL],
                "description": "tetra4rnav/RZDC_Philippines_VH#1\nhttps://github.com/tetra4rnav/RZDC_Philippines_VH/issues/1\ntitle",
            },
            {"id": "t2", "labels": ["other"], "description": "anything"},
            {
                "id": "t3", "labels": [LABEL],
                "description": "no url here",
            },
        ]
        result = managed_tasks(tasks)
        self.assertEqual(len(result), 1)
        task, owner, repo, num = result[0]
        self.assertEqual(task["id"], "t1")
        self.assertEqual((owner, repo, num), ("tetra4rnav", "RZDC_Philippines_VH", 1))

    def test_handles_missing_labels(self):
        tasks = [{"id": "t1", "description": ""}]
        self.assertEqual(managed_tasks(tasks), [])


# ---------------------------------------------------------------------------
# Plan / dispatch tests
# ---------------------------------------------------------------------------


class PlanActionsCreateTests(unittest.TestCase):

    def test_creates_task_for_new_issue(self):
        cfg = _basic_config()
        issues = [_issue("tetra4rnav", "RZDC_Philippines_VH", 1)]
        transport = RecordingTransport()
        log = plan_actions(
            cfg, issues, {}, {}, _projects_by_name(), transport,
        )
        self.assertEqual(len(log), 1)
        self.assertEqual(log[0]["action"], "created")
        creates = [c for c in transport.calls if c["op"] == "create"]
        self.assertEqual(len(creates), 1)
        self.assertEqual(creates[0]["body"]["project_id"], "p1")
        self.assertEqual(creates[0]["body"]["labels"], [LABEL])
        self.assertIn("RZDC_Philippines_VH #1", creates[0]["body"]["content"])
        self.assertIn("https://example.com", creates[0]["body"]["description"])

    def test_skips_issue_for_unknown_repo(self):
        cfg = _basic_config()
        issues = [_issue("stranger", "unknown-repo", 1)]
        transport = RecordingTransport()
        log = plan_actions(
            cfg, issues, {}, {}, _projects_by_name(), transport,
        )
        self.assertEqual(log[0]["action"], "skip-no-entry")
        self.assertEqual(transport.calls, [])

    def test_skips_issue_for_unknown_todoist_project(self):
        cfg = _basic_config()
        projects = {"RZDC Philippines": {"id": "p1", "name": "RZDC Philippines"}}
        issues = [_issue("diaphana-io", "diaphana-corporate", 1)]
        transport = RecordingTransport()
        log = plan_actions(
            cfg, issues, {}, {}, projects, transport,
        )
        self.assertEqual(log[0]["action"], "skip-bad-project")
        self.assertEqual(transport.calls, [])


class PlanActionsUpdateTests(unittest.TestCase):

    def test_updates_existing_task(self):
        cfg = _basic_config()
        issues = [_issue("tetra4rnav", "RZDC_Philippines_VH", 1, title="new")]
        tasks_by_issue = {
            ("tetra4rnav", "RZDC_Philippines_VH", 1): {
                "id": "existing-1", "labels": [LABEL],
                "project_id": "p1", "description": "",
            }
        }
        transport = RecordingTransport()
        log = plan_actions(
            cfg, issues, tasks_by_issue, {}, _projects_by_name(), transport,
        )
        self.assertEqual(log[0]["action"], "updated")
        updates = [c for c in transport.calls if c["op"] == "update"]
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]["task_id"], "existing-1")
        self.assertIn("new", updates[0]["body"]["content"])

    def test_moves_task_when_project_differs(self):
        cfg = _basic_config()
        issues = [_issue("tetra4rnav", "RZDC_Philippines_VH", 1)]
        tasks_by_issue = {
            ("tetra4rnav", "RZDC_Philippines_VH", 1): {
                "id": "existing-1", "labels": [LABEL],
                "project_id": "OTHER-PROJECT", "description": "",
            }
        }
        transport = RecordingTransport()
        plan_actions(
            cfg, issues, tasks_by_issue, {}, _projects_by_name(), transport,
        )
        moves = [c for c in transport.calls if c["op"] == "move"]
        self.assertEqual(len(moves), 1)
        self.assertEqual(moves[0]["project_id"], "p1")

    def test_no_move_when_project_matches(self):
        cfg = _basic_config()
        issues = [_issue("tetra4rnav", "RZDC_Philippines_VH", 1)]
        tasks_by_issue = {
            ("tetra4rnav", "RZDC_Philippines_VH", 1): {
                "id": "existing-1", "labels": [LABEL],
                "project_id": "p1", "description": "",
            }
        }
        transport = RecordingTransport()
        plan_actions(
            cfg, issues, tasks_by_issue, {}, _projects_by_name(), transport,
        )
        moves = [c for c in transport.calls if c["op"] == "move"]
        self.assertEqual(moves, [])

    def test_applies_project_dates_for_unlocked_task(self):
        cfg = _basic_config()
        issues = [_issue("tetra4rnav", "RZDC_Philippines_VH", 1)]
        dates = {("tetra4rnav", "RZDC_Philippines_VH", 1):
                 ("2026-09-04", "2026-09-30")}
        tasks_by_issue = {
            ("tetra4rnav", "RZDC_Philippines_VH", 1): {
                "id": "existing-1", "labels": [LABEL],
                "project_id": "p1", "description": "",
            }
        }
        transport = RecordingTransport()
        plan_actions(
            cfg, issues, tasks_by_issue, dates, _projects_by_name(), transport,
        )
        update = [c for c in transport.calls if c["op"] == "update"][0]
        self.assertEqual(update["body"]["due_date"], "2026-09-04")
        self.assertEqual(update["body"]["deadline_date"], "2026-09-30")

    def test_skips_dates_for_date_locked_task(self):
        cfg = _basic_config()
        issues = [_issue("tetra4rnav", "RZDC_Philippines_VH", 1)]
        dates = {("tetra4rnav", "RZDC_Philippines_VH", 1):
                 ("2026-09-04", "2026-09-30")}
        tasks_by_issue = {
            ("tetra4rnav", "RZDC_Philippines_VH", 1): {
                "id": "existing-1", "labels": [LABEL, DATE_LOCK_LABEL],
                "project_id": "p1", "description": "",
            }
        }
        transport = RecordingTransport()
        plan_actions(
            cfg, issues, tasks_by_issue, dates, _projects_by_name(), transport,
        )
        update = [c for c in transport.calls if c["op"] == "update"][0]
        self.assertNotIn("due_date", update["body"])
        self.assertNotIn("deadline_date", update["body"])


class PlanActionsCloseTests(unittest.TestCase):

    def test_closes_existing_task_for_closed_issue(self):
        cfg = _basic_config()
        issues = [_issue("tetra4rnav", "RZDC_Philippines_VH", 1, state="CLOSED")]
        tasks_by_issue = {
            ("tetra4rnav", "RZDC_Philippines_VH", 1): {
                "id": "existing-1", "labels": [LABEL],
                "project_id": "p1", "description": "",
            }
        }
        transport = RecordingTransport()
        log = plan_actions(
            cfg, issues, tasks_by_issue, {}, _projects_by_name(), transport,
        )
        self.assertEqual(log[0]["action"], "closed")
        closes = [c for c in transport.calls if c["op"] == "close"]
        self.assertEqual(len(closes), 1)

    def test_no_close_when_task_absent(self):
        cfg = _basic_config()
        issues = [_issue("tetra4rnav", "RZDC_Philippines_VH", 1, state="CLOSED")]
        transport = RecordingTransport()
        log = plan_actions(
            cfg, issues, {}, {}, _projects_by_name(), transport,
        )
        self.assertEqual(log[0]["action"], "skip-closed-no-task")
        self.assertEqual(transport.calls, [])


class CommentMirrorTests(unittest.TestCase):

    def _run_with_existing(self, existing):
        cfg = _basic_config()
        gh_comments = [
            {"id": 101, "body": "first", "author": {"login": "a"},
             "createdAt": "2026-09-01T00:00:00Z"},
            {"id": 102, "body": "second", "author": {"login": "b"},
             "createdAt": "2026-09-02T00:00:00Z"},
        ]
        issues = [_issue(
            "tetra4rnav", "RZDC_Philippines_VH", 1,
            body="issue body", comments=gh_comments,
        )]
        tasks_by_issue = {
            ("tetra4rnav", "RZDC_Philippines_VH", 1): {
                "id": "existing-1", "labels": [LABEL],
                "project_id": "p1", "description": "",
            }
        }
        transport = RecordingTransport()
        plan_actions(
            cfg, issues, tasks_by_issue, {}, _projects_by_name(), transport,
            fetch_task_comments_fn=lambda tid: existing,
        )
        return transport

    def test_posts_body_and_all_comments_when_none_seen(self):
        transport = self._run_with_existing([])
        comments = [c for c in transport.calls if c["op"] == "comment"]
        self.assertEqual(len(comments), 3)
        body_comment = next(c for c in comments if "gh-issue:" in c["content"])
        self.assertIn("issue body", body_comment["content"])
        self.assertTrue(any("gh-comment:101" in c["content"] for c in comments))
        self.assertTrue(any("gh-comment:102" in c["content"] for c in comments))

    def test_skips_already_mirrored_body(self):
        transport = self._run_with_existing([
            {"content": "## Issue body\n\nissue body\n\n[gh-issue:tetra4rnav/RZDC_Philippines_VH#1]"},
        ])
        comments = [c for c in transport.calls if c["op"] == "comment"]
        self.assertEqual(len(comments), 2)
        self.assertFalse(any("gh-issue:" in c["content"] for c in comments))

    def test_skips_already_mirrored_comment(self):
        transport = self._run_with_existing([
            {"content": "**a** · t\n\nfirst\n\n[gh-comment:101]"},
        ])
        comments = [c for c in transport.calls if c["op"] == "comment"]
        self.assertEqual(len(comments), 2)
        posted_ids = [c["content"] for c in comments
                      if "gh-comment:" in c["content"]]
        self.assertTrue(any("gh-comment:102" in c for c in posted_ids))
        self.assertFalse(any("gh-comment:101" in c for c in posted_ids))


class DescriptionBuilderTests(unittest.TestCase):
    def test_build_description(self):
        d = build_description("o", "r", 7, "T", "https://example")
        self.assertEqual(d, "o/r#7\nhttps://example\nT")


# ---------------------------------------------------------------------------
# fetch_project_dates warning tests
# ---------------------------------------------------------------------------


class _FakeGhRunner:
    """Minimal stand-in for GhRunner that returns canned (rc, stdout, stderr)."""
    def __init__(self, rc=0, stdout="{}", stderr=""):
        self.rc = rc
        self.stdout = stdout
        self.stderr = stderr
        self.calls = []
    def run(self, args, timeout=60):
        self.calls.append(args)
        return self.rc, self.stdout, self.stderr


class FetchProjectDatesTests(unittest.TestCase):

    def test_success_no_warning(self):
        runner = _FakeGhRunner(
            rc=0,
            stdout=json.dumps({"items": [
                {"content": {"repository": "me/r", "number": 1},
                 "start date": "2026-09-04", "target date": "2026-09-30"},
            ]}),
        )
        dates, warn = fetch_project_dates(runner, "me", 4)
        self.assertIsNone(warn)
        self.assertEqual(dates[("me", "r", 1)], ("2026-09-04", "2026-09-30"))

    def test_403_warns_with_scope_hint(self):
        runner = _FakeGhRunner(rc=1, stderr="Resource not accessible by personal access token")
        dates, warn = fetch_project_dates(runner, "me", 4)
        self.assertEqual(dates, {})
        self.assertIsNotNone(warn)
        self.assertIn("read:project", warn)
        self.assertIn("read:org", warn)
        self.assertIn("me#4", warn)

    def test_unknown_owner_warns(self):
        runner = _FakeGhRunner(rc=1, stderr="unknown owner type")
        dates, warn = fetch_project_dates(runner, "me", 4)
        self.assertEqual(dates, {})
        self.assertIn("@me", warn)

    def test_invalid_json_warns(self):
        runner = _FakeGhRunner(rc=0, stdout="{not valid json")
        dates, warn = fetch_project_dates(runner, "me", 4)
        self.assertEqual(dates, {})
        self.assertIn("invalid JSON", warn)

    def test_empty_items_warns(self):
        runner = _FakeGhRunner(rc=0, stdout=json.dumps({"items": []}))
        dates, warn = fetch_project_dates(runner, "me", 4)
        self.assertEqual(dates, {})
        self.assertIn("no items", warn)

    def test_items_without_issue_links_warns(self):
        runner = _FakeGhRunner(rc=0, stdout=json.dumps({"items": [
            {"content": None, "start date": "2026-09-04"},  # draft item, no issue
            {"content": {}, "target date": "2026-09-30"},  # also no issue
        ]}))
        dates, warn = fetch_project_dates(runner, "me", 4)
        self.assertEqual(dates, {})
        self.assertIn("none are linked to issues", warn)


# ---------------------------------------------------------------------------
# CLI tests (error paths only)
# ---------------------------------------------------------------------------


class CliTests(unittest.TestCase):
    """CLI smoke tests covering only the error paths.

    The success path (--dry-run / --apply) requires real `gh` and Todoist
    network calls; logic there is covered by plan_actions / fetch_project_dates
    tests using fakes.
    """

    def _write_config(self, cfg=None) -> Path:
        cfg = cfg or _basic_config()
        p = Path("/tmp/_test_sync_cfg.json")
        p.write_text(json.dumps(cfg))
        return p

    def test_no_config_errors(self):
        old = os.environ.pop("GITHUB_PROJECTS_CONFIG", None)
        try:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()) as err:
                rc = main(["--dry-run"])
            self.assertEqual(rc, 1)
            self.assertIn("no config", err.getvalue())
        finally:
            if old is not None:
                os.environ["GITHUB_PROJECTS_CONFIG"] = old

    def test_no_token_errors(self):
        cfg_path = self._write_config()
        old_token = os.environ.pop("TODOIST_API_TOKEN", None)
        try:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()) as err:
                rc = main(["--config", str(cfg_path), "--dry-run"])
            self.assertEqual(rc, 1)
            self.assertIn("TODOIST_API_TOKEN", err.getvalue())
        finally:
            cfg_path.unlink(missing_ok=True)
            if old_token is not None:
                os.environ["TODOIST_API_TOKEN"] = old_token

    def test_bad_config_errors(self):
        bad = Path("/tmp/_test_sync_cfg_bad.json")
        bad.write_text("{not valid json")
        try:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()) as err:
                rc = main(["--config", str(bad), "--dry-run"])
            self.assertEqual(rc, 1)
            self.assertIn("not valid JSON", err.getvalue())
        finally:
            bad.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Sub-task (parent_id) + blocked-by (dependency) link tests
# ---------------------------------------------------------------------------


class _PARENT_URL:  # Lazy helper — matches the REST API format.
    """Return a GitHub API URL for `owner/repo/issues/parent_num`."""

    def __init__(self, owner: str, repo: str, parent_num: int):
        self.url = f"https://api.github.com/repos/{owner}/{repo}/issues/{parent_num}"

    def __str__(self):
        return self.url

    def __bool__(self):
        return True


class SubtaskParentTests(unittest.TestCase):

    def _run(self, issues, tasks_by_issue=None):
        cfg = _basic_config()
        transport = RecordingTransport()
        log = plan_actions(
            cfg, issues, tasks_by_issue or {}, {},
            _projects_by_name(), transport,
        )
        return log, transport

    def test_subtask_parent_is_set_when_parent_exists(self):
        """child issue has parent_issue_url and parent Todoist task exists."""
        parent_key = ("tetra4rnav", "RZDC_Philippines_VH", 10)
        child_key = ("tetra4rnav", "RZDC_Philippines_VH", 11)
        issues = [
            _issue(*parent_key, title="parent issue",
                   parent_issue_url=None),
            _issue(*child_key, title="child issue",
                   parent_issue_url=_PARENT_URL(*parent_key)),
        ]
        # Parent already has a Todoist task.
        existing = {
            parent_key: {"id": "t-parent", "labels": [LABEL],
                         "project_id": "p1", "description": ""},
        }
        log, transport = self._run(issues, existing)
        child_entry = [e for e in log if e.get("number") == 11]
        self.assertTrue(child_entry)
        self.assertIn("links", child_entry[0])
        self.assertIn("parent", child_entry[0]["links"])
        self.assertTrue(child_entry[0]["links"]["parent"]["linked"])
        # Check the parent write was queued (Sync API batch).
        self.assertEqual(len(transport.parents_flushed), 1)
        self.assertEqual(transport.parents_flushed[0]["parent_id"], "t-parent")

    def test_subtask_parent_set_when_parent_also_new(self):
        """Both parent + child are new; both created in Pass 1.

        Pass 2 must resolve the parent from `just_created` and wire it.
        """
        parent_key = ("tetra4rnav", "RZDC_Philippines_VH", 20)
        child_key = ("tetra4rnav", "RZDC_Philippines_VH", 21)
        issues = [
            _issue(*parent_key, parent_issue_url=None),
            _issue(*child_key,
                   parent_issue_url=_PARENT_URL(*parent_key)),
        ]
        log, transport = self._run(issues)
        child_entry = [e for e in log if e.get("number") == 21]
        self.assertTrue(child_entry)
        self.assertIn("links", child_entry[0])
        self.assertTrue(child_entry[0]["links"]["parent"]["linked"])
        # Parent should also be in the create calls.
        creates = [c for c in transport.calls if c["op"] == "create"]
        self.assertEqual(len(creates), 2)  # parent + child
        # And exactly one parent was queued (for the child only).
        self.assertEqual(len(transport.parents_flushed), 1)
        # The parent id should be a synthetic created id.
        self.assertIn("<created-", transport.parents_flushed[0]["parent_id"])

    def test_top_level_issue_has_no_parent_link(self):
        """An issue with no parent_issue_url produces no set_parent call."""
        issues = [_issue("tetra4rnav", "RZDC_Philippines_VH", 1,
                         parent_issue_url=None)]
        log, transport = self._run(issues)
        self.assertEqual(transport.parents_flushed, [])
        # Also no `links` key in the log entry.
        self.assertNotIn("links", log[0])

    def test_parent_not_in_todoist_skips_link(self):
        """If the parent issue was never synced to Todoist, parent is not set."""
        parent_key = ("tetra4rnav", "RZDC_Philippines_VH", 30)
        child_key = ("tetra4rnav", "RZDC_Philippines_VH", 31)
        issues = [
            _issue(*parent_key, title="parent", state="OPEN",
                   parent_issue_url=None),
            _issue(*child_key, title="child",
                   parent_issue_url=_PARENT_URL(*parent_key)),
        ]
        # Neither issue has an existing Todoist task; parent is OPEN so it
        # WILL be created in Pass 1, so it WILL get linked.
        log, transport = self._run(issues)
        self.assertEqual(len(transport.parents_flushed), 1)
        self.assertIn("<created-", transport.parents_flushed[0]["parent_id"])

    def test_closed_parent_not_in_todoist(self):
        """A closed parent that was never synced should NOT be auto-created.

        Only OPEN issues are created/updated by plan_actions.
        """
        parent_key = ("tetra4rnav", "RZDC_Philippines_VH", 40)
        child_key = ("tetra4rnav", "RZDC_Philippines_VH", 41)
        issues = [
            _issue(*parent_key, state="CLOSED",
                   parent_issue_url=None),
            _issue(*child_key,
                   parent_issue_url=_PARENT_URL(*parent_key)),
        ]
        log, transport = self._run(issues)
        child_entry = [e for e in log if e.get("number") == 41]
        self.assertTrue(child_entry)
        # Parent was CLOSED + not in Todoist → Pass 1 skipped it (closed),
        # so Pass 2 cannot resolve a parent_id. linked must be False.
        self.assertFalse(child_entry[0]["links"]["parent"]["linked"])
        # Github number is still recorded so we can audit.
        self.assertEqual(child_entry[0]["links"]["parent"]["github_number"], 40)


class BlockedByDependencyTests(unittest.TestCase):

    def _run(self, issues, tasks_by_issue=None):
        cfg = _basic_config()
        transport = RecordingTransport()
        log = plan_actions(
            cfg, issues, tasks_by_issue or {}, {},
            _projects_by_name(), transport,
        )
        return log, transport

    def test_blocked_by_creates_dependency(self):
        """Child issue blocked by parent; both open, both exist in Todoist."""
        blocker_key = ("tetra4rnav", "RZDC_Philippines_VH", 50)
        blocked_key = ("tetra4rnav", "RZDC_Philippines_VH", 51)
        issues = [
            _issue(*blocker_key, title="blocker", blocked_by_numbers=[]),
            _issue(*blocked_key, title="blocked",
                   blocked_by_numbers=[50]),
        ]
        existing = {
            blocker_key: {"id": "t-blocker", "labels": [LABEL],
                          "project_id": "p1", "description": ""},
            blocked_key: {"id": "t-blocked", "labels": [LABEL],
                          "project_id": "p1", "description": ""},
        }
        log, transport = self._run(issues, existing)
        blocked_entry = [e for e in log if e.get("number") == 51]
        self.assertTrue(blocked_entry)
        self.assertIn("links", blocked_entry[0])
        self.assertIn("blocked_by", blocked_entry[0]["links"])
        self.assertEqual(
            blocked_entry[0]["links"]["blocked_by"]["linked"],
            ["t-blocker"],
        )
        # Check the dependency was queued and flushed.
        self.assertEqual(len(transport.dependencies_flushed), 1)
        self.assertEqual(transport.dependencies_flushed[0]["task_id"],
                         "t-blocked")
        self.assertEqual(transport.dependencies_flushed[0]["deps"],
                         ["t-blocker"])

    def test_blocked_by_self_created(self):
        """Blocked issue is new; blocker is new; both created in Pass 1.

        Pass 2 must resolve both from `just_created` and queue deps.
        """
        blocker_key = ("tetra4rnav", "RZDC_Philippines_VH", 60)
        blocked_key = ("tetra4rnav", "RZDC_Philippines_VH", 61)
        issues = [
            _issue(*blocker_key, blocked_by_numbers=[]),
            _issue(*blocked_key, blocked_by_numbers=[60]),
        ]
        log, transport = self._run(issues)
        blocked_entry = [e for e in log if e.get("number") == 61]
        self.assertTrue(blocked_entry[0]["links"]["blocked_by"]["linked"])
        # Both were created as new tasks.
        creates = [c for c in transport.calls if c["op"] == "create"]
        self.assertEqual(len(creates), 2)
        # Dependency was queued for blocked issue.
        self.assertEqual(len(transport.dependencies_flushed), 1)
        self.assertEqual(transport.dependencies_flushed[0]["task_id"],
                         "<created-2>")
        self.assertEqual(transport.dependencies_flushed[0]["deps"],
                         ["<created-1>"])

    def test_no_deps_when_blocked_by_empty(self):
        """An issue with empty blocked_by_numbers produces no dependency."""
        issues = [
            _issue("tetra4rnav", "RZDC_Philippines_VH", 70,
                   blocked_by_numbers=[]),
        ]
        log, transport = self._run(issues)
        self.assertNotIn("links", log[0])
        self.assertEqual(transport.dependencies_flushed, [])

    def test_missing_blocker_not_linked(self):
        """If the blocker issue was never synced, skip it silently."""
        blocked_key = ("tetra4rnav", "RZDC_Philippines_VH", 81)
        issues = [
            _issue(*blocked_key, blocked_by_numbers=[80]),
        ]
        log, transport = self._run(issues)
        blocked_entry = [e for e in log if e.get("number") == 81]
        self.assertTrue(blocked_entry)
        self.assertIn("links", blocked_entry[0])
        # The blocker's issue 80 was not in the issue list / Todoist, so
        # the linked list is empty but the keys are recorded.
        self.assertEqual(blocked_entry[0]["links"]["blocked_by"]["linked"], [])

    def test_combined_parent_and_blocked_by(self):
        """Issue has BOTH a parent sub-issue AND a blocker dependency."""
        parent_key = ("tetra4rnav", "RZDC_Philippines_VH", 90)
        blocker_key = ("tetra4rnav", "RZDC_Philippines_VH", 91)
        child_key = ("tetra4rnav", "RZDC_Philippines_VH", 92)
        issues = [
            _issue(*parent_key, parent_issue_url=None, blocked_by_numbers=[]),
            _issue(*blocker_key, blocked_by_numbers=[]),
            _issue(*child_key,
                   parent_issue_url=_PARENT_URL(*parent_key),
                   blocked_by_numbers=[91]),
        ]
        existing = {
            parent_key: {"id": "t-parent", "labels": [LABEL],
                         "project_id": "p1", "description": ""},
            blocker_key: {"id": "t-blocker", "labels": [LABEL],
                          "project_id": "p1", "description": ""},
        }
        log, transport = self._run(issues, existing)
        child_entry = [e for e in log if e.get("number") == 92]
        self.assertTrue(child_entry)
        links = child_entry[0]["links"]
        self.assertTrue(links["parent"]["linked"])
        self.assertEqual(links["parent"]["github_number"], 90)
        self.assertTrue(links["blocked_by"]["linked"])
        self.assertEqual(links["blocked_by"]["github_numbers"], [91])
        # set_parent + 1 dependency in flushed queue.
        self.assertEqual(len(transport.parents_flushed), 1)
        self.assertEqual(transport.parents_flushed[0]["parent_id"], "t-parent")
        self.assertEqual(len(transport.dependencies_flushed), 1)

    def test_closed_blocked_issue_not_linked(self):
        """A closed blocker that was never synced is not auto-created."""
        blocker_key = ("tetra4rnav", "RZDC_Philippines_VH", 100)
        blocked_key = ("tetra4rnav", "RZDC_Philippines_VH", 101)
        issues = [
            _issue(*blocker_key, state="CLOSED", blocked_by_numbers=[]),
            _issue(*blocked_key, blocked_by_numbers=[100]),
        ]
        log, transport = self._run(issues)
        blocked_entry = [e for e in log if e.get("number") == 101]
        self.assertTrue(blocked_entry)
        # Blocker is CLOSED + never synced → not created → not linked.
        self.assertEqual(blocked_entry[0]["links"]["blocked_by"]["linked"], [])
        self.assertEqual(
            blocked_entry[0]["links"]["blocked_by"]["github_numbers"], [100],
        )


class FetchIssuesTests(unittest.TestCase):

    def _make_fake_runner(self, *calls):
        """GhRunner fake that returns one (rc, payload) per call.

        Each call arg may be a list (interpreted as rc=0 + that JSON) or
        a tuple `(rc, list_or_str)`. After all configured calls, returns
        rc=1 to signal error.
        """

        class FakeRunner:
            def __init__(self):
                self._call_count = 0
            def run(self, args, timeout=60):
                self._call_count += 1
                if self._call_count > len(calls):
                    return (1, "", "fallback error")
                spec = calls[self._call_count - 1]
                if isinstance(spec, tuple):
                    rc, payload = spec
                else:
                    rc, payload = 0, spec
                return (rc, json.dumps(payload) if payload is not None else "", "")

        return FakeRunner()

    def test_sets_parent_issue_url_default_when_omitted(self):
        """When gh returns rc=0 but omits the extra fields, defaults are
        applied (parent_issue_url=None, summary={}) so downstream code can
        read them unconditionally."""
        runner = self._make_fake_runner([
            {"number": 1, "title": "test", "state": "OPEN",
             "url": "https://example.com", "body": "", "comments": []},
        ])
        from github_todoist_sync import fetch_issues
        issues, warn = fetch_issues(runner, "owner", "repo")
        # rc=0 means gh accepted the extra-fields request; no warning.
        self.assertIsNone(warn)
        self.assertEqual(len(issues), 1)
        self.assertIsNone(issues[0]["parent"])
        self.assertEqual(issues[0]["blockedBy"], [])
        # Bridge synthesizes the synthetic fields when gh-native data is
        # missing, so downstream code can read them unconditionally.
        self.assertIsNone(issues[0].get("parent_issue_url"))
        self.assertEqual(issues[0].get("blocked_by_numbers"), [])

    def test_warns_when_gh_rejects_extra_fields(self):
        """When gh returns rc != 0 (older version), an upgrade warning is
        surfaced and the baseline fetch is used as a fallback."""
        # First call: rc=1 (older gh rejects extra fields).
        # Second call: rc=0 with baseline JSON.
        runner = self._make_fake_runner(
            (1, []),  # extra-fields call rejected
            [
                {"number": 1, "title": "test", "state": "OPEN",
                 "url": "https://example.com", "body": "", "comments": []},
            ],  # baseline call succeeds
        )
        from github_todoist_sync import fetch_issues
        issues, warn = fetch_issues(runner, "owner", "repo")
        self.assertIsNotNone(warn)
        # New gh-native field names appear in the warning.
        self.assertIn("parent", warn)
        self.assertIn("blockedBy", warn)
        self.assertIn("Upgrade", warn)
        self.assertEqual(len(issues), 1)
        self.assertIsNone(issues[0]["parent_issue_url"])

    def test_preserves_parent_issue_url_when_present(self):
        runner = self._make_fake_runner([
            {"number": 1, "title": "child", "state": "OPEN",
             "url": "https://example.com", "body": "", "comments": [],
             "parent_issue_url": "https://api.github.com/repos/o/r/issues/5",
             "issue_dependencies_summary": {"blocked_by": 0, "blocking": 0}},
        ])
        from github_todoist_sync import fetch_issues
        issues, warn = fetch_issues(runner, "owner", "repo")
        # Happy path: no upgrade warning.
        self.assertIsNone(warn)
        self.assertEqual(
            issues[0]["parent_issue_url"],
            "https://api.github.com/repos/o/r/issues/5",
        )


class FetchBlockedByTests(unittest.TestCase):

    def test_returns_issue_numbers(self):
        class FakeRunner:
            def run(self, args, timeout=60):
                return (0, json.dumps([
                    {"number": 5, "title": "blocker"},
                    {"number": 6, "title": "another blocker"},
                ]), "")

        from github_todoist_sync import fetch_blocked_by
        result = fetch_blocked_by(FakeRunner(), "owner", "repo", 10)
        self.assertEqual(result, [5, 6])

    def test_returns_empty_on_error(self):
        class FakeRunner:
            def run(self, args, timeout=60):
                return (1, "", "error")

        from github_todoist_sync import fetch_blocked_by
        result = fetch_blocked_by(FakeRunner(), "owner", "repo", 10)
        self.assertEqual(result, [])

    def test_returns_empty_on_non_array(self):
        class FakeRunner:
            def run(self, args, timeout=60):
                return (0, "not json", "")

        from github_todoist_sync import fetch_blocked_by
        result = fetch_blocked_by(FakeRunner(), "owner", "repo", 10)
        self.assertEqual(result, [])


class TodoistTransportDependencyTests(unittest.TestCase):

    def test_set_parent_queues_for_sync(self):
        """set_parent must NOT call the REST API (parent_id is not writable
        through POST /tasks/{id}); it queues for the Sync API flush."""
        client = mock.MagicMock()
        client.request.return_value = None
        t = TodoistTransport(client=client)
        t.set_parent("task-1", "parent-1")
        # Queued, not flushed yet.
        self.assertEqual(t._pending_parents, [("task-1", "parent-1")])
        client.request.assert_not_called()

    def test_set_dependencies_accumulates(self):
        client = mock.MagicMock()
        client.request.return_value = None
        t = TodoistTransport(client=client)
        t.set_dependencies("task-a", ["blocker-1", "blocker-2"])
        t.set_dependencies("task-b", ["blocker-3"])
        self.assertEqual(len(t._pending_dependencies), 2)
        self.assertEqual(t._pending_dependencies[0],
                         ("task-a", ["blocker-1", "blocker-2"]))
        # set_dependencies does NOT call client.request (queued for sync batch).
        client.request.assert_not_called()

    def test_commit_links_flushes_both_queues_via_sync(self):
        """commit_links issues ONE /sync call with item_update commands
        for both the parent_id queue and the dependency_ids queue."""
        client = mock.MagicMock()
        client.request.return_value = {"sync_status": {}, "full_sync": True}
        t = TodoistTransport(client=client)
        t.set_parent("p-task", "parent-1")
        t.set_parent("p-task-2", "parent-2")
        t.set_dependencies("d-task", ["b1"])
        t.set_dependencies("d-task-2", ["b2", "b3"])
        records = t.commit_links()
        self.assertEqual(len(records["parents"]), 2)
        self.assertEqual(records["parents"][0],
                         {"task_id": "p-task", "parent_id": "parent-1"})
        self.assertEqual(len(records["deps"]), 2)
        self.assertEqual(records["deps"][0],
                         {"task_id": "d-task", "deps": ["b1"]})
        # Verify ONE /sync call with all four commands.
        client.request.assert_called_once()
        args, kwargs = client.request.call_args
        self.assertEqual(args[0], "POST")
        self.assertEqual(args[1], "/sync")
        cmds = kwargs["body"]["commands"]
        self.assertEqual(len(cmds), 4)
        parent_cmds = [c for c in cmds if "parent_id" in c["args"]]
        self.assertEqual(len(parent_cmds), 2)
        self.assertEqual(parent_cmds[0]["type"], "item_update")
        self.assertEqual(parent_cmds[0]["args"]["parent_id"], "parent-1")
        dep_cmds = [c for c in cmds if "dependency_ids" in c["args"]]
        self.assertEqual(len(dep_cmds), 2)
        self.assertEqual(dep_cmds[0]["args"]["dependency_ids"], ["b1"])
        # Both queues now empty.
        self.assertEqual(t._pending_parents, [])
        self.assertEqual(t._pending_dependencies, [])

    def test_commit_links_noop_when_empty(self):
        client = mock.MagicMock()
        t = TodoistTransport(client=client)
        records = t.commit_links()
        self.assertEqual(records, {"parents": [], "deps": []})
        # No request should have been issued.
        client.request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
