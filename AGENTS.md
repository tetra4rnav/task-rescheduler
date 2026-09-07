# Agent notes (task-rescheduler)

Filled mapping JSON, tokens, `POLICY.md`, and `TASK_CONTEXT.md` are **not** in git. Do not invent them.

## Add a GitHub → Todoist sync project

Follow the numbered procedure in the root README:

[Add a project (humans and agents)](README.md#add-a-project-humans-and-agents)

Summary of the contract:

1. Required inputs: GitHub Project URL and Todoist project URL (or `GET /projects` ids). If either is missing, ask.
2. `github_repos` must be `owner/repo` from `gh project item-list`, not a guessed name.
3. `todoist_project_id` is the Todoist **id** (URL segment after the last `-`, or API `id`). Never the display name.
4. `$schema_version` is `1.1`. Append to `projects`; do not replace unrelated entries.
5. Write destination: GitHub Actions variable `PROJECTS_JSON`, or the private file `$GITHUB_PROJECTS_CONFIG`. Never commit `github-projects.json`.
6. Dry-run before apply. `skip-bad-project` means a bad Todoist id.

## Schedule

Same CLI for Actions, cron, and Hermes: `todoist-github-sync/github_todoist_sync.py`. Wrapper: `todoist-github-sync/cron.example.sh`.

## Todoist rescheduler

Placement skill: [`todoist-rescheduler/SKILL.md`](todoist-rescheduler/SKILL.md). Product map: [`todoist-rescheduler/README.md`](todoist-rescheduler/README.md). Do not invent `POLICY.md` or tokens; copy `POLICY.template.md`; dry-run first (`run.js` applies when neither `--dry-run` nor `--apply` is set).
