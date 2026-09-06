---
# Machine-readable label rules — daily-scheduler's policy.js reads these.
# All values also live in defaults baked into daily-scheduler, so this front-matter
# is OPTIONAL. New users can install POLICY.md by copying this template to the
# configured private path and editing it.
# 2026-09-06: this file lives at $REPO/todoist-rescheduler/POLICY.example.md (templated) — copy to
#   ~/.hermes/configs/task-rescheduler.json → private_paths.policy.
labels:
  exclude_from_reschedule:
    - no-auto-schedule        # tasks with this label are NOT auto-rescheduled
  assignment_marker: task-rescheduler-assigned
  planner_version_prefix: task-rescheduler-planner-v
  fixed_duration: fixed-duration
---

# Reschedule Policy (template)

This file is the human-edited reschedule policy for the LLM-driven rescheduler.
Read by the LLM **on every run** before it makes placement decisions.

- **Authorititative location**: defined in `~/.hermes/configs/task-rescheduler.json`
  → `private_paths.policy`. This template file lives at
  `$REPO/todoist-rescheduler/POLICY.example.md` for new users; the active
  copy **must not be committed**.
- **Scope**: LLM-driven rescheduler mode only (independent of the deterministic
  daily-scheduler).
- **Format**: Markdown. The LLM structuralizes the prose into placement rules.

---

## Foundational principles

1. **Timezone**: All placements are written in **UTC**. EDT is referenced only in
   narrative ("EDT morning" = 12:00–14:00 UTC during DST). Put the user's
   *current* local TZ prose here if needed.
2. **`rescheduled` flag**: Tasks with `rescheduled: true` in `tasks-registry.json`
   are not moved again unless an explicit rational applies (deadline imminent,
   user override). Reason lives in the surrounding prose.
3. **Deadline adherence**: If a task has a `deadline_at`, do NOT place it after
   that time. If no slot exists in-range, decide whether to **overflow past
   deadline** (`allowOverflowPastDeadline: true` in `production.json` does this
   by default for the deterministic engine).
4. **Sub-tasks** (`parent_id != null`) are NOT scheduled — the parent carries the
   schedule.
5. **No-auto-schedule** label: NEVER reschedule. Front-matter entry wires this.

## Working-hours schedule (UTC, weekly)

| Day | Working hours (UTC) | Notes |
| --- | --- | --- |
| Mon–Fri (workdays) | 12:00–22:00 | EDT morning work is heaviest; UTC 12 = EDT 08 |
| Sat | 14:00–22:00 | Half-day |
| Sun | 16:00–22:00 | Recovery day |

Adjust to match the user's actual cadence.

## Priority bands

| Band | Means | Default slot |
| --- | --- | --- |
| **P1 (do ASAP)** | Deadlines ≤ 24 h or top-pinned | First open block today |
| **P2 (today)** | Round out today | Anywhere remaining today |
| **P3 (this week)** | General work-week tasks | Any workday within horizon |
| **P4 (whenever)** | Backlog / learning | Squeeze into gaps |

## Loader

The deterministic engine's `daily-scheduler/src/policy.js` reads only the
front-matter `labels:` block. The narrative sections above are pure
documentation for the LLM-driven mode.
