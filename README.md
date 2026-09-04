# task-rescheduler

Deterministic, idempotent Todoist → Google Calendar task rescheduler.

Splits into two layers:

- `rescheduler/` — orchestrator CLI (single entry point, run.js; ~165 lines).
- `daily-scheduler/` — planner core (Node.js ESM modules; ~2,600 lines).

Python helpers in the repository root support memory writeback and dashboard
rendering:

- `daily_effort_append.py` — appends today's project effort table to a daily log.
- `yesterday_reflection.py` — Toggl vs Todoist comparison for prior-day review.
- `todoist_today.py` — emits today's pending Todoist tasks.
- `today_dashboard.py` — renders a one-page HTML dashboard for today.
- `hub_sync.py` and `project_hub_sync_gate.py` — project hub mirror helpers.

## GitHub Issue → Todoist sync

A separate, standalone subpackage that pulls GitHub Issues (and optional
GitHub Projects dates) into Todoist tasks. GitHub is authoritative;
Todoist-side edits to duration and priority are preserved.

Lives at `todoist-github-sync/`. Configuration is read from
`--config <path>` or `$GITHUB_PROJECTS_CONFIG`. Includes a one-shot
migrator for users coming from the old
`openclaw-mirror/scripts/project_registry.json` format.

See [`todoist-github-sync/README.md`](./todoist-github-sync/README.md)
for schema, usage, and operational notes.

## Requirements

- Node.js ≥ 24.
- A valid `TODOIST_API_TOKEN` in the environment.
- Read-only Google Calendar access via `gog --account your-email@example.com calendar list`
  (Calendar is consumed only, never written to).

## Quick start

```bash
# Dry-run plan (read-only, JSON to stdout)
node rescheduler/run.js --dry-run --timezone UTC

# Apply plan (writes scheduled due datetimes back to Todoist)
node rescheduler/run.js --apply --timezone UTC

# Calendar-free mode (Todoist due only)
node rescheduler/run.js --apply --no-calendar --timezone UTC
```

## Architecture

```
+-------------------+     +-----------------------+
| Todoist /tasks    | --> | rescheduler/run.js    |
+-------------------+     +-----------+-----------+
                                      |
                       +--------------+--------------+
                       |          daily-scheduler/bin |
                       +--------------+--------------+
                                      v
                       +--------------------------+
                       | planner + availability   |
                       +-----------+--------------+
                                   v
                          source of truth JSON
                          (no LLM re-evaluation)
```

`assignment_source` in plan output is `manual` or `task-rescheduler`.
Tasks scheduled by this scheduler carry the Todoist labels
`task-rescheduler-assigned` and `task-rescheduler-planner-v<version>`.
Manual due datetimes that lack those labels are never overwritten.

See `daily-scheduler/README.md` for planner details, exit codes, and the
full option reference.

## License

MIT — see `LICENSE`.
