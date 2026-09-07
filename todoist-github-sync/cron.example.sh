#!/usr/bin/env bash
# Agent- and cron-friendly wrapper around github_todoist_sync.py.
#
# Required environment:
#   TODOIST_API_TOKEN          Todoist REST token
#   GITHUB_PROJECTS_CONFIG     Path to your filled github-projects.json
#
# Optional:
#   GH_TOKEN                   PAT for `gh` (or authenticate `gh` on the host)
# Extra args are passed through (e.g. --dry-run).
#
# Crontab (every 10 minutes):
#   */10 * * * * TODOIST_API_TOKEN=… GITHUB_PROJECTS_CONFIG=/path/to/github-projects.json /path/to/todoist-github-sync/cron.example.sh
set -euo pipefail

if [[ -z "${TODOIST_API_TOKEN:-}" ]]; then
  echo "error: TODOIST_API_TOKEN is not set" >&2
  exit 1
fi
if [[ -z "${GITHUB_PROJECTS_CONFIG:-}" ]]; then
  echo "error: GITHUB_PROJECTS_CONFIG must be a path to your github-projects.json" >&2
  exit 1
fi
if [[ ! -f "$GITHUB_PROJECTS_CONFIG" ]]; then
  echo "error: config file not found: $GITHUB_PROJECTS_CONFIG" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/github_todoist_sync.py" \
  --config "$GITHUB_PROJECTS_CONFIG" \
  "$@"
