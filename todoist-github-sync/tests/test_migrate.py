"""Tests for migrate_openclaw_registry.py.

Pure-function tests where possible; subprocess tests for the CLI surface.

Uses tests/_loader.py because `todoist-github-sync` contains a hyphen and
therefore can't be a normal Python package name.
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

_migrate_mod = load_module("migrate_openclaw_registry")

migrate = _migrate_mod.migrate
render = _migrate_mod.render
_migrate_entry = _migrate_mod._migrate_entry
_load_legacy = _migrate_mod._load_legacy
SCHEMA_VERSION = _migrate_mod.SCHEMA_VERSION
migrate_main = _migrate_mod.main


class MigrateEntryTests(unittest.TestCase):
    """Unit tests for _migrate_entry."""

    def test_single_repo_with_project_number(self):
        entry = {
            "key": "k",
            "name": "Project",
            "github": [
                {"owner": "me", "repo": "r", "github_project": {"number": 4}}
            ],
            "todoist_project": "TodoistName",
        }
        out, warnings = _migrate_entry(entry)
        self.assertEqual(warnings, [])
        self.assertEqual(out, {
            "name": "Project",
            "github_owner": "me",
            "github_repos": ["r"],
            "todoist_project": "TodoistName",
            "github_project_number": 4,
            "issue_labels_include": [],
            "issue_labels_exclude": [],
        })

    def test_multiple_repos_same_owner_no_project(self):
        entry = {
            "key": "k",
            "name": "DAGpedia",
            "github": [
                {"owner": "diaphana-io", "repo": "diaphana-corporate"},
                {"owner": "diaphana-io", "repo": "dagpedia-meta"},
            ],
            "todoist_project": "DAGpedia/Diaphana",
        }
        out, warnings = _migrate_entry(entry)
        self.assertEqual(warnings, [])
        self.assertEqual(out["github_repos"], ["diaphana-corporate", "dagpedia-meta"])
        self.assertEqual(out["github_project_number"], None)

    def test_skip_empty_github(self):
        entry = {"key": "k", "name": "Workout", "github": [], "todoist_project": "x"}
        out, warnings = _migrate_entry(entry)
        self.assertIsNone(out)
        self.assertEqual(len(warnings), 1)
        self.assertIn("github is empty", warnings[0])

    def test_skip_missing_todoist_project(self):
        entry = {
            "key": "k",
            "name": "Workout",
            "github": [{"owner": "me", "repo": "r"}],
            "todoist_project": None,
        }
        out, warnings = _migrate_entry(entry)
        self.assertIsNone(out)
        self.assertIn("todoist_project is null/empty", warnings[0])

    def test_skip_all_repos_invalid(self):
        entry = {
            "key": "k",
            "name": "broken",
            "github": [{"owner": "me"}, {"repo": "r"}],
            "todoist_project": "x",
        }
        out, warnings = _migrate_entry(entry)
        self.assertIsNone(out)
        self.assertEqual(len(warnings), 3)

    def test_rejects_multi_owner(self):
        entry = {
            "key": "k",
            "name": "split",
            "github": [
                {"owner": "me", "repo": "r1"},
                {"owner": "other", "repo": "r2"},
            ],
            "todoist_project": "x",
        }
        with self.assertRaises(ValueError) as cm:
            _migrate_entry(entry)
        self.assertIn("multiple distinct github owners", str(cm.exception))

    def test_rejects_multi_project_number(self):
        entry = {
            "key": "k",
            "name": "split",
            "github": [
                {"owner": "me", "repo": "r1", "github_project": {"number": 1}},
                {"owner": "me", "repo": "r2", "github_project": {"number": 2}},
            ],
            "todoist_project": "x",
        }
        with self.assertRaises(ValueError) as cm:
            _migrate_entry(entry)
        self.assertIn("multiple distinct github_project numbers", str(cm.exception))


class MigrateAggregateTests(unittest.TestCase):
    """Tests for migrate() across multiple entries."""

    def test_collects_warnings_and_errors(self):
        legacy = [
            {
                "key": "a", "name": "A",
                "github": [{"owner": "me", "repo": "a"}],
                "todoist_project": "TA",
            },
            {"key": "b", "name": "B", "github": [], "todoist_project": "TB"},
            {
                "key": "c", "name": "C",
                "github": [{"owner": "me", "repo": "c"}],
                "todoist_project": None,
            },
            {
                "key": "d", "name": "D",
                "github": [
                    {"owner": "me", "repo": "d1"},
                    {"owner": "other", "repo": "d2"},
                ],
                "todoist_project": "TD",
            },
        ]
        new, warns, errs = migrate(legacy)
        self.assertEqual([p["name"] for p in new], ["A"])
        self.assertEqual(len(warns), 2)
        self.assertEqual(len(errs), 1)
        self.assertIn("multiple distinct github owners", errs[0])

    def test_empty_input(self):
        new, warns, errs = migrate([])
        self.assertEqual(new, [])
        self.assertEqual(warns, [])
        self.assertEqual(errs, [])


class LoadLegacyTests(unittest.TestCase):

    def test_loads_list(self):
        p = Path("/tmp/_test_legacy.json")
        p.write_text(json.dumps([{"key": "x"}]))
        try:
            data = _load_legacy(p)
            self.assertEqual(data, [{"key": "x"}])
        finally:
            p.unlink(missing_ok=True)

    def test_missing_file_raises(self):
        with self.assertRaises(FileNotFoundError):
            _load_legacy(Path("/tmp/_does_not_exist_legacy.json"))

    def test_bad_json_raises(self):
        p = Path("/tmp/_test_legacy_bad.json")
        p.write_text("{not valid json")
        try:
            with self.assertRaises(ValueError):
                _load_legacy(p)
        finally:
            p.unlink(missing_ok=True)

    def test_non_list_raises(self):
        p = Path("/tmp/_test_legacy_obj.json")
        p.write_text(json.dumps({"projects": []}))
        try:
            with self.assertRaises(ValueError):
                _load_legacy(p)
        finally:
            p.unlink(missing_ok=True)


class RenderTests(unittest.TestCase):
    def test_render_wraps_with_schema_version(self):
        out = render([{"name": "X", "github_owner": "me", "github_repos": ["r"],
                       "todoist_project": "tx", "github_project_number": None,
                       "issue_labels_include": [], "issue_labels_exclude": []}])
        self.assertEqual(out["$schema_version"], SCHEMA_VERSION)
        self.assertEqual(len(out["projects"]), 1)
        self.assertIn("$comment", out)

    def test_render_empty(self):
        out = render([])
        self.assertEqual(out["projects"], [])


class CliTests(unittest.TestCase):

    def _write_legacy(self, data) -> Path:
        p = Path("/tmp/_test_migrate_src.json")
        p.write_text(json.dumps(data))
        return p

    def test_dry_run_prints_to_stdout_no_write(self):
        src = self._write_legacy([
            {"key": "k", "name": "P",
             "github": [{"owner": "me", "repo": "r"}],
             "todoist_project": "TP"},
        ])
        buf_out, buf_err = io.StringIO(), io.StringIO()
        try:
            with redirect_stdout(buf_out), redirect_stderr(buf_err):
                rc = migrate_main(["--source", str(src), "--dry-run"])
            self.assertEqual(rc, 0)
            written = json.loads(buf_out.getvalue())
            self.assertEqual(written["$schema_version"], SCHEMA_VERSION)
            self.assertEqual(written["projects"][0]["github_repos"], ["r"])
            self.assertIn("migrated 1 of 1", buf_err.getvalue())
        finally:
            src.unlink(missing_ok=True)

    def test_apply_writes_file(self):
        src = self._write_legacy([
            {"key": "k", "name": "P",
             "github": [{"owner": "me", "repo": "r"}],
             "todoist_project": "TP"},
        ])
        out = Path("/tmp/_test_migrate_out.json")
        try:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                rc = migrate_main(["--source", str(src), "--output", str(out)])
            self.assertEqual(rc, 0)
            self.assertTrue(out.exists())
            written = json.loads(out.read_text())
            self.assertEqual(written["projects"][0]["name"], "P")
        finally:
            src.unlink(missing_ok=True)
            out.unlink(missing_ok=True)

    def test_apply_requires_output_flag(self):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            rc = migrate_main(["--source", "/tmp/_nope.json"])
        self.assertEqual(rc, 2)

    def test_apply_refuses_on_errors(self):
        src = self._write_legacy([
            {"key": "d", "name": "D",
             "github": [
                 {"owner": "me", "repo": "d1"},
                 {"owner": "other", "repo": "d2"},
             ],
             "todoist_project": "TD"},
        ])
        out = Path("/tmp/_test_migrate_out_err.json")
        try:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                rc = migrate_main(["--source", str(src), "--output", str(out)])
            self.assertEqual(rc, 1)
            self.assertFalse(out.exists())
        finally:
            src.unlink(missing_ok=True)
            out.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
