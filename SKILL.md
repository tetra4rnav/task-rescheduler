---
name: task-rescheduler
description: Use when policy-driven placement of tasks into time blocks is needed. Reads an operator-authored POLICY.md (foundational principles + custom rule sections) and writes due (and duration when empty and not fixed) back to the task store. Cron CLI apply defaults differ by entrypoint; chat path applies on explicit operator approval. JSONL audit when configured.
version: 0.5.0
license: MIT
platforms: [linux, macos]
tags: [scheduling, planning, calendar, policy]
---

# Task Rescheduler

Policy-driven placement of tasks into time blocks. The skill
orchestrates a placement pipeline whose rules, working hours, and
priority bands live in an operator-authored **`POLICY.md`** that the
placement engine reads every run.

**Pipeline (4 stages):**

1. Fetch tasks
2. Fetch calendar availability
3. Decide placements (deterministic engine + optional LLM pass)
4. Report / apply

The deterministic engine reads only the YAML front-matter (`labels:`).
Custom `## <rule-name>` sections are prose for the LLM-driven mode;
there is no parser for Trigger / Preserve / Reflow. Adding a section
does not change deterministic behavior.

## When to use

- **Cron-driven**: the skill MUST invoke `--dry-run` unless the
  operator opts in to apply. Note the CLIs: `todoist-rescheduler/rescheduler/run.js`
  applies if neither `--dry-run` nor `--apply` is passed;
  `daily-scheduler` `run` defaults to dry-run.
- **Chat-driven**: trigger a fresh placement, review the breakdown
  in chat, and apply on explicit operator confirmation.
- **Revert / undo**: restore the pre-apply task-store state from the
  snapshot file.

The set of candidate tasks is decided by the policy (YAML exclusion
labels plus LLM narrative in `Foundational principles` and `Custom
rule labels`). Calendar availability is read; placements are written
only on apply.

Opt-out of reschedule: `labels.exclude_from_reschedule` (default
`no-auto-schedule`). Duration is operator-fixed when the task carries
`labels.fixed_duration` (default `fixed-duration`).

## Inputs

| Input | Source |
| --- | --- |
| Tasks | operator's task store |
| Calendar availability | operator's calendar |
| Active policy | `POLICY.md` (resolved from env-var / harness config) |
| Persisted registry | `tasks-registry.json` (resolved from env-var / harness config) |

## Outputs

| Output | Sink |
| --- | --- |
| Placements | operator's task store (apply only): `due_datetime`; `duration` only when empty and not fixed |
| Pre-apply snapshot | operator-configured local path |
| Audit log | operator-configured JSONL sink (one JSONL line per run) |

## Environment variables

Abstract names (any harness):

| Concern | Variable pattern |
| --- | --- |
| Authentication against operator's task store | `${TASK_STORE_AUTH}` |
| Authentication against operator's calendar | `${CALENDAR_AUTH}` |
| Path to active policy | `${POLICY_PATH}` |
| Path to tasks registry | `${REGISTRY_PATH}` |
| Placement timezone | `${PLACEMENT_TIMEZONE}` |
| Audit log sink | `${AUDIT_LOG_PATH}` |
| Engine install root | `${ENGINE_HOME}` |

Reference implementation (`todoist-rescheduler/`):

| Concern | Env var |
| --- | --- |
| Todoist token | `TODOIST_API_TOKEN` |
| Active POLICY.md path | `TASK_RESCHEDULER_POLICY` |
| Artifact / JSONL dir | `RESCHEDULER_ARTIFACT_DIR` |

## Procedure — chat-driven (apply on demand)

1. **Trigger detection** (LLM-side): explicit or inferred operator
   intent to reschedule / re-plan / refresh.
2. Refresh registry (task store → `tasks-registry.json`).
3. Read policy (YAML labels + narrative sections).
4. Generate placement proposal. Deterministic engine produces a
   summary; the LLM-driven pass produces the full breakdown
   (scheduled / unscheduled / deferred), with score reasons and
   deadline context.
5. **Always show the breakdown** in the chat reply. Operator
   approves with explicit `apply` / `yes` / `go`.
6. **Apply**: write `due_datetime` (and duration when allowed),
   update the registry (`rescheduled` flag and timestamp), snapshot
   pre-state for revert. Do not write labels.
7. Reply with the apply summary to the **trigger thread** only —
   do not cross-post.
8. Append an audit-log entry via the configured helper
   (atomic single-line JSONL append).

LLM placements JSON:

```json
{ "task_id": "...", "due": "2026-09-06T10:00:00Z", "duration_minutes": 45 }
```

`due` is required. `duration_minutes` is optional and is ignored when
the task already has a Todoist duration or carries the fixed-duration
label.

## Procedure — cron-driven (proposal unless opted in)

> The skill must pass `--dry-run` unless the operator has opted in.
> `rescheduler/run.js` currently **applies** when neither flag is set.

1. Refresh registry.
2. Read policy + custom rules.
3. Generate proposal (`--dry-run`).
4. Post the report to the configured delivery target.
5. Audit-log one JSONL entry.

## Custom rule labels

To add an LLM-side placement rule:

1. Open the active `POLICY.md`.
2. Add a `## <rule-name>` section using the
   `POLICY.template.md#custom-rule-labels` schema
   (`Trigger` / `Preserve` / `Reflow` / `Conflicts` / `Anti-patterns`).
3. Save. The next LLM-driven run reads the prose. The deterministic
   engine still only uses YAML `labels:`.

The skill never lists individual label names. The authoritative set
lives in the active `POLICY.md`.

## Reference implementations

This repo ships two tools. They do **not** share a configuration
contract or audit-log format.

| Path | Role |
| --- | --- |
| `todoist-rescheduler/` | Placement engine. Writes `due_datetime`, and duration when empty and not fixed. Does not write labels. POLICY + registry + JSONL live here. |
| `todoist-github-sync/` | One-way GitHub Issue → Todoist sync. Independent CLI and mapping JSON. |

Concrete CLI flags and test fixtures live in each reference's README.

## Pitfalls (engine-level, non-binding)

- **Timezone hygiene.** All placements in `${PLACEMENT_TIMEZONE}`.
  Mismatched timezone in the visibility horizon produces wrong
  skip counts.
- **Two apply paths.** Do not mix the deterministic engine's apply
  path with the LLM-driven apply path. They write different registry
  fields and silently overwrite each other.
- **Private placement files.** `POLICY.md` and `tasks-registry.json`
  contain operator-specific data. They MUST NOT be committed in this
  upstream repo. See the root README for the canonical store
  convention.
- **Skill never owns the policy file.** `POLICY.md` is owned by the
  operator's harness. The skill only reads it. If the policy is
  missing or malformed, the placement engine falls back to defaults.
