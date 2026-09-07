---
# Machine-readable label rules — the placement engine reads these.
# All values also live as defaults in the placement engine, so this
# front-matter is OPTIONAL. New users install POLICY.md by copying
# this template to the path configured in their agent harness
# (environment variable or config file) and editing the copy.
labels:
  exclude_from_reschedule:
    - no-auto-schedule        # suggested convention; tasks with this label are NEVER rescheduled
  assignment_marker: agent-assigned
  planner_version_prefix: agent-planner-v
  fixed_duration: fixed-duration
---

# Reschedule Policy (template)

Human-edited policy consumed by the placement engine on every run.

- **Authoritative location**: defined in your agent harness (an
  environment variable or a config file path). This template file
  lives in the upstream repo (`POLICY.template.md`) as the canonical
  scaffold. The **active** POLICY.md MUST be a private local copy and
  MUST NOT be committed.
- **Scope**: the LLM-driven placement mode (narrative rules). The
  deterministic engine reads only the YAML front-matter.
- **Format**: Markdown. Front-matter for machine rules, prose for
  narrative rules.

---

## Foundational principles

1. **Placement timezone**: all placements are written in the operator's
   configured placement timezone. The local narrative ("EDT morning"
   → UTC 12:00–14:00 during DST) lives in prose.
2. **`rescheduled` flag**: tasks whose registry entry carries
   `rescheduled: true` are not moved again unless an explicit reason
   applies (imminent deadline, operator override). The reason lives in
   the surrounding prose.
3. **Deadline adherence**: a task with `deadline_at` MUST NOT be
   placed after that time. If no slot exists in-range, overflow past
   the deadline is gated by an engine-level configuration flag.
4. **Sub-tasks** (`parent_id != null`) are NOT independently scheduled.
   The parent carries the schedule.
5. **Exclusion labels**: tasks carrying any label in
   `labels.exclude_from_reschedule` (default: `no-auto-schedule`) are
   NEVER rescheduled. The label name is conventional and editable in
   the front-matter.

## Working-hours schedule (placement timezone, weekly)

| Day | Working hours (TZ) | Notes |
| --- | --- | --- |
| Weekdays | _fill in_ | _notes_ |
| Saturday | _fill in_ | _notes_ |
| Sunday | _fill in_ | _notes_ |

Replace the placeholders to match the operator's actual cadence.

## Priority bands

| Band | Means | Default slot |
| --- | --- | --- |
| **P1 (do ASAP)** | Deadlines ≤ N h or top-pinned | First open block now |
| **P2 (today)** | Round out today | Anywhere remaining today |
| **P3 (this week)** | General work-week | Any active workday inside the horizon |
| **P4 (whenever)** | Backlog / learning | Squeeze into gaps |

The numeric priority mapping (P1=4, ... P4=1) is engine-specific and
lives in the engine's configuration, not in this policy.

## Custom rule labels

Add one `## <rule-name>` section per custom rule. The placement engine
reads every section under this heading before placement (declarative
only — **no code change required** to extend the LLM-driven mode).

### Template

```
## <rule-name>
Trigger:       <label name | task field | JSON path>
Preserve:      <fields whose values must NOT change across reschedule>
Reflow:        <fields whose values the engine is free to recompute>
Conflicts:     <which existing rule wins on a tie — deadline /
               rescheduled flag / exclusion labels / explicit
               operator override>
Anti-patterns: <combinations to reject — e.g. label X + Y>
```

`Preserve` and `Reflow` describe fields the placement engine is
allowed to write. Common fields: `due.date`, `due.datetime`,
`deadline`, `priority`, `duration`.

> For rules with **side effects** (cross-system writes, registry
> mutations, persistent client-side flags) prefer a code change in
> the upstream repo over prose alone. Use this section only for
> placement rules the engine can enforce from task state.

### Worked example — keep calendar day, reflow time-of-day

```
## date-fixed
Trigger:       `date-fixed` label on the task
Preserve:      `due.date` (YYYY-MM-DD)
Reflow:        `due.datetime` time-of-day, within that calendar day,
               against the day's free slot
Conflicts:     deadline wins on a cross-day tie; rescheduled:true
               wins over date-fixed
Anti-patterns: do NOT combine with an exclusion label — that removes
               the task entirely, so date-fixed never fires on it
```

## Loader

The deterministic placement engine reads only the YAML front-matter
`labels:` block. Narrative sections above are pure documentation for
the LLM-driven mode.
