# task-rescheduler

MIT monorepo with **two independent products**. They can share a Todoist
account if you choose; they do **not** share configuration, schedulers, or
a required pipeline. Using one does not require the other.

## Products

| Product | What it does |
|---|---|
| [`todoist-github-sync/`](todoist-github-sync/README.md) | One-way GitHub Issues (and optional Projects dates) → Todoist tasks |
| [`todoist-rescheduler/`](todoist-rescheduler/README.md) | Place Todoist tasks into free time (deterministic planner + optional LLM pass). Google Calendar is **read-only** via secret iCal |

## Layout

```
task-rescheduler/
├── AGENTS.md
├── LICENSE
├── .github/workflows/           # Optional Actions scheduler for sync only
├── todoist-github-sync/         # Product: GitHub → Todoist
└── todoist-rescheduler/         # Product: Todoist placement
    ├── run.js
    ├── engine/
    ├── SKILL.md
    ├── POLICY.template.md
    └── TASK_CONTEXT.example.md
```

## Privacy — not in git

- Filled project mapping JSON (`github-projects.json` is gitignored)
- API tokens / PATs
- Live `POLICY.md` / `TASK_CONTEXT.md` (copy from the templates)

## Agents

Repo-level contracts: [`AGENTS.md`](AGENTS.md). Follow the **product** README
for the product you are changing. Rescheduler skill:
[`todoist-rescheduler/SKILL.md`](todoist-rescheduler/SKILL.md).

## License

MIT — see [`LICENSE`](LICENSE).
