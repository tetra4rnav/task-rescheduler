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
// when the live task has no Todoist duration, is not recurring, and does not
// carry the POLICY fixed_duration label.
//
// Writes are two-step: due_datetime alone first, then duration in a separate
// request. Todoist rejects an inline duration object on many tasks
// (ITEM_DURATION_INVALID / 546); keeping due first means a duration 400 cannot
// block the placement or leave the registry in a mixed rescheduled state.
// Error records include the Todoist body/meta, not only error.message.

import fs from 'node:fs/promises';
import { shouldPersistDuration, todoistDurationWriteFields } from './duration.js';
import { pickDefined } from './util.js';

export function describeTodoistError(error) {
  const meta = error?.meta ?? {};
  const body = meta.body ?? null;
  const objectBody = body && typeof body === 'object' ? body : null;
  const errorTag = objectBody?.error_tag ?? null;
  const errorCode = objectBody?.error_code ?? null;
  const detail = objectBody?.error ?? (typeof body === 'string' ? body : null);
  const extras = [
    errorTag,
    errorCode != null ? `error_code ${errorCode}` : null,
    detail,
  ].filter(Boolean);
  const base = error?.message ?? String(error);
  return {
    message: extras.length ? `${base}: ${extras.join(' / ')}` : String(base),
    status: meta.status ?? null,
    error_code: errorCode,
    error_tag: errorTag,
    body,
  };
}

export function isItemDurationInvalid(error) {
  const described = describeTodoistError(error);
  return described.error_code === 546 || described.error_tag === 'ITEM_DURATION_INVALID';
}

function errorRecord({ task_id, due, step, error, recovered = false }) {
  const described = describeTodoistError(error);
  return pickDefined({
    task_id,
    due,
    step,
    error: described.message,
    status: described.status,
    error_code: described.error_code,
    error_tag: described.error_tag,
    body: described.body,
    recovered: recovered || undefined,
  });
}

function logPlacementError(logger, record) {
  logger?.error?.('llm placement failed', {
    taskId: record.task_id,
    step: record.step,
    error: record.error,
    status: record.status,
    error_code: record.error_code,
    error_tag: record.error_tag,
    body: record.body,
    recovered: Boolean(record.recovered),
  });
}

function wantsDurationWrite(placement, live, fixedDurationLabel) {
  const requestedMinutes = Number(placement.duration_minutes);
  if (!live) return false;
  if (!Number.isFinite(requestedMinutes) || requestedMinutes <= 0) return false;
  if (live.due?.is_recurring) return false;
  return shouldPersistDuration(live, { fixedDurationLabel });
}

async function writeDueDatetime(todoistClient, task_id, due) {
  await todoistClient.updateTaskDue(task_id, { due_datetime: due });
}

async function applyDueDatetime(todoistClient, task_id, due) {
  try {
    await writeDueDatetime(todoistClient, task_id, due);
    return { ok: true };
  } catch (error) {
    if (!isItemDurationInvalid(error)) return { ok: false, error };
    // Recovery for a duration-tainted due write (or a 546 on due): retry due-only.
    try {
      await writeDueDatetime(todoistClient, task_id, due);
      return { ok: true, recoveredFromDuration: true, error };
    } catch (retryError) {
      return { ok: false, error: retryError };
    }
  }
}

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
    const writeDuration = wantsDurationWrite(placement, live, fixedDurationLabel);

    const dueResult = await applyDueDatetime(todoistClient, task_id, due);
    if (!dueResult.ok) {
      const record = errorRecord({ task_id, due, step: 'due', error: dueResult.error });
      errors.push(record);
      logPlacementError(logger, record);
      continue;
    }
    if (dueResult.recoveredFromDuration) {
      const record = errorRecord({
        task_id,
        due,
        step: 'due',
        error: dueResult.error,
        recovered: true,
      });
      errors.push(record);
      logPlacementError(logger, record);
    }

    let durationWritten = false;
    if (writeDuration) {
      try {
        await todoistClient.updateTaskDue(task_id, todoistDurationWriteFields(requestedMinutes));
        durationWritten = true;
      } catch (error) {
        const recovered = true;
        const record = errorRecord({ task_id, due, step: 'duration', error, recovered });
        errors.push(record);
        logPlacementError(logger, record);
      }
    }

    results.push({
      task_id,
      due,
      duration_minutes: durationWritten ? Math.round(requestedMinutes) : null,
      status: 'applied',
    });
    logger?.info?.('llm placement applied', {
      taskId: task_id,
      due,
      durationWritten,
      recoveredFromDuration: Boolean(dueResult.recoveredFromDuration),
    });
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
