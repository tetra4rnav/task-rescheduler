# Daily Scheduler

Deterministic, idempotent task-rescheduler.

## Phase 1 task model

Planner version `1.1.0` separates task semantics in JSON:

- `deadline_at`: immutable work deadline from Todoist `deadline.date`
- `scheduled_start`: execution start stored as Todoist due datetime
- `duration_minutes`: explicit or deterministic estimate
- `assignment_source`: `manual` or `task-rescheduler`
- `planner_version`: version encoded by the `task-rescheduler-planner-v<version>` label

Scheduling is opt-out. Tasks are eligible by default; add `no-auto-schedule` to exclude a task. task-rescheduler assignments add the full-label-safe markers `task-rescheduler-assigned` and `task-rescheduler-planner-v1-1-0`. Unmarked Todoist due datetimes are treated as manual assignments and are never overwritten.

Date-only Todoist due values are never overwritten by the scheduler. They are placed in `manual_review` with `DATE_ONLY_DUE_REQUIRES_MIGRATION` until explicitly migrated to Todoist's deadline field.

Preview migration:

```bash
node ./src/main.js migrate-deadlines --dry-run --json > deadline-migration-plan.json
```

Apply requires both the exact saved plan and an explicit approval flag:

```bash
node ./src/main.js migrate-deadlines --apply \
  --plan-file ./deadline-migration-plan.json \
  --approve-deadline-migrations --json
```

The apply path fails closed if the live source due/deadline state differs from the approved plan.

## Phase 2 planning controls

Phase 2 remains deterministic and minimizes manual-review volume:

- Explicit Todoist duration receives a score bonus (`scoreWeights.explicitDurationBonus`).
- Default duration or confidence below `lowConfidenceManualReviewThreshold` enters manual review, but only up to `lowConfidenceManualReviewLimit` items per run. Remaining low-confidence tasks are autonomously deferred.
- Undated tasks are admitted by score up to `undatedWipLimit`; overflow is deferred, not manually reviewed.
- Deadlines beyond `deadlineHorizonDays` are deferred until they enter the horizon.
- Unscheduled tasks at or above `highScoreEscalationThreshold` carry `escalation: true` and `HIGH_SCORE_UNSCHEDULED`.
- `projectWeights` changes ranking; `projectDailyCapacityMinutes` limits minutes per project per day.
- `--timezone` is the single operational timezone for Calendar windows, deadlines, and date boundaries. `--todoist-timezone` is rejected.

`deferred` is a normal autonomous queue, distinct from `manual_review` and `unscheduled`.

This implementation moves task fetching, calendar fetching, target extraction, duration estimation, availability search, ranking, idempotent diffing, optional Calendar writes, optional Todoist due sync, and JSON reporting into modular Node.js code. LLM use is intentionally outside this package.

## Architecture

```text
bin/daily-scheduler.js      CLI entrypoint
src/config.js               CLI parsing and config merge
src/todoist.js              Todoist API client + pagination + retry
src/calendar.js             gog CLI adapter
src/normalize.js            Input normalization
src/duration.js             Deterministic duration estimation
src/priority.js             Deterministic score calculation
src/availability.js         Working-hours and free-slot search
src/planner.js              Plan generation + idempotent operation diff
src/apply.js                Safe create/update/apply flow
src/verify.js               Post-apply verification
src/schema.js               JSON schema + built-in validator
tests/                      Fixture-based unit tests
fixtures/                   Read-only local fixtures
schemas/plan.schema.json    Output schema
```

Pure planning logic is separated from external I/O. `plan` can run entirely from fixtures.

## Authentication

### Todoist

- Reads `TODOIST_API_TOKEN` from the environment.
- Does **not** read or print token values.
- Does **not** write `.env`, secrets, or auth state.

### Google Calendar

- Uses `gog` CLI.
- Expected account: `your-email-at-provider.example`
- Expected calendar: `primary` by default
- Existing gog OAuth/config is reused and never overwritten.

## Secret management

- Human logs go to `stderr`.
- Machine JSON goes to `stdout`.
- Authorization headers and token-like strings are redacted from logs.
- No credentials are stored under this directory.

## Commands

```bash
node ./src/main.js plan --todoist-file ./fixtures/todoist-tasks.json --calendar-file ./fixtures/calendar-events.json
node ./src/main.js verify --todoist-file ./fixtures/todoist-tasks.json --calendar-file ./fixtures/calendar-events.json
node ./src/main.js run --dry-run --date 2026-03-08 --timezone America/New_York
node ./src/main.js run --apply --date 2026-03-08 --timezone America/New_York
node ./src/main.js apply --date 2026-03-08 --timezone America/New_York
node ./src/main.js run --apply --todoist-only --date 2026-03-08 --timezone America/New_York
```

`run` defaults to dry-run.

## Core options

- `--date YYYY-MM-DD`
- `--timezone America/New_York`
- `--days 3`
- `--account your-email-at-provider.example`
- `--calendar primary`
- `--working-hours 09:00-18:00`
- `--max-daily-minutes 360`
- `--min-break-minutes 15`
- `--json`
- `--verbose`
- `--sync-todoist-due`
- `--todoist-only` (read Calendar for availability only; write scheduled start times to Todoist due datetime)
- `--config /path/to/config.json`
- `--todoist-file /path/to/tasks.json` (fixture/testing)
- `--calendar-file /path/to/events.json` (fixture/testing)
- `--plan-file /path/to/plan.json` (verify)
- `--now RFC3339` (deterministic testing)

## Dry-run

Default mode. Fetches inputs, computes a plan, validates it against `schemas/plan.schema.json`, and prints JSON only.

No external writes occur.

## Apply

`apply` / `run --apply` performs:

1. input fetch
2. deterministic plan build
3. schema validation
4. state reload
5. calendar create/update
6. calendar verification
7. optional Todoist due sync
8. Todoist verification
9. final JSON report

### Todoist-only mode

Enable with `--todoist-only`.

Behavior:

- Google Calendar is read only for availability
- `operations.calendar_create`, `calendar_update`, `calendar_noop`, and `calendar_stale` remain empty
- scheduled non-recurring tasks generate `todoist_due_update` operations automatically
- apply writes only Todoist `due_datetime`
- verify checks Todoist due values and ignores Calendar mutation checks
- recurring tasks still go to `manual_review`

Operation statuses are explicit:

- `planned`
- `applied`
- `verified`
- `failed`
- `skipped`
- `noop`

## Verify

- `verify --plan-file plan.json` checks live state against a saved plan.
- `verify` without `--plan-file` regenerates the current deterministic plan and succeeds only when no create/update/due-sync work remains.

## Todoist due sync

Disabled by default unless `--todoist-only` is used.

Enable with `--sync-todoist-due`, or implicitly via `--todoist-only`.

Behavior:

- only scheduled non-recurring tasks are eligible
- recurring tasks stay in manual review
- `due_datetime` is written as RFC3339 UTC per Todoist API v1
- prior due value is preserved in the JSON operation entry
- partial failures are reported; they are not hidden

## Recurring tasks

Default policy: `manual_review`.

Recurring tasks are **not** rewritten into normal dated tasks and are **not** auto-completed or deleted.

## Timezone handling

- Calendar planning timezone: `America/New_York`
- Todoist date-only interpretation timezone: `Asia/Tokyo`
- Date-only due dates are treated as end-of-day in Todoist timezone.
- RFC3339 outputs include explicit offsets, including DST transitions.

## Idempotency

Managed calendar events include (Calendar-writing modes only):

- summary: `[Todoist] <task title>`
- description marker: `TETRA_TODOIST_TASK_ID=<id>`
- private properties:
  - `managedBy=task-rescheduler`
  - `todoistTaskId=<id>`
  - `planDate=<date>`
  - `plannerVersion=<version>`

Idempotency key:

```text
sha256(task_id + start + end + planner_version)
```

Behavior:

- if no managed event exists: create
- if the managed event already matches: noop
- if a managed event exists but differs: update
- stale/duplicate managed events are reported, never auto-deleted
- unrelated manual events are never modified

## Rollback

No destructive rollback is attempted automatically.

Use the final JSON report to identify:

- created event IDs
- updated event IDs
- prior Todoist due values

Manual rollback procedure:

1. inspect the report JSON
2. revert affected calendar events manually or with `gog calendar update` (if Calendar-writing mode was used)
3. restore Todoist due values from `operations.todoist_due_update[].previous_due`

## Cron integration example

Do **not** replace existing cron until dry-run, smoke, apply, and idempotency checks pass.

Example command to evaluate first:

```bash
cd /path/to/your/workspace/scripts/daily-scheduler && \
node ./src/main.js run --dry-run --date "$(date +%F)" --timezone America/New_York
```

Todoist-only cron-friendly variant:

```bash
cd /path/to/your/workspace/scripts/daily-scheduler && \
node ./src/main.js run --apply --todoist-only --timezone America/New_York --days 3\n+```

Recommended rollout:

1. keep current cron unchanged
2. run fixture tests
3. run read-only dry-run against real Todoist/Calendar
4. run a single explicit apply
5. rerun the same apply and confirm create/update counts drop to zero
6. only then propose cron changes

## Troubleshooting

- `exit 2`: bad CLI/config input
- `exit 3`: auth failure (Todoist token missing/invalid, gog auth unavailable)
- `exit 4`: external API/CLI failure
- `exit 5`: plan generation or schema failure
- `exit 6`: apply had partial failures
- `exit 7`: verification mismatch

If rate limited, Todoist retries honor `Retry-After` with a capped backoff.

## Output JSON example

```json
{
  "schema_version": "1.0",
  "run_id": "...",
  "generated_at": "2026-03-08T13:10:00.000Z",
  "timezone": "America/New_York",
  "mode": "dry-run",
  "todoist_only": true,
  "inputs": {
    "todoist_task_count": 14,
    "calendar_event_count": 9,
    "window": {
      "start": "2026-03-08",
      "days": 3,
      "calendars": ["primary"]
    }
  },
  "scheduled": [],
  "unscheduled": [],
  "manual_review": [],
  "operations": {
    "calendar_create": [],
    "calendar_update": [],
    "calendar_noop": [],
    "calendar_stale": [],
    "todoist_due_update": [
      {
        "status": "planned",
        "task_id": "task-01",
        "previous_due": "2026-03-07",
        "desired_due": "2026-03-08T17:00:00Z",
        "scheduled_start": "2026-03-08T13:00:00-04:00",
        "desired_timezone": "America/New_York",
        "recurring": false
      }
    ]
  },
  "errors": [],
  "warnings": []
}
```
