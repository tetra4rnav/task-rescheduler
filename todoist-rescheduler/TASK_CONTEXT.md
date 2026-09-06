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

### IDEAS-JETRO — LIVE / on-demand (duration=1h, 1行要約のみ)

(Matt 2026-09-05: 「JETROのLIVE と書いてあるタスクは基本durationは1h」)
53 件。LLM 配置ヒント: issue 名に含まれる LIVE/on-demand 日付を目標にする。
各 task name に issue number + 受講 topic が含まれるため、個別優先度は一律 **P3 (今週中)** とする。

| task_id | name (short) | priority | duration_min | preferred_window | category | notes |
|---|---|---|---|---|---|---|
| 6hMxX2JvWvwXvC3p | JETRO #2 1-1① Trade Policy | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-01 on-demand |
| 6hMxX2JJVrqGMQ3G | JETRO #3 1-1② Trade Policy | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-01 on-demand |
| 6hMxX2H5v46WMP8p | JETRO #4 1-1③ Trade Policy | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-01 on-demand |
| 6hMxX2H5X5rXXPRG | JETRO #5 1-1④ Trade Policy | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-17 LIVE |
| 6hMxX29qVW9wqrpp | JETRO #6 1-1⑤ Trade Policy | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-24 LIVE |
| 6hMxX27PhPjrHH8G | JETRO #7 1-2① Growth & Dev | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-17 on-demand |
| 6hMxX24JhhVgGJ3p | JETRO #8 1-2② Growth & Dev | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-01 on-demand |
| 6hMxWxwvq8HrMXJG | JETRO #9  1-2③ Growth & Dev | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-15 LIVE |
| 6hMxWxwPr4VCMG5G | JETRO #10 1-2④ Growth & Dev | P3 | 60 | EDT 夜(限定) | github-issue | 2026-11-05 LIVE |
| 6hMxWxrPQh3gHPRp | JETRO #11 1-3① Bus & HR① | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-13 on-demand |
| 6hMxWxqgj3V4QQQG | JETRO #12 1-3② Bus & HR② | P3 | 60 | EDT 夜(限定) | github-issue | 2026-11-02 LIVE |
| 6hMxWxpMgFq6McJG | JETRO #13 1-3③ FreeTrade | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-14 on-demand |
| 6hMxWxfqrvMM53xG | JETRO #14 1-3④ Geoeconomics | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-07 on-demand |
| 6hMxWxfHXfvVWFJG | JETRO #15 1-3⑤ Trade & Dev | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-13 LIVE |
| 6hMxWxcvMm7PXGPp | JETRO #16 1-4① Finance & Dev | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-27 LIVE |
| 6hMxWxVxG28R7rpp | JETRO #17 1-4② Finance & Dev | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-27 LIVE |
| 6hMxWxVhfC7CRVCp | JETRO #18 1-4③ Finance & Dev | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-28 LIVE |
| 6hMxWxJvVxg84pcG | JETRO #19 1-4④ Finance & Dev | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-28 LIVE |
| 6hMxWxJr87CCfp8G | JETRO #20 1-4⑤ Finance & Dev | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-29 LIVE |
| 6hMxWxH95cqjhv3G | JETRO #21 1-5 IntlTax on Firms | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-01 on-demand |
| 6hMxWx8pgWvQHJ3p | JETRO #22 1-6 Policy Design | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-05 LIVE |
| 6hMxWx6mWp56hJgp | JETRO #23 2-1① Education | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-28 LIVE |
| 6hMxWx7hVG8pC8fp | JETRO #24 2-1② Education | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-06 on-demand |
| 6hMxWx4CQW8jHw9p | JETRO #25 2-1③ Education | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-06 on-demand |
| 6hMxWx452J9XFvWp | JETRO #26 2-1④ Education | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-19 LIVE |
| 6hMxWwxxFcXmgqqp | JETRO #27 2-2① Environment | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-01 on-demand |
| 6hMxWww97mmVmHjp | JETRO #28 2-2② Environment | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-01 on-demand |
| 6hMxWwmQCJG53jxp | JETRO #29 2-2③ Environment | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-01 on-demand |
| 6hMxWwpc9GrmVpRp | JETRO #30 2-2④ Environment | P3 | 60 | EDT 夜(限定) | github-issue | 2026-11-12 LIVE |
| 6hMxWwh4rJPvxggG | JETRO #31 2-3① DevMicroeco | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-06 LIVE |
| 6hMxWwc9jQFgH8CG | JETRO #32 2-3② DevMicroeco | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-14 on-demand |
| 6hMxWwX6j39fhqfG | JETRO #33 2-3③ DevMicroeco | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-14 on-demand |
| 6hMxWwRHMr6Fx94p | JETRO #34 2-3④ DevMicroeco | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-14 on-demand |
| 6hMxWwPMxGXQVxcG | JETRO #35 2-3⑤ DevMicroeco | P3 | 60 | EDT 夜(限定) | github-issue | 2026-11-10 LIVE |
| 6hMxWwHPCVRGJw5G | JETRO #36 2-4① HistIntDev | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-14 LIVE |
| 6hMxWwC6Wf7RFX9p | JETRO #37 2-4② HistIntDev | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-16 on-demand |
| 6hMxWwCrqGvmGf2G | JETRO #38 2-4③ HistIntDev | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-18 on-demand |
| 6hMxWw9Pm64cwhRG | JETRO #39 2-4④ HistIntDev | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-24 on-demand |
| 6hMxWw4PPjxMPFHp | JETRO #40 2-4⑤ HistIntDev | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-29 LIVE |
| 6hMxWvx6WJjxgp6p | JETRO #41 2-5 Disability | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-01 on-demand |
| 6hMxWvxC89xvGP8p | JETRO #42 2-6 Governance | P3 | 60 | EDT 夜(限定) | github-issue | 2026-11-09 LIVE |
| 6hMxWvvRJv7m8Xmp | JETRO #43 2-7 Lecture by alumni | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-24 LIVE |
| 6hMxWvqgfvPChPQG | JETRO #44 3① Group Work | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-08 LIVE |
| 6hMxWvq4Mr4hwhgp | JETRO #45 3② Group Work | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-10 LIVE |
| 6hMxWvh973hMHffp | JETRO #46 3③ Group Work | P3 | 60 | EDT 夜(限定) | github-issue | 2026-09-15 LIVE |
| 6hMxWvfR9XPPQvpp | JETRO #47 3④ Group Work | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-27 LIVE |
| 6hMxWvVFFq3hcQ8p | JETRO #48 3⑤ Group Work | P3 | 60 | EDT 夜(限定) | github-issue | 2026-10-29 LIVE |
| 6hMxWvFgcPQWFVfG | JETRO #51 4③ Sem:Indv Super | P3 | 60 | EDT 昼 | github-issue | TBD LIVE |
| 6hMxWv8Q4fQ8H66p | JETRO #52 4④ Sem:Indv Super | P3 | 60 | EDT 昼 | github-issue | TBD LIVE |
| 6hMxWv6gX66Q5v9p | JETRO #53 4⑤ Mid-term Pres | P3 | 60 | EDT 昼 | github-issue | 2026-10-22 LIVE |
| 6hMxWv72hmj4HwJG | JETRO #54 4⑥ Mid-term Pres | P3 | 60 | EDT 昼 | github-issue | 2026-10-26 LIVE |
| 6hMxWv3mxv4QP7JG | JETRO #55 4⑦ Final Pres | P3 | 60 | EDT 夜(限定) | github-issue | 2027-01-07 LIVE |
| 6hMxWv2rp3hrPWvG | JETRO #56 4⑧ Final Pres | P3 | 60 | EDT 夜(限定) | github-issue | 2027-01-14 LIVE |

