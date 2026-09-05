// Task registry for the LLM-driven rescheduler (2026-09-05).
//
// The registry is a single persistent JSON file that records every task in
// scope for rescheduling. It is refreshed on each run (fetch latest Todoist
// state) while preserving the `rescheduled` flag across runs so the LLM can
// see which tasks have already been placed.
//
// File location: $HOME/cron/output/tasks-registry.json (cron output dir).
//
// The registry deliberately stores ONLY identifying info (id, project,
// github-issue flag, due, priority) — NOT task details. The LLM reasons from
// this file plus the human-authored policy markdown.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_REGISTRY_PATH = path.join(os.homedir(), 'cron', 'output', 'tasks-registry.json');

// Detect a GitHub issue from a Todoist task's content / description.
// Format seen in this workspace: "[<owner>/<repo> #<number>](https://github.com/...)"
function detectGithubIssue(task) {
  const haystack = `${task.content ?? ''}\n${task.description ?? ''}`;
  const link = /github\.com\/([^/\s]+)\/([^/\s#]+)\/issues\/(\d+)/i.exec(haystack);
  if (link) {
    return {
      is_github_issue: true,
      owner: link[1],
      repo: link[2],
      issue_number: Number(link[3]),
    };
  }
  const bracket = /\[([^\]]+)\s+#(\d+)\]/i.exec(task.content ?? '');
  if (bracket) {
    const [ownerRepo, num] = bracket[1].trim().split('/');
    return {
      is_github_issue: true,
      owner: ownerRepo,
      repo: ownerRepo, // may be just repo name without owner
      issue_number: Number(num),
    };
  }
  return { is_github_issue: false };
}

// Build the registry entry for one task. `previous` is the prior registry
// entry (if any) used to preserve the rescheduled flag.
function buildEntry(task, previous) {
  const gh = detectGithubIssue(task);
  const due = task.due?.datetime ?? task.due?.date ?? null;
  return {
    id: task.id,
    project: task.project_name ?? null,
    content: task.content ?? '', // short title for identification only
    ...gh,
    due,
    priority: task.priority ?? 1,
    deadline_at: task.deadline_at ?? null,
    labels: task.labels ?? [],
    // Preserve the rescheduled flag from the previous run if the task still exists.
    rescheduled: previous?.rescheduled ?? false,
    last_rescheduled_at: previous?.last_rescheduled_at ?? null,
  };
}

export async function loadRegistry(filePath = DEFAULT_REGISTRY_PATH) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    return {
      schema_version: data.schema_version ?? '1',
      updated_at: data.updated_at ?? null,
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
    };
  } catch {
    // File missing or unreadable → start fresh.
    return { schema_version: '1', updated_at: null, tasks: [] };
  }
}

// Merge fresh Todoist tasks into the existing registry, preserving flags.
export function mergeRegistry(existing, tasks, { now }) {
  const byId = new Map(existing.tasks.map((t) => [String(t.id), t]));
  const merged = tasks.map((task) => buildEntry(task, byId.get(String(task.id))));
  return {
    schema_version: '1',
    updated_at: now,
    // Keep tasks that are still incomplete; drop completed/removed ones.
    tasks: merged,
  };
}

export async function writeRegistry(registry, filePath = DEFAULT_REGISTRY_PATH) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  return filePath;
}