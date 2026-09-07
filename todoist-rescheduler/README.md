# todoist-rescheduler

Places Todoist tasks into free time. Independent of `todoist-github-sync`
(GitHub Issue → Todoist). You can use either product alone.

## Layout

```
todoist-rescheduler/
├── run.js                 # Orchestrator CLI (calls the engine)
├── engine/                # Deterministic planner core
│   ├── bin/daily-scheduler.js
│   └── README.md          # Flags, architecture, planner details
├── SKILL.md               # Agent / chat procedure for this product
├── POLICY.template.md     # Copy to a private POLICY.md
└── TASK_CONTEXT.example.md
```

## CLIs

| Entry | Role | Default when flags omitted |
|---|---|---|
| `run.js` | Orchestrator | **Applies** (pass `--dry-run` to plan only) |
| `engine/bin/daily-scheduler.js` `run` | Planner core | Dry-run (pass `--apply` to write) |

Also under `engine/`: `export-registry`, `apply-llm`, `plan`, `verify`, `migrate-deadlines`.

```bash
# Safe first step
node todoist-rescheduler/run.js --dry-run --timezone UTC

# Engine plan from fixtures (no network)
node todoist-rescheduler/engine/bin/daily-scheduler.js plan \
  --todoist-file todoist-rescheduler/engine/fixtures/todoist-tasks.json \
  --calendar-file todoist-rescheduler/engine/fixtures/calendar-events.json \
  --timezone UTC --json
```

Needs `TODOIST_API_TOKEN` for live Todoist. Active policy path:
`$TASK_RESCHEDULER_POLICY` (copy from `POLICY.template.md`; do not commit the live file).

Live calendar busy/free: set `GOOGLE_CALENDAR_ICS_URL` to the calendar’s
secret iCal address (Google Calendar → Settings → Integrate calendar), or
pass `--calendar-ics-url`. Use `--no-calendar` to plan against working hours
only. No Hermes / `gog` / `google_api.py`.

Details: [`engine/README.md`](engine/README.md). Agent procedure: [`SKILL.md`](SKILL.md).
