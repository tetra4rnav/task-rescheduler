// Applies LLM-decided placements to Todoist and updates the task registry.
//
// Input: a placements JSON object produced by the LLM after reading the task
// registry + policy markdown. Shape:
//
//   {
//     "placements": [
//       { "task_id": "...", "due": "2026-09-06T10:00:00Z" },
//       ...
//     ]
//   }
//
// For each placement: writes the Todoist due datetime, then marks the task as
// `rescheduled: true` in the persistent registry with a timestamp.
//
// This is the WRITE path of the new LLM-driven rescheduler (2026-09-05).

import fs from 'node:fs/promises';
import { pickDefined } from './util.js';

export async function applyLlmPlacements(placements, {
  todoistClient,
  registryPath,
  logger,
}) {
  const { loadRegistry, writeRegistry } = await import('./registry.js');
  const results = [];
  const errors = [];

  for (const placement of placements) {
    const { task_id, due } = placement;
    if (!task_id || !due) {
      errors.push({ task_id, error: 'missing task_id or due' });
      continue;
    }
    try {
      await todoistClient.updateTaskDue(task_id, { due_datetime: due });
      results.push({ task_id, due, status: 'applied' });
      logger?.info?.('llm placement applied', { taskId: task_id, due });
    } catch (error) {
      errors.push({ task_id, due, error: error.message });
      logger?.error?.('llm placement failed', { taskId: task_id, error: error.message });
    }
  }

  // Update the registry: set rescheduled=true + timestamp for applied tasks.
  const registry = await loadRegistry(registryPath);
  const appliedIds = new Set(results.map((r) => String(r.task_id)));
  const now = new Date().toISOString();
  registry.tasks = registry.tasks.map((t) => {
    if (appliedIds.has(String(t.id))) {
      return { ...t, rescheduled: true, last_rescheduled_at: now };
    }
    return t;
  });
  registry.updated_at = now;
  await writeRegistry(registry, registryPath);

  return { applied: results, errors, registry_path: registryPath };
}

export async function readPlacements(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : data.placements;
  if (!Array.isArray(list)) {
    throw new Error('placements file must be a JSON array or {placements: [...]}');
  }
  return list;
}

export { pickDefined };