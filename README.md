# task-rescheduler

Two tools that keep GitHub work and Todoist in the same day:

1. **GitHub → Todoist sync** (`todoist-github-sync/`) — one-way copy of Issues (and optional GitHub Projects dates) into Todoist tasks.
2. **Todoist rescheduler** (`todoist-rescheduler/`) — places those tasks into free time. The planner is deterministic; an optional LLM pass can override low-confidence duration estimates. Google Calendar is **read-only**. The only calendar-adjacent write is Todoist due datetime.

This repository is MIT-licensed. Personal tokens, repo lists, and filled project JSON do **not** belong in git.

## Layout

```
task-rescheduler/
├── .github/workflows/        # Optional GitHub Actions scheduler for sync
├── todoist-github-sync/      # GitHub Issue → Todoist CLI
│   ├── github_todoist_sync.py
│   ├── cron.example.sh       # crontab / Hermes / other agent wrapper
│   ├── schema.example.json   # mapping JSON template
│   ├── secrets.example       # env / Actions secret names
│   └── README.md             # sync behavior and schema
└── todoist-rescheduler/      # Rescheduling pipeline
    ├── rescheduler/run.js    # CLI entry point
    ├── daily-scheduler/      # planner core
    ├── POLICY.example.md
    └── TASK_CONTEXT.example.md
```

## Requirements

| Tool | Needs |
|---|---|
| Sync | Python ≥ 3.10, [`gh`](https://cli.github.com/) on `PATH`, `TODOIST_API_TOKEN` |
| Rescheduler | Node.js ≥ 24, `TODOIST_API_TOKEN`. Calendar access only if you do not pass `--no-calendar` |

`gh` must be able to read Issues on every repo you map, and GitHub Projects if you set `github_project_number`. The default Actions `GITHUB_TOKEN` cannot do that — use a PAT. Names and scopes: [`todoist-github-sync/secrets.example`](todoist-github-sync/secrets.example).

## GitHub → Todoist sync

GitHub is authoritative for issue identity, title, comments, and relationships. Todoist-side **duration**, **priority**, **due**, and **deadline** are never overwritten; GitHub Project dates only fill empty Todoist fields.

Full behavior: [`todoist-github-sync/README.md`](todoist-github-sync/README.md).

### 1. Mapping file

Copy [`todoist-github-sync/schema.example.json`](todoist-github-sync/schema.example.json), fill `github_owner`, `github_repos`, `todoist_project`, and optional `github_project_number`. Keep the filled copy **private**.

Config path for the CLI (first match wins): `--config <path>`, then `$GITHUB_PROJECTS_CONFIG`.

### 2. Pick one scheduler

All three call the same CLI. Run `--dry-run` first.

**GitHub Actions** (workflow in this repo, every 10 minutes)

1. Fork or use your own copy of the repo (credentials stay on *your* repo).
2. Settings → Secrets and variables → Actions:

   **Secrets** (write-only; you cannot read them back):

   | Name | Value |
   |---|---|
   | `TODOIST_API_TOKEN` | Todoist REST token |
   | `GH_PAT` | PAT (`gh` uses this as `GH_TOKEN`) |

   **Variables** (visible and editable in the UI):

   | Name | Value |
   |---|---|
   | `PROJECTS_JSON` | The **JSON body** of your filled mapping, not a file path |

   The mapping is a variable on purpose: it is not a credential, and a secret would be painful to edit. It is still not in git.

3. Enable Actions if a fork disabled them.
4. Actions → **GitHub → Todoist sync** → Run workflow with **Plan only** checked. Inspect `skipped_dates` and `WARN:` lines.
5. Run again with Plan only unchecked. The `*/10 * * * *` schedule then applies on its own.

Scheduled workflows can drift by several minutes. On a public repo they pause after about 60 days with no repository activity. Fork pull requests do not receive secrets.

**cron or systemd**

```bash
export TODOIST_API_TOKEN=…          # from Todoist
export GITHUB_PROJECTS_CONFIG=/path/to/github-projects.json
# optional if `gh` is not already logged in:
export GH_TOKEN=…

# once:
bash todoist-github-sync/cron.example.sh --dry-run

# crontab, every 10 minutes:
# */10 * * * * TODOIST_API_TOKEN=… GITHUB_PROJECTS_CONFIG=/path/to/github-projects.json /path/to/todoist-github-sync/cron.example.sh
```

**Hermes or other AI-agent crons**

Same contract as cron: do not invent config. Set `TODOIST_API_TOKEN` and `GITHUB_PROJECTS_CONFIG` (path to the private JSON) on the host, ensure `gh` is authenticated or `GH_TOKEN` is set, working directory anywhere, schedule `*/10 * * * *`, command:

```bash
python3 /path/to/task-rescheduler/todoist-github-sync/github_todoist_sync.py \
  --config "$GITHUB_PROJECTS_CONFIG"
```

or `todoist-github-sync/cron.example.sh` (pass `--dry-run` until you trust the plan). `$HERMES_HOME/configs/github-projects.json` is one valid path among others.

### 3. Local CLI

```bash
python3 todoist-github-sync/github_todoist_sync.py \
  --config /path/to/github-projects.json \
  --dry-run

python3 todoist-github-sync/github_todoist_sync.py \
  --config /path/to/github-projects.json
```

## Todoist rescheduler

```bash
node todoist-rescheduler/rescheduler/run.js --dry-run --timezone UTC
node todoist-rescheduler/rescheduler/run.js --apply --timezone UTC
node todoist-rescheduler/rescheduler/run.js --apply --no-calendar --timezone UTC
```

Planner details, exit codes, and flags: [`todoist-rescheduler/daily-scheduler/README.md`](todoist-rescheduler/daily-scheduler/README.md). Policy and per-task hints are private; start from `POLICY.example.md` and `TASK_CONTEXT.example.md`.

## What this repo does not contain

- Filled `github-projects.json` (gitignored filename)
- API tokens
- Live `POLICY.md` / `TASK_CONTEXT.md`

## License

MIT — see [`LICENSE`](LICENSE).
