# task-rescheduler

Deterministic, idempotent Todoist → Google Calendar task rescheduler.

Repository layout (two top-level folders):

```
task-rescheduler/
├── todoist-rescheduler/      # Todoist rescheduling pipeline (LLM + deterministic)
│   ├── rescheduler/          #   orchestrator CLI (run.js, single entry point)
│   ├── daily-scheduler/      #   planner core (Node.js ESM modules)
│   ├── POLICY.md             #   LLM reschedule policy (human-edited markdown)
│   ├── log_append.py         #   Stage-4 audit logger
│   ├── daily_effort_append.py
│   ├── yesterday_reflection.py
│   ├── todoist_today.py
│   ├── today_dashboard.py
│   ├── hub_sync.py
│   └── project_hub_sync_gate.py
└── todoist-github-sync/      # GitHub Issue → Todoist one-way sync
    ├── github_todoist_sync.py
    ├── migrate_openclaw_registry.py
    ├── schema.example.json
    └── README.md
```

## Repo root (single source of truth)

The repo root is resolved from `~/.hermes/configs/task-rescheduler.json`
(`repo_root` key) — never hard-coded. External wrappers (cron scripts) and the
Hermes skill read it from there. If the repo moves, update that one file.

```bash
# Resolve repo root
export TASK_RESCHEDULER_DIR=$(python3 -c \
  'import json,os;print(json.load(open(os.path.expanduser("~/.hermes/configs/task-rescheduler.json")))["repo_root"])')
```

Env override: `TASK_RESCHEDULER_DIR` wins if it points to an existing dir.

## todoist-rescheduler

The Todoist rescheduling pipeline. Two layers:

- `rescheduler/` — orchestrator CLI (single entry point, run.js).
- `daily-scheduler/` — planner core (Node.js ESM modules).

The planner is deterministic; an optional LLM pass (via `--model` or
`llmDuration.enabled`) overrides only the `default`-confidence duration
estimates (see `daily-scheduler/README.md`).

Python helpers support memory writeback and dashboard rendering:
`log_append.py` (audit), `daily_effort_append.py`, `yesterday_reflection.py`,
`todoist_today.py`, `today_dashboard.py`, `hub_sync.py`,
`project_hub_sync_gate.py`.

### Rescheduler usage (todoist-rescheduler)

```bash
# Dry-run plan (read-only, JSON to stdout)
node todoist-rescheduler/rescheduler/run.js --dry-run --timezone UTC

# Apply plan (writes scheduled due datetimes back to Todoist)
node todoist-rescheduler/rescheduler/run.js --apply --timezone UTC

# Calendar-free mode (Todoist due only)
node todoist-rescheduler/rescheduler/run.js --apply --no-calendar --timezone UTC
```

See `todoist-rescheduler/daily-scheduler/README.md` for planner details, exit
codes, and full option reference.

## todoist-github-sync

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
- Read-only Google Calendar access via the google-workspace skill's
  `google_api.py` (Calendar is consumed only, never written to).

## License

MIT — see `LICENSE`.