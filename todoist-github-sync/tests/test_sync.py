"""Tests for github_todoist_sync.py date-preservation behaviour.

Uses tests/_loader.py because `todoist-github-sync` contains a hyphen and
therefore can't be a normal Python package name.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _loader import load_module

_sync = load_module("github_todoist_sync")

apply_project_dates = _sync.apply_project_dates
plan_actions = _sync.plan_actions
RecordingTransport = _sync.RecordingTransport
LABEL = _sync.LABEL
DATE_LOCK_LABEL = _sync.DATE_LOCK_LABEL
parse_repo_spec = _sync.parse_repo_spec
ConfigError = _sync.ConfigError


def _body() -> dict:
    return {"content": "x", "description": "d", "labels": [LABEL]}


class ParseRepoSpecTests(unittest.TestCase):
    def test_owner_repo(self):
        self.assertEqual(parse_repo_spec("tetra4rnav/ideas-jetro"),
                         ("tetra4rnav", "ideas-jetro"))

    def test_rejects_bare_repo(self):
        with self.assertRaises(ConfigError):
            parse_repo_spec("ideas-jetro")

    def test_rejects_url(self):
        with self.assertRaises(ConfigError):
            parse_repo_spec("https://github.com/a/b")


class ApplyProjectDatesTests(unittest.TestCase):
    """Unit tests for apply_project_dates — the date-write policy."""

    def test_create_writes_both_dates(self):
        body = _body()
        skipped = apply_project_dates(
            body, start_date="2026-09-01", target_date="2026-09-10",
            existing=None,
        )
        self.assertEqual(skipped, [])
        self.assertEqual(body["due_date"], "2026-09-01")
        self.assertEqual(body["deadline_date"], "2026-09-10")

    def test_update_fills_empty_fields(self):
        body = _body()
        existing = {"id": "1", "labels": [LABEL], "due": None, "deadline": None}
        skipped = apply_project_dates(
            body, start_date="2026-09-01", target_date="2026-09-10",
            existing=existing,
        )
        self.assertEqual(skipped, [])
        self.assertEqual(body["due_date"], "2026-09-01")
        self.assertEqual(body["deadline_date"], "2026-09-10")

    def test_date_only_due_is_not_overwritten(self):
        body = _body()
        existing = {
            "id": "1", "labels": [LABEL],
            "due": {"date": "2026-09-05"},
            "deadline": None,
        }
        skipped = apply_project_dates(
            body, start_date="2026-09-01", target_date="2026-09-10",
            existing=existing,
        )
        self.assertEqual(skipped, ["due"])
        self.assertNotIn("due_date", body)
        self.assertEqual(body["deadline_date"], "2026-09-10")

    def test_timed_due_is_not_overwritten(self):
        body = _body()
        existing = {
            "id": "1", "labels": [LABEL],
            "due": {"date": "2026-09-05", "datetime": "2026-09-05T14:00:00"},
            "deadline": None,
        }
        skipped = apply_project_dates(
            body, start_date="2026-09-01", target_date=None,
            existing=existing,
        )
        self.assertEqual(skipped, ["due"])
        self.assertNotIn("due_date", body)

    def test_existing_deadline_is_not_overwritten(self):
        body = _body()
        existing = {
            "id": "1", "labels": [LABEL],
            "due": None,
            "deadline": {"date": "2026-09-20"},
        }
        skipped = apply_project_dates(
            body, start_date="2026-09-01", target_date="2026-09-10",
            existing=existing,
        )
        self.assertEqual(skipped, ["deadline"])
        self.assertEqual(body["due_date"], "2026-09-01")
        self.assertNotIn("deadline_date", body)

    def test_both_existing_dates_are_preserved(self):
        body = _body()
        existing = {
            "id": "1", "labels": [LABEL],
            "due": {"date": "2026-09-05"},
            "deadline": {"date": "2026-09-20"},
        }
        skipped = apply_project_dates(
            body, start_date="2026-09-01", target_date="2026-09-10",
            existing=existing,
        )
        self.assertEqual(skipped, ["due", "deadline"])
        self.assertNotIn("due_date", body)
        self.assertNotIn("deadline_date", body)

    def test_date_locked_skips_even_empty_fields(self):
        body = _body()
        existing = {
            "id": "1", "labels": [LABEL, DATE_LOCK_LABEL],
            "due": None, "deadline": None,
        }
        skipped = apply_project_dates(
            body, start_date="2026-09-01", target_date="2026-09-10",
            existing=existing,
        )
        self.assertEqual(skipped, ["due", "deadline"])
        self.assertNotIn("due_date", body)
        self.assertNotIn("deadline_date", body)

    def test_missing_github_dates_do_not_clear_todoist(self):
        body = _body()
        existing = {
            "id": "1", "labels": [LABEL],
            "due": {"date": "2026-09-05"},
            "deadline": {"date": "2026-09-20"},
        }
        skipped = apply_project_dates(
            body, start_date=None, target_date=None, existing=existing,
        )
        self.assertEqual(skipped, [])
        self.assertNotIn("due_date", body)
        self.assertNotIn("deadline_date", body)


def _config() -> dict:
    return {
        "$schema_version": "1.1",
        "projects": [{
            "name": "P",
            "github_repos": ["me/repo"],
            "todoist_project_id": "proj-1",
            "github_project_number": 1,
        }],
    }


def _issue(number: int = 1, title: str = "Title") -> dict:
    return {
        "repo_owner": "me",
        "repo_name": "repo",
        "number": number,
        "title": title,
        "state": "open",
        "url": f"https://github.com/me/repo/issues/{number}",
        "body": "",
        "comments": [],
        "parent_issue_url": None,
        "blocked_by_numbers": [],
    }


class PlanActionsDateSkipTests(unittest.TestCase):
    """plan_actions must not put Todoist-owned dates into the update body."""

    def test_update_skips_existing_due_and_deadline(self):
        existing = {
            "id": "task-1",
            "project_id": "proj-1",
            "labels": [LABEL],
            "due": {"date": "2026-09-05"},
            "deadline": {"date": "2026-09-20"},
            "description": "https://github.com/me/repo/issues/1",
        }
        transport = RecordingTransport()
        log = plan_actions(
            _config(),
            [_issue()],
            {("me", "repo", 1): existing},
            {("me", "repo", 1): ("2026-09-01", "2026-09-10")},
            {"proj-1": {"id": "proj-1", "name": "TodoistP"}},
            transport,
        )
        updates = [c for c in transport.calls if c["op"] == "update"]
        self.assertEqual(len(updates), 1)
        self.assertNotIn("due_date", updates[0]["body"])
        self.assertNotIn("deadline_date", updates[0]["body"])
        self.assertEqual(log[0]["skipped_dates"], ["due", "deadline"])

    def test_create_writes_github_dates(self):
        transport = RecordingTransport()
        plan_actions(
            _config(),
            [_issue()],
            {},
            {("me", "repo", 1): ("2026-09-01", "2026-09-10")},
            {"proj-1": {"id": "proj-1", "name": "TodoistP"}},
            transport,
        )
        creates = [c for c in transport.calls if c["op"] == "create"]
        self.assertEqual(len(creates), 1)
        self.assertEqual(creates[0]["body"]["due_date"], "2026-09-01")
        self.assertEqual(creates[0]["body"]["deadline_date"], "2026-09-10")


if __name__ == "__main__":
    unittest.main()
