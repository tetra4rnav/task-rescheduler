# todoist-github-sync

One-way sync from GitHub Issues to Todoist tasks. Independent of
`todoist-rescheduler`: same CLI, any scheduler.

**To run it every 10 minutes**, see [Pick one scheduler](#pick-one-scheduler).
**To add a GitHub Project / Todoist project pair**, see
[Add a project (humans and agents)](#add-a-project-humans-and-agents).
Do not invent `todoist_project_id` or `owner/repo`; do not commit the filled JSON.
This file is the product front door and behavior / schema reference.

## What it does

For every project in your config:

1. Lists all GitHub issues (open + closed) via `gh issue list`.
2. Optionally reads GitHub Projects dates (`gh project item-list`).
3. Reconciles each issue against an existing Todoist task (matched by the
   issue URL in the description and the `github-issue` label).
4. Creates new Todoist tasks for new issues, updates existing ones in place
   (preserves duration / priority), moves them between Todoist projects when
   the GitHub side disagrees, and closes them when the GitHub issue closes.
5. Mirrors the GitHub issue body and comments to Todoist task comments,
   idempotently — re-runs only post what's new.
6. Wires up **parent / dependency** links between Todoist tasks so the
   Todoist-side tree mirrors the GitHub-side relationships (see below).

GitHub is authoritative for issue identity, title, comments, and
relationships. Todoist-side edits to **duration**, **priority**, **due**,
and **deadline** are never overwritten. GitHub Project dates only fill
empty Todoist fields (see date sync below).

## Relationship sync (sub-task + blocked-by)

The sync engine maps GitHub's two distinct issue-relationship primitives to
their Todoist equivalents. Both run in a **second pass** so newly-created
parent tasks exist before children link to them.

| GitHub relationship | Where it lives | Todoist mapping |
|---|---|---|
| **Sub-issue** (`parent_issue_url` on the child) | `gh issue list --json parent_issue_url` | **sub-task** (`parent_id` field, hierarchical grouping only) |
| **Blocked by** (`issue_dependencies_summary.blocked_by`) | `GET /repos/{o}/{r}/issues/{n}/dependencies/blocked_by` | **task dependency** (`dependency_ids` via Sync API — gating enforcement) |

Notes:

- Issues with **neither** relationship continue to sync as plain top-level
  Todoist tasks (unchanged from the previous behaviour).
- A closed parent/blocker that was never synced to Todoist is **not**
  auto-created — child / blocked tasks record the GitHub issue number in
  their action log so an operator can investigate.
- `set_parent` writes through the REST API (regular task field);
  `set_dependencies` queues per-task and flushes via the Sync API in one
  batch (REST does not expose `dependency_ids`).
- The parent / dependency links are emitted **after** Pass 1 finishes all
  create/update writes, so parents created in the same run get wired up to
  their children without a follow-up run.

### Requirements for relationship sync

- `gh` CLI **>= 2.86.0** (released August 2025) — required for the
  `parent_issue_url`, `sub_issues_summary`, and `issue_dependencies_summary`
  JSON fields on `gh issue list`. Older versions emit a clear warning on
  stderr and skip the relationship writes for that run while still performing
  the regular task sync.

## Schema

```json
{
  "$schema_version": "1.1",
  "projects": [
    {
      "name": "Example Project",
      "github_repos": ["your-org/your-repo"],
      "todoist_project_id": "1234567890",
      "github_project_number": 4,
      "github_project_owner": null,
      "issue_labels_include": [],
      "issue_labels_exclude": []
    }
  ]
}
```

- `github_repos` — `owner/repo` strings. Multiple repos can map to the same Todoist project.
- `todoist_project_id` — Todoist project **id** (stable). List ids with `GET https://api.todoist.com/api/v1/projects`. Names are not used; they change and collide.
- `github_project_number` (optional) — if set, `start date` → `due_date`,
  `target date` → `deadline_date` are pulled from the GitHub Projects board
  and applied only when the matching Todoist field is empty. Existing
  Todoist due / deadline values are never overwritten. The `date-locked`
  label additionally blocks filling empty fields.
- `github_project_owner` (optional) — `--owner` for `gh project item-list`.
  Defaults to the unique owner in `github_repos`. Required when those owners differ.
- `issue_labels_include` / `issue_labels_exclude` (optional, reserved) —
  label-based filtering, not yet implemented.

See [`schema.example.json`](./schema.example.json) for a starter template.

## Usage

```bash
# Dry-run (no writes — recommended first step):
python3 todoist-github-sync/github_todoist_sync.py \
    --config /path/to/github-projects.json \
    --dry-run

# Apply (writes to Todoist):
python3 todoist-github-sync/github_todoist_sync.py \
    --config /path/to/github-projects.json
```

Both modes expect `TODOIST_API_TOKEN` in the environment.

Every run prints two reports:

- **stderr** — a human-readable **Changes** list: counts, then create / update / close / bad-id rows grouped by `owner/repo`, with issue number, title, and why it would write (title, description, due, comments, parent). `skip-closed-no-task` and no-op `unchanged` tasks are counted but not listed. GitHub Actions shows this in the **Run sync** step.
- **stdout** — the same data as JSON (`summary`, `log`, and in dry-run `would_call`). Use `--json-only` to suppress the stderr list.

`--dry-run` still does not write to Todoist. Review the Changes list (and `skipped_dates`) before apply.

## Mapping file

Copy [`schema.example.json`](./schema.example.json). `github_repos` are
`owner/repo`. `todoist_project_id` is the Todoist project **id** (not the
display name — names change). Optional `github_project_number` plus
`github_project_owner` if the Projects board owner is not the repo owner.
Keep the filled copy **private**.

Config path for the CLI (first match wins): `--config <path>`, then
`$GITHUB_PROJECTS_CONFIG`.

## Add a project (humans and agents)

Do **not** invent ids, repo names, or Todoist project names. Do **not**
commit the filled JSON. Append one object to `projects` in the live mapping
(`PROJECTS_JSON` variable, or the private file `$GITHUB_PROJECTS_CONFIG`),
then dry-run.

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

## Pick one scheduler

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

Same contract as cron: do not invent config. Set `TODOIST_API_TOKEN` and
`GITHUB_PROJECTS_CONFIG` (path to the private JSON) on the host, ensure
`gh` is authenticated or `GH_TOKEN` is set, working directory anywhere,
schedule `*/10 * * * *`, command:

```bash
python3 /path/to/task-rescheduler/todoist-github-sync/github_todoist_sync.py \
  --config "$GITHUB_PROJECTS_CONFIG"
```

or `todoist-github-sync/cron.example.sh` (pass `--dry-run` until you trust
the plan). `$HERMES_HOME/configs/github-projects.json` is one valid path
among others.

## Migrating from openclaw-mirror

If you have an existing `openclaw-mirror/scripts/project_registry.json`,
use `migrate_openclaw_registry.py` to convert it to the new schema:

```bash
# Preview the conversion (writes JSON to stdout, no file written):
python3 todoist-github-sync/migrate_openclaw_registry.py \
    --source /path/to/old/project_registry.json \
    --dry-run

# Write the new config somewhere private (not this repo):
python3 todoist-github-sync/migrate_openclaw_registry.py \
    --source /path/to/old/project_registry.json \
    --output /path/to/github-projects.json
```

The migration is one-shot; the new config is the source of truth from then
on. The script skips entries with empty `github` lists and rejects entries
whose repos span multiple distinct GitHub owners (you'll need to split
those manually before migrating).

## Configuration injection

Config path resolves in this order:

1. `--config <path>` flag
2. `$GITHUB_PROJECTS_CONFIG` environment variable

Both must point to the same schema; if neither is set the script exits
with a clear error. GitHub Actions pastes the JSON into repository
variable `PROJECTS_JSON`; cron and agents use a private file path.
See [`secrets.example`](./secrets.example) and [`cron.example.sh`](./cron.example.sh).

## Requirements

- Python ≥ 3.10 (uses `dataclass(slots=True)`-adjacent idioms).
- `gh` CLI on `$PATH` — authenticated as a user with `repo` and
  `read:project` scopes. If you also want start/target dates to sync, the
  token needs `read:org` (Projects v2 user projects).
- `TODOIST_API_TOKEN` in the environment.

## What you'll see on stdout

The dry-run prints a JSON object:

```json
{
  "ok": true,
  "dry_run": true,
  "config": "/path/to/config.json",
  "projects_in_config": 8,
  "issues": 158,
  "managed_todoist_tasks": 112,
  "summary": {
    "skip-closed-no-task": 58,
    "updated": 100
  },
  "log": [
    {"owner": "...", "repo": "...", "number": 1, "action": "updated", "comments_added": 0},
    ...
  ],
  "would_call": [
    {"op": "update", "task_id": "...", "body": {...}},
    ...
  ]
}
```

The `would_call` field is only present in `--dry-run` mode and lists
every Todoist write apply would make. Review it before running without
`--dry-run`.

## Warnings

The script prints human-readable `WARN:` lines to stderr when:

- `gh project item-list` returns a 403 (missing token scope — common
  cause is a fine-grained PAT, which doesn't include `read:project`)
- the project board has no items linked to issues
- the gh CLI is missing from `$PATH`
- the project number in the config doesn't match a real board

In `--dry-run` mode these warnings are surfaced but the plan still runs
(so you can inspect what *would* have been written). Without `--dry-run`
any warning causes the script to exit `2` before touching Todoist — we
refuse to write tasks without the dates you intended.

## Tests

```bash
cd todoist-github-sync
python3 -m unittest tests.test_migrate
python3 -m unittest tests.test_sync
```

Both are stdlib-only (`unittest`); no external dependencies. The
`todoist-github-sync` directory name contains a hyphen so it can't be a
normal Python package; the tests use `tests/_loader.py` to import the
modules by file path.

## Operational notes

- This is **one-way** sync: Todoist → GitHub is intentionally unsupported.
  Edits in Todoist that should flow back to GitHub need a separate workflow.
- Duration, priority, due, and deadline on existing Todoist tasks are
  **preserved**. GitHub Project dates (`start date` → `due_date`,
  `target date` → `deadline_date`) are written on create, and on update
  only when that Todoist field is empty. A later GitHub date change does
  not clobber a date you (or the rescheduler) already set in Todoist.
  Clear the Todoist field if you want GitHub to fill it again.
- The `date-locked` label on a Todoist task prevents the script from
  writing `due_date` and `deadline_date` even when those fields are empty.
  Apply it when you have cleared a date on purpose and do not want GitHub
  Projects to refill it.

## License

MIT — same as the parent `task-rescheduler` repo.
