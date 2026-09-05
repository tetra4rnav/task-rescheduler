# Daily Scheduler

Deterministic, idempotent task-rescheduler.

> **2つの方式があります** (2026-09-05 時点):
> 1. **決定論的 daily-scheduler**（本READMEの本体）— Todoist + Calendar を読み、スコアで決定的に配置。
> 2. **LLM駆動再配置 (新方式, 試行)** — 人間が書いた政策 + タスクレジストリJSON から LLM が配置を決め、Todoist due を直接書く。詳細は下記「## LLM駆動再配置 (新方式)」。

---

## LLM駆動再配置 (新方式)

決定論的 daily-scheduler とは独立した、LLM(agent)主導の再配置方式です。
**試行段階**: 既存方式とは並行運用し、dry-run 比較のうえ安定後に cron を切替えます。

### コンセプト

- **タスクレジストリJSON**（単一永続・毎回更新・フラグ保持）:
  `$HOME/cron/output/tasks-registry.json`
  - 再配置対象の全タスクの**識別情報のみ**を格納: `id`, `project`, `is_github_issue`,
    `owner`, `repo`, `issue_number`, `due`, `priority`, `deadline_at`, `labels`
  - タスクの詳細（説明文・中身）は格納しない
  - `rescheduled: true` フラグ + `last_rescheduled_at` を、一度配置したタスクに付与。
    ファイルが無い場合は新規作成し、以後毎回上書き更新（フラグは保持）
- **政策markdown**（人間が作成・編集・git管理）: `POLICY.md`
  - 曜日別稼働時間 / 朝の短時間高優先タスク配置 / タイムゾーン(UTC) など
    「再配置の方針」を記載
  - LLM は毎回このファイルを読んでから配置を判断する
- **書き戻し**: LLM が配置先を決め、Todoist due datetime を直接更新（新方式内で実施）

### フロー

1. `export-registry` でレジストリを更新（Todoist 全タスク取得 → JSON 書き込み）
2. `POLICY.md` を読む
3. LLM が レジストリ + 政策 から配置を判断 → placements JSON を作る
   `[{ task_id, due: "2026-09-06T10:00:00Z" }, ...]`
4. プレビュー提示 → ユーザー承認待ち
5. `apply-llm` で Todoist due 更新 + レジストリに `rescheduled` フラグ付与
6. audit log 記録

### コマンド

```bash
# レジストリ更新（Todoist 全タスク取得 → JSON 更新, フラグ保持, 標準出力にも出力）
node src/main.js export-registry --timezone UTC --json

# LLM の配置決定を適用（Todoist due 更新 + レジストリへ rescheduled フラグ）
node src/main.js apply-llm --timezone UTC --placements /path/to/placements.json
```

オプション: `--registry-path <path>`（既定 `$HOME/cron/output/tasks-registry.json`）、
 `--placements <path>`（apply-llm 必須）。

### レジストリJSON スキーマ

```json
{
  "schema_version": "1",
  "updated_at": "2026-09-05T00:00:00.000Z",
  "tasks": [
    {
      "id": "6hMjv6FmPmhh6chQ",
      "project": "RZDC Philippines",
      "content": "[RZDC_Philippines_VH #87](...) 量 visualization",
      "is_github_issue": true,
      "owner": "tetra4rnav",
      "repo": "RZDC_Philippines_VH",
      "issue_number": 87,
      "due": "2026-09-05",
      "priority": 1,
      "deadline_at": "2026-09-08",
      "labels": ["github-issue"],
      "rescheduled": false,
      "last_rescheduled_at": null
    }
  ]
}
```

### 政策ファイル (POLICY.md)

人間が編集する「再配置方針」markdown。LLM は毎回読んで従う。
初期雛形が `POLICY.md` にある。内容例:
- 曜日別の稼働時間 (UTC)
- 朝は短時間・高優先が先、昼以降は長時間の深い作業
- 締切(deadline)厳守、due は着手日
- `rescheduled` 済みタスクは基本動かさない

---

## 既存の決定論的 daily-scheduler

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
src/calendar.js             Google Calendar read-only adapter (google_api.py)
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

### Google Calendar (read-only)

- Uses the google-workspace skill's `scripts/google_api.py` CLI (replaced `gog` on 2026-09-05).
- Google Calendar is **read-only** for availability. No calendar create/update/delete is performed.
- Expected calendar: `primary` by default.

## Secret management

- Human logs go to `stderr`.
- Machine JSON goes to `stdout`.
- Authorization headers and token-like strings are redacted from logs.
- No credentials are stored under this directory.

## Commands

```bash
node ./src/main.js plan --todoist-file ./fixtures/todoist-tasks.json --calendar-file ./fixtures/calendar-events.json
node ./src/main.js verify --todoist-file ./fixtures/todoist-tasks.json --calendar-file ./fixtures/calendar-events.json
node ./src/main.js run --dry-run --date 2026-03-08 --timezone UTC
node ./src/main.js run --apply --date 2026-03-08 --timezone UTC
node ./src/main.js apply --date 2026-03-08 --timezone UTC
node ./src/main.js run --apply --todoist-only --date 2026-03-08 --timezone UTC
```

`run` defaults to dry-run.

## Core options

- `--date YYYY-MM-DD`
- `--timezone UTC`
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

1. input fetch (Todoist + Google Calendar availability)
2. deterministic plan build
3. schema validation
4. state reload
5. optional Todoist due sync (the only write path)
6. Todoist verification
7. final JSON report

### Calendar is read-only (all modes)

Since 2026-09-05 Google Calendar is used **only** for availability — the pipeline
never creates/updates/deletes calendar events. `--todoist-only` keeps its meaning
(write Todoist due, don't plan calendar ops), but even without it no calendar
write occurs.

Behavior:

- Google Calendar is always read-only for availability
- `operations.calendar_create`, `calendar_update`, `calendar_noop`, and `calendar_stale` remain empty
- scheduled non-recurring tasks generate `todoist_due_update` operations automatically when `--todoist-only` or `--sync-todoist-due` is set
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

- Calendar planning timezone: `UTC` (default; see constants.js for the EDT/EST map).
- Todoist date-only interpretation timezone: `UTC` (was Asia/Tokyo; changed to match the 2026-09-04 UTC-unification directive).
- Date-only due dates are treated as end-of-day in Todoist timezone.
- RFC3339 outputs include explicit `Z` suffix when in UTC.

## Idempotency

Calendar WRITE was removed (2026-09-05) — the pipeline never creates/updates
calendar events, so there are no managed-event idempotency concerns on the
Calendar side.

Todoist side idempotency: an operation is `noop` when the scheduled start equals
the current Todoist `due_datetime` and labels already match. Re-running an apply
against the same state yields no write.

Idempotency key:

```text
sha256(task_id + start + end + planner_version)
```

## Rollback

No destructive rollback is attempted automatically.

Use the final JSON report to identify:

- `operations.todoist_due_update[].previous_due` (prior Todoist due values)
- `operations.todoist_due_update[].scheduled_start`

Manual rollback procedure:

1. inspect the report JSON
2. restore Todoist due values from `operations.todoist_due_update[].previous_due`

## Cron integration example

Do **not** replace existing cron until dry-run, smoke, apply, and idempotency checks pass.

Example command to evaluate first:

```bash
cd /path/to/your/workspace/scripts/daily-scheduler && \
node ./src/main.js run --dry-run --date "$(date +%F)" --timezone UTC
```

Todoist-only cron-friendly variant:

```bash
cd /path/to/your/workspace/scripts/daily-scheduler && \
node ./src/main.js run --apply --todoist-only --timezone UTC --days 3\n+```

Recommended rollout:

1. keep current cron unchanged
2. run fixture tests
3. run read-only dry-run against real Todoist/Calendar
4. run a single explicit apply
5. rerun the same apply and confirm create/update counts drop to zero
6. only then propose cron changes

## Troubleshooting

- `exit 2`: bad CLI/config input
- `exit 3`: auth failure (Todoist token missing/invalid, google_api calendar auth unavailable)
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
  "timezone": "UTC",
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
        "desired_timezone": "UTC",
        "recurring": false
      }
    ]
  },
  "errors": [],
  "warnings": []
}
```
