# Agent notes (task-rescheduler)

This repository holds **two independent products**. Do not invent private
config (tokens, filled mapping JSON, live `POLICY.md` / `TASK_CONTEXT.md`).
Follow the product README for the product you are changing.

## todoist-github-sync

Procedure: [Add a project (humans and agents)](todoist-github-sync/README.md#add-a-project-humans-and-agents)

Contract:

1. Required inputs: GitHub Project URL and Todoist project URL (or `GET /projects` ids). If either is missing, ask.
2. `github_repos` must be `owner/repo` from `gh project item-list`, not a guessed name.
3. `todoist_project_id` is the Todoist **id** (URL segment after the last `-`, or API `id`). Never the display name.
4. `$schema_version` is `1.1`. Append to `projects`; do not replace unrelated entries.
5. Write destination: GitHub Actions variable `PROJECTS_JSON`, or the private file `$GITHUB_PROJECTS_CONFIG`. Never commit `github-projects.json`.
6. Dry-run before apply. `skip-bad-project` means a bad Todoist id.

Scheduler CLI: `todoist-github-sync/github_todoist_sync.py`. Wrapper: `todoist-github-sync/cron.example.sh`.

## todoist-rescheduler

Product map: [`todoist-rescheduler/README.md`](todoist-rescheduler/README.md).
Skill: [`todoist-rescheduler/SKILL.md`](todoist-rescheduler/SKILL.md).

Contract:

1. Do not invent `POLICY.md`, tokens, or calendar secrets.
2. Copy `POLICY.template.md` to a private path; set `$TASK_RESCHEDULER_POLICY`.
3. Dry-run first. `run.js` **applies** if neither `--dry-run` nor `--apply` is passed; `engine` `run` defaults to dry-run.
4. Calendar busy/free: `GOOGLE_CALENDAR_ICS_URL` (secret iCal) or `--no-calendar`. No Hermes / `gog`.
5. Never commit live `POLICY.md` / `TASK_CONTEXT.md`.
