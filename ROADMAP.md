# Future work

Non-binding index. Trackable work lives in GitHub issues. This file is not a
schedule and does not change the **two independent products** contract in
[`README.md`](README.md).

Development board: [task-rescheduler development](https://github.com/users/tetra4rnav/projects/8).

## Teams

| Team | Directory | Label |
|---|---|---|
| `reallocator` | [`todoist-rescheduler/`](todoist-rescheduler/README.md) | `todoist-rescheduler` |
| `gh-todoist-sync` | [`todoist-github-sync/`](todoist-github-sync/README.md) | `todoist-github-sync` |

The board **Team** field should use those two values (not `Squad 1/2/3`
placeholders). Notion, Calendar write-back, and an internal task store are
**unowned** until a source-of-truth model is chosen; do not add a third team
for them yet.

## Design (no team)

- [#22 Design: source of truth for a possible one-stop task assistant](https://github.com/tetra4rnav/task-rescheduler/issues/22) — models A / B / C, no pick

## `gh-todoist-sync`

- [#15](https://github.com/tetra4rnav/task-rescheduler/issues/15) issue-state emoji on Todoist titles
- [#16](https://github.com/tetra4rnav/task-rescheduler/issues/16) reopen Todoist task while GitHub issue stays open
- [#19](https://github.com/tetra4rnav/task-rescheduler/issues/19) blocked-by documented but not written
- [#20](https://github.com/tetra4rnav/task-rescheduler/issues/20) implement or drop reserved label filters

## `reallocator`

- [#13](https://github.com/tetra4rnav/task-rescheduler/issues/13) planner double-booking against existing Todoist dues
- [#17](https://github.com/tetra4rnav/task-rescheduler/issues/17) POLICY.md as the only source for behavior labels
- [#21](https://github.com/tetra4rnav/task-rescheduler/issues/21) leftover operator hub/dashboard scripts

## Privacy

Filled mapping JSON, tokens, and live `POLICY.md` / `TASK_CONTEXT.md` stay
out of git. See [`README.md`](README.md).
