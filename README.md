# task-rescheduler

Two tools that keep GitHub work and Todoist in the same day:

1. **GitHub → Todoist sync** (`todoist-github-sync/`) — one-way copy of Issues (and optional GitHub Projects dates) into Todoist tasks.
2. **Todoist rescheduler** (`todoist-rescheduler/`) — places those tasks into free time. The planner is deterministic; an optional LLM pass can override low-confidence duration estimates. Google Calendar is **read-only**. Apply writes Todoist due datetime, and duration only when the task has none and is not marked fixed.

This repository is MIT-licensed. Personal tokens, repo lists, and filled project JSON do **not** belong in git.

## Layout

```
task-rescheduler/
├── AGENTS.md                 # How agents add a project / must not invent config
├── SKILL.md                  # Policy-driven scheduling skill (generic)
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
    ├── POLICY.template.md
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

Copy [`todoist-github-sync/schema.example.json`](todoist-github-sync/schema.example.json). `github_repos` are `owner/repo`. `todoist_project_id` is the Todoist project **id** (not the display name — names change). Optional `github_project_number` plus `github_project_owner` if the Projects board owner is not the repo owner. Keep the filled copy **private**.

Config path for the CLI (first match wins): `--config <path>`, then `$GITHUB_PROJECTS_CONFIG`.

### Add a project (humans and agents)

Do **not** invent ids, repo names, or Todoist project names. Do **not** commit the filled JSON. Append one object to `projects` in the live mapping (`PROJECTS_JSON` variable, or the private file `$GITHUB_PROJECTS_CONFIG`), then dry-run.

**Inputs you must have**

- GitHub Project URL, e.g. `https://github.com/users/OWNER/projects/N` or `https://github.com/orgs/ORG/projects/N`
- Todoist project URL, e.g. `https://app.todoist.com/app/project/some-slug-6gF73vWPcvWpjjj2`
- `gh` authenticated (or `GH_TOKEN` / `GH_PAT`) with access to that board and its repos

**Extract fields**

1. `github_project_number` = the integer `N` at the end of the Project URL.
2. `github_project_owner` = `OWNER` or `ORG` from the URL. Omit it when every repo below shares that owner (the CLI infers it).
3. Linked repos = unique `content.repository` values from:

   ```bash
   gh project item-list N --owner OWNER --format json --limit 200
   ```

   Each value is already `owner/repo`. Put them in `github_repos`. If the board has no issue-linked items, stop and ask the operator — do not guess a repo.
4. `todoist_project_id` = the **id**, never the display name:
   - From the Todoist URL: the path segment after the last `-` (`…/project/rzdc-philippines-6gF73vWPcvWpjjj2` → `6gF73vWPcvWpjjj2`), or
   - From `GET https://api.todoist.com/api/v1/projects` (`Authorization: Bearer $TODOIST_API_TOKEN`): use the `id` field of the matching project.
5. `name` = a human label only (Project title is fine). The sync engine does not match on it.

**Object to append** (schema `$schema_version` `1.1`):

```json
{
  "name": "Example Project",
  "github_repos": ["your-org/your-repo"],
  "todoist_project_id": "6gF73vWPcvWpjjj2",
  "github_project_number": 4,
  "issue_labels_include": [],
  "issue_labels_exclude": []
}
```

**Where to write**

| How you run sync | Edit |
|---|---|
| GitHub Actions | Repository **variable** `PROJECTS_JSON` (Settings → Secrets and variables → Actions → Variables). Not a secret; names cannot start with `GITHUB_`. |
| cron / Hermes / other agents | The private file at `$GITHUB_PROJECTS_CONFIG`. Filename `github-projects.json` is gitignored. |

**After the edit**

1. Dry-run (`workflow_dispatch` with Plan only, or `cron.example.sh --dry-run`).
2. Confirm the new `owner/repo` appears and there is no `skip-bad-project` (wrong Todoist id) and no project-date `WARN:` (wrong board number/owner).
3. Apply. Ensure `GH_PAT` / `GH_TOKEN` can read the new repo’s issues (`repo` or fine-grained Issues: Read) and the board (`read:project`).

If any id or repo is unknown, ask the operator. Do not create a GitHub repo or Todoist project unless they explicitly ask.

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
4. Actions → **GitHub → Todoist sync** → Run workflow with **Plan only** checked. In the **Run sync** step, read the `=== GitHub → Todoist (dry-run, no writes) ===` block (counts + per-issue Changes). `WARN:` lines and `skip-bad-project` mean the mapping is wrong.
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

Planner details, exit codes, and flags: [`todoist-rescheduler/daily-scheduler/README.md`](todoist-rescheduler/daily-scheduler/README.md). Policy and per-task hints are private; start from `POLICY.template.md` and `TASK_CONTEXT.example.md`. Active policy path: `$TASK_RESCHEDULER_POLICY`.

## Policy storage (template vs active copy)

This repo publishes `todoist-rescheduler/POLICY.template.md` as the
canonical scaffold. **Do not use the template directly with a real
agent**.

Your **active** `POLICY.md` must be:

1. Copied from `POLICY.template.md` to a location owned by your agent
   harness or operator profile.
2. Edited to contain your labels, working hours, priority bands, and
   any custom `## <rule-name>` sections.
3. **Excluded from version control** in your working copy.

The reference implementation in `todoist-rescheduler/` reads the
active `POLICY.md` from `$TASK_RESCHEDULER_POLICY` (see
[`todoist-rescheduler/daily-scheduler/src/policy.js`](todoist-rescheduler/daily-scheduler/src/policy.js)).
If unset, it looks for `todoist-rescheduler/POLICY.md` next to the
module (that live file is not in git).
Similarly `TASK_CONTEXT.example.md` is a scaffold for a private
`TASK_CONTEXT.md`.

Storing the active `POLICY.md` in a public repo would leak
operator-specific data (project names, working hours, custom rule
sections, label choices). Keep it private.

## What this repo does not contain

- Filled `github-projects.json` (gitignored filename)
- API tokens
- Live `POLICY.md` / `TASK_CONTEXT.md`

## License

MIT — see [`LICENSE`](LICENSE).
