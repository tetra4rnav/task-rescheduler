---
name: task-rescheduler
description: Use when policy-driven placement of tasks into time blocks is needed. Reads an operator-authored POLICY.md (foundational principles + custom rule sections) and writes placements back to the task store. Cron path is proposal-only by default; chat path applies on explicit operator approval. JSONL audit when configured.
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

**No code change is required to extend the rule set.** Add a new
`## <rule-name>` section to `POLICY.md` (see `POLICY.template.md`
for the schema and worked examples). The LLM-driven mode reads
prose; the deterministic engine reads only the YAML front-matter.

## When to use

- **Cron-driven**: schedule a daily briefing that **proposes**
  placements. Proposal-only is the default; applying requires either
  operator opt-in or an explicit confirmation.
- **Chat-driven**: trigger a fresh placement, review the breakdown
  in chat, and apply on explicit operator confirmation.
- **Revert / undo**: restore the pre-apply task-store state from the
  snapshot file.

The set of candidate tasks is decided by the policy (rules in
`Foundational principles` + `Custom rule labels`). Calendar
availability is read; placements are written only on apply.

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
| Placements | operator's task store (apply only) |
| Pre-apply snapshot | operator-configured local path |
| Audit log | operator-configured JSONL sink (one JSONL line per run) |

## Environment variables (abstract)

| Concern | Variable pattern |
| --- | --- |
| Authentication against operator's task store | `${TASK_STORE_AUTH}` |
| Authentication against operator's calendar | `${CALENDAR_AUTH}` |
| Path to active policy | `${POLICY_PATH}` |
| Path to tasks registry | `${REGISTRY_PATH}` |
| Placement timezone | `${PLACEMENT_TIMEZONE}` |
| Audit log sink | `${AUDIT_LOG_PATH}` |
| Engine install root | `${ENGINE_HOME}` |

Concrete env-var names and supported task stores are documented per
reference implementation (see `## Reference implementations` below).

## Procedure — chat-driven (apply on demand)

1. **Trigger detection** (LLM-side): explicit or inferred operator
   intent to reschedule / re-plan / refresh.
2. Refresh registry (task store → `tasks-registry.json`).
3. Read policy (foundational + custom rule sections).
4. Generate placement proposal. Deterministic engine produces a
   summary; the LLM-driven pass produces the full breakdown
   (scheduled / unscheduled / deferred), with score reasons and
   deadline context.
5. **Always show the breakdown** in the chat reply. Operator
   approves with explicit `apply` / `yes` / `go`.
6. **Apply**: write placements, update the registry (`rescheduled`
   flag and timestamp), snapshot pre-state for revert.
7. Reply with the apply summary to the **trigger thread** only —
   do not cross-post.
8. Append an audit-log entry via the configured helper
   (atomic single-line JSONL append).

## Procedure — cron-driven (proposal only by default)

> By default the cron path produces a proposal and posts the report
> to the configured delivery target. It does NOT apply. Promotion
> to apply requires explicit operator approval or an operator opt-in
> configuration flag.

1. Refresh registry.
2. Read policy + custom rules.
3. Generate proposal.
4. Post the report to the configured delivery target.
5. Audit-log one JSONL entry.

## Custom rule labels

To add a placement rule:

1. Open the active `POLICY.md`.
2. Add a `## <rule-name>` section using the
   `POLICY.template.md#custom-rule-labels` schema
   (`Trigger` / `Preserve` / `Reflow` / `Conflicts` / `Anti-patterns`).
3. Save. The policy propagates on the next run.

The skill never lists individual label names. The authoritative set
lives in the active `POLICY.md`.

## Reference implementations

This repo ships two reference implementations. They share the
configuration contract and audit-log format but each targets a
different task store:

| Path | Backs onto | Notes |
| --- | --- | --- |
| `todoist-rescheduler/` | an HTTP task API + a calendar API (read-only) | The only external write is to the task store's `due` field. |
| `todoist-github-sync/` | an HTTP task API + an issues API | One-way sync, issues → task store. |

Concrete env-var names, CLI flags, and test fixtures live in each
reference's README.

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
