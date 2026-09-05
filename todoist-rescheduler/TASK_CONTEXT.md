---
file: TASK_CONTEXT.md
purpose: Human-curated per-task reschedule context for LLM-driven rescheduler (agent mode, 2026-09-05+).
consumer: LLM rescheduler stage — read AFTER POLICY.md, BEFORE placements decision.
sibling: POLICY.md
created: 2026-09-05
---

# Task Context (per-task reschedule hints)

人間が対話で決めた **タスク個別の優先度・所要時間・配置ヒント** を
記録する。LLM 駆動の再配置は `POLICY.md` の次にこのファイルを読んで
配置判断に使う。

- **書込タイミング**: Slack chat 内で優先度 / 所要時間 / 配置条件が
  変わったら、その場で追記または patch する
- **git**: 同じ repo (`task-rescheduler/todoist-rescheduler/`) で管理
- **load order**: `POLICY.md` → `TASK_CONTEXT.md` の順

## フィールド (各タスクブロック)

| フィールド | 意味 | 例 |
|---|---|---|
| `task_id` | Todoist task ID (`str`, 数字) | `9012345678901` |
| `name` | task 名 (snapshot) | `PhysioCards spec review` |
| `priority` | `P1=do ASAP` / `P2=today` / `P3=this week` / `P4=whenever` | `P2` |
| `duration_min` | 推定所要時間(分) | `90` |
| `preferred_window` | 配置に向く EDT 時間帯 | `EDT 朝` / `EDT 昼(深い)` / `EDT 夜(限定)` |
| `deadline_hint` | deadline 補足 (任意) | `soft: 今週中`, `hard: 2026-09-12` |
| `anchor_before` / `anchor_after` | 必須の前後タスク (task_id or name) | `after: vZDC sim session` |
| `category` | 任意タグ | `github-issue`, `research`, `personal-care` |
| `notes` | 自由メモ | `blocks #1234` |
| `updated_at` | 最終更新 UTC | `2026-09-05T18:30:00Z` |

> priority 解釈: P1 = 当日中に必ず / P2 = 今日入れる努力 / P3 = 今週中 /
> P4 = いつか。値変更は自由。

## タスク一覧

(以下、対話で追記)

