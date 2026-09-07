// Applies LLM-decided placements to Todoist and updates the task registry.
//
// Input: a placements JSON object produced by the LLM after reading the task
// registry + policy markdown. Shape:
//
//   {
//     "placements": [
//       { "task_id": "...", "due": "2026-09-06T10:00:00Z", "duration_minutes": 45 },
//       ...
//     ]
//   }
//
// `due` is required. `duration_minutes` is optional. Duration is written only
// when the live task has no Todoist duration and does not carry the POLICY
// fixed_duration label; otherwise due is written alone.

import fs from 'node:fs/promises';
import { shouldPersistDuration, todoistDurationWriteFields } from './duration.js';
import { pickDefined } from './util.js';

export async function applyLlmPlacements(placements, {
  todoistClient,
  tasks = [],
  fixedDurationLabel = 'fixed-duration',
  registryPath,
  logger,
}) {
  const { loadRegistry, writeRegistry } = await import('./registry.js');
  const taskLookup = new Map(tasks.map((task) => [String(task.id), task]));
  const results = [];
  const errors = [];

  for (const placement of placements) {
    const { task_id, due } = placement;
    if (!task_id || !due) {
      errors.push({ task_id, error: 'missing task_id or due' });
      continue;
    }
    const live = taskLookup.get(String(task_id));
    const requestedMinutes = Number(placement.duration_minutes);
    const writeDuration = live
      && Number.isFinite(requestedMinutes)
      && requestedMinutes > 0
      && shouldPersistDuration(live, { fixedDurationLabel });
    const payload = pickDefined({
      due_datetime: due,
      ...(writeDuration ? todoistDurationWriteFields(requestedMinutes) : {}),
    });
    try {
      await todoistClient.updateTaskDue(task_id, payload);
      results.push({
        task_id,
        due,
        duration_minutes: writeDuration ? Math.round(requestedMinutes) : null,
        status: 'applied',
      });
      logger?.info?.('llm placement applied', { taskId: task_id, due, durationWritten: writeDuration });
    } catch (error) {
      errors.push({ task_id, due, error: error.message });
      logger?.error?.('llm placement failed', { taskId: task_id, error: error.message });
    }
  }

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
