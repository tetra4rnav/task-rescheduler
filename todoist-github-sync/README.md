# todoist-github-sync

One-way sync from GitHub Issues to Todoist tasks. Lives outside the main
5-stage `task-rescheduler` pipeline — it has its own config, its own cron
slot, and its own operational concerns.

## What it does

For every project in your config:

1. Lists all GitHub issues (open + closed) via `gh issue list`.
2. Optionally reads GitHub Projects dates (`gh project item-list`).
3. Reconciles each issue against an existing Todoist task (matched by the
   issue URL in the description and the `github-issue` label).
4. Creates new Todoist tasks for new issues, updates existing ones in place
   (preserves duration / priority), moves them between Todoist projects when
   the GitHub side disagrees, and closes them when the GitHub issue closes.
5. Mirrors the GitHub issue body and comments to Todoist task comments,
   idempotently — re-runs only post what's new.

GitHub is authoritative. Todoist-side edits to **duration**, **priority**,
and other fields not present on the GitHub side are never overwritten.

## Schema

```json
{
  "$schema_version": "1.0",
  "projects": [
    {
      "name": "RZDC Philippines VH",
      "github_owner": "tetra4rnav",
      "github_repos": ["RZDC_Philippines_VH"],
      "todoist_project": "RZDC Philippines",
      "github_project_number": 4,
      "issue_labels_include": [],
      "issue_labels_exclude": []
    }
  ]
}
```

- `github_owner` + `github_repos` — which repos feed this Todoist project.
  Multiple repos can map to the same Todoist project.
- `todoist_project` — exact name of the existing Todoist project.
- `github_project_number` (optional) — if set, `start date` → `due_date`,
  `target date` → `deadline_date` are pulled from the GitHub Projects board
  and applied to Todoist tasks unless the existing Todoist task carries the
  `date-locked` label.
- `issue_labels_include` / `issue_labels_exclude` (optional, reserved) —
  label-based filtering, not yet implemented.

See [`schema.example.json`](./schema.example.json) for a starter template.

## Usage

```bash
# Dry-run (no writes — recommended first step):
python3 todoist-github-sync/github_todoist_sync.py \
    --config /path/to/github-projects.json \
    --dry-run

# Apply (writes to Todoist):
python3 todoist-github-sync/github_todoist_sync.py \
    --config /path/to/github-projects.json
```

Both modes expect `TODOIST_API_TOKEN` in the environment.

## Migrating from openclaw-mirror

If you have an existing `openclaw-mirror/scripts/project_registry.json`,
use `migrate_openclaw_registry.py` to convert it to the new schema:

```bash
# Preview the conversion (writes JSON to stdout, no file written):
python3 todoist-github-sync/migrate_openclaw_registry.py \
    --source /path/to/old/project_registry.json \
    --dry-run

# Write the new config:
python3 todoist-github-sync/migrate_openclaw_registry.py \
    --source /path/to/old/project_registry.json \
    --output /opt/data/configs/github-projects.json
```

The migration is one-shot; the new config is the source of truth from then
on. The script skips entries with empty `github` lists and rejects entries
whose repos span multiple distinct GitHub owners (you'll need to split
those manually before migrating).

## Configuration injection

Config path resolves in this order:

1. `--config <path>` flag
2. `$GITHUB_PROJECTS_CONFIG` environment variable

Both must point to the same schema; if neither is set the script exits
with a clear error.

## Requirements

- Python ≥ 3.10 (uses `dataclass(slots=True)`-adjacent idioms).
- `gh` CLI on `$PATH` — authenticated as a user with `repo` and
  `read:project` scopes. If you also want start/target dates to sync, the
  token needs `read:org` (Projects v2 user projects).
- `TODOIST_API_TOKEN` in the environment.

## What you'll see on stdout

The dry-run prints a JSON object:

```json
{
  "ok": true,
  "dry_run": true,
  "config": "/path/to/config.json",
  "projects_in_config": 8,
  "issues": 158,
  "managed_todoist_tasks": 112,
  "summary": {
    "skip-closed-no-task": 58,
    "updated": 100
  },
  "log": [
    {"owner": "...", "repo": "...", "number": 1, "action": "updated", "comments_added": 0},
    ...
  ],
  "would_call": [
    {"op": "update", "task_id": "...", "body": {...}},
    ...
  ]
}
```

The `would_call` field is only present in `--dry-run` mode and lists
every Todoist write the apply step WOULD make. Review it before running
`--apply`.

## Warnings

The script prints human-readable `WARN:` lines to stderr when:

- `gh project item-list` returns a 403 (missing token scope — common
  cause is a fine-grained PAT, which doesn't include `read:project`)
- the project board has no items linked to issues
- the gh CLI is missing from `$PATH`
- the project number in the config doesn't match a real board

In `--dry-run` mode these warnings are surfaced but the plan still runs
(so you can inspect what *would* have been written). In `--apply` mode
any warning causes the script to exit `2` before touching Todoist — we
refuse to write tasks without the dates you intended.

## Tests

```bash
cd todoist-github-sync
python3 -m unittest tests.test_migrate
python3 -m unittest tests.test_sync
```

Both are stdlib-only (`unittest`); no external dependencies. The
`todoist-github-sync` directory name contains a hyphen so it can't be a
normal Python package; the tests use `tests/_loader.py` to import the
modules by file path.

## Operational notes

- This is **one-way** sync: Todoist → GitHub is intentionally unsupported.
  Edits in Todoist that should flow back to GitHub need a separate workflow.
- Duration and priority on existing Todoist tasks are **preserved**. If you
  want GitHub to drive them too, add the fields to the sync body — the
  script already does partial updates, just append the new fields.
- The `date-locked` label on a Todoist task prevents the script from
  overwriting its `due_date` and `deadline_date`. Apply it manually when
  you've manually rescheduled something and want GitHub Projects to leave
  it alone.

## License

MIT — same as the parent `task-rescheduler` repo.
