# todoist-rescheduler

Places Todoist tasks into free time. **Independent** of
[`todoist-github-sync`](../todoist-github-sync/README.md) (GitHub Issue →
Todoist). You can use either product alone.

The planner is deterministic. An optional LLM pass can override
low-confidence duration estimates. Google Calendar is **read-only**
(secret iCal URL). Apply writes Todoist **due datetime**, and **duration**
only when the task has none and is not marked fixed. Labels are not written.
Date-only Todoist due values are not overwritten by the scheduler.

## Layout

```
todoist-rescheduler/
├── run.js                    # Orchestrator CLI (calls the engine)
├── engine/                   # Deterministic planner core
│   ├── bin/daily-scheduler.js
│   └── README.md             # Flags, architecture, planner details
├── SKILL.md                  # Agent / chat procedure for this product
├── POLICY.template.md        # Copy to a private POLICY.md
└── TASK_CONTEXT.example.md   # Optional per-task LLM hints scaffold
```

Root-level `*.py` scripts (dashboards, hub sync, log append) are leftover
operator helpers. They are **not** part of the placement engine.

## CLIs

| Entry | Role | Default when flags omitted |
|---|---|---|
| `run.js` | Orchestrator | **Applies** (pass `--dry-run` to plan only) |
| `engine/bin/daily-scheduler.js` `run` | Planner core | Dry-run (pass `--apply` to write) |

Also under `engine/`: `export-registry`, `apply-llm`, `plan`, `verify`,
`migrate-deadlines`.

```bash
# Safe first step
node todoist-rescheduler/run.js --dry-run --timezone UTC

# Apply (only after reviewing a dry-run)
node todoist-rescheduler/run.js --apply --timezone UTC

# Working-hours only (no calendar fetch)
node todoist-rescheduler/run.js --dry-run --no-calendar --timezone UTC

# Engine plan from fixtures (no network)
node todoist-rescheduler/engine/bin/daily-scheduler.js plan \
  --todoist-file todoist-rescheduler/engine/fixtures/todoist-tasks.json \
  --calendar-file todoist-rescheduler/engine/fixtures/calendar-events.json \
  --timezone UTC --json
```

## Environment

| Variable | Purpose |
|---|---|
| `TODOIST_API_TOKEN` | Todoist REST token (required for live Todoist) |
| `TASK_RESCHEDULER_POLICY` | Path to active private `POLICY.md` |
| `GOOGLE_CALENDAR_ICS_URL` | Secret iCal URL for busy/free (or `--calendar-ics-url`) |
| `RESCHEDULER_ARTIFACT_DIR` | Optional artifact / JSONL directory |

## Policy and task context

1. Copy [`POLICY.template.md`](POLICY.template.md) to a **private** path.
2. Point `$TASK_RESCHEDULER_POLICY` at that file (if unset, the engine looks
   for `todoist-rescheduler/POLICY.md` next to the package — that live file
   is not in git).
3. Optionally copy [`TASK_CONTEXT.example.md`](TASK_CONTEXT.example.md) to a
   private `TASK_CONTEXT.md` for LLM hints.

Do **not** commit active `POLICY.md` / `TASK_CONTEXT.md`. The deterministic
engine reads only YAML front-matter `labels:`; narrative sections are for
the LLM-driven mode.

Opt-out label (default): `no-auto-schedule`. Fixed duration label (default):
`fixed-duration`.

## Calendar (read-only)

Google Calendar → Settings → Integrate calendar → **Secret address in iCal
format** → set as `GOOGLE_CALENDAR_ICS_URL`. No OAuth app, no Hermes, no
`gog`. Use `--no-calendar` to skip fetch. Use `--calendar-file` for fixtures.

## Further reading

- Agent / chat procedure: [`SKILL.md`](SKILL.md)
- Planner flags, schema, architecture: [`engine/README.md`](engine/README.md)

## License

MIT — same as the parent `task-rescheduler` repo.
