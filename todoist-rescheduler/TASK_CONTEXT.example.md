---
file: TASK_CONTEXT.md
purpose: Human-curated per-task reschedule context for the LLM-driven rescheduler.
consumer: LLM rescheduler stage — read AFTER POLICY.md, BEFORE placements.
sibling: POLICY.md
created: 2026-09-05
template_2026-09-06: example copy lives at $REPO/todoist-rescheduler/TASK_CONTEXT.example.md; active copy lives at private_paths.task_context (NOT in repo).
---

# Task Context (template — per-task reschedule hints)

Manually pinned hints the LLM rescheduler sees in addition to `POLICY.md`. Read
order is **POLICY.md → TASK_CONTEXT.md** on every run.

- **Authoritative location**: `~/.hermes/configs/task-rescheduler.json` →
  `private_paths.task_context`. Active copy **must not be committed**.
- **Edit times**: anytime a priority / duration / placement hint changes via the
  chat surfaces; patch on the spot.
- **Reload**: not automatic — the LLM re-reads the file on each run, so a
  manual update takes effect at the next run boundary.

## Fields (one block per task)

| Field | Meaning | Example |
| --- | --- | --- |
| `task_id` | Todoist task ID (string of digits) | `9012345678901` |
| `name` | snapshot of the task name | `<your task name>` |
| `priority` | `P1=ASAP` / `P2=today` / `P3=this week` / `P4=whenever` | `P2` |
| `duration_min` | minutes | `90` |
| `preferred_window` | time window the task fits best | `EDT morning` / `EDT deep-afternoon` |
| `deadline_hint` | deadline clarification (optional) | `soft: end of week`, `hard: 2099-12-31` |
| `anchor_before` / `anchor_after` | mandatory before/after tasks (id or name) | `after: <related task>` |

## Pinned-task block — example

```yaml
- task_id: "0000000000000"      # ← DO NOT use this; it is a placeholder
  name: <your task name here>
  priority: P3
  duration_min: 60
  preferred_window: <your preferred window>
  deadline_hint: soft: <your soft hint>
  anchor_before: null
  anchor_after: null
```

Replace the placeholder with your real entry; delete the example lines.

## Sanity rules

- Don't store more than necessary — the registry already records the
  task-ID → due / deadline / priority. Only store what the LLM cannot infer.
- A task with `no-auto-schedule` SHOULD NOT appear here; the label already
  excludes it.
- If a hint becomes obsolete, remove the block (don't just disable).
