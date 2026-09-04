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
fetch_task_comments = _sync_mod.fetch_task_comments
fetch_project_dates = _sync_mod.fetch_project_dates
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
) -> dict:
    return {
        "number": n, "title": title, "state": state,
        "url": url, "body": body, "comments": comments or [],
        "repo_owner": owner, "repo_name": repo,
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


if __name__ == "__main__":
    unittest.main()
