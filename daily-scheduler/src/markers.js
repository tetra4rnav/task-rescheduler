import { DESCRIPTION_MARKER_KEY, MANAGED_BY } from './constants.js';
import { sha256 } from './util.js';

export function buildIdempotencyKey({ taskId, start, end, plannerVersion }) {
  return sha256(`${taskId}|${start}|${end}|${plannerVersion}`);
}

export function buildManagedDescription(task, planItem, plannerVersion) {
  const lines = [
    `Todoist URL: ${task.url ?? ''}`,
    `Todoist Task ID: ${task.id}`,
    `Todoist Priority: ${task.priority}`,
    `Original Due: ${task.original_due ?? 'none'}`,
    `Duration Basis: ${planItem.duration_source}`,
    `Planner Version: ${plannerVersion}`,
    `${DESCRIPTION_MARKER_KEY}=${task.id}`,
  ];
  return lines.join('\n');
}

export function buildPrivateProperties(taskId, planDate, plannerVersion) {
  return {
    managedBy: MANAGED_BY,
    todoistTaskId: String(taskId),
    planDate,
    plannerVersion,
  };
}

export function extractManagedTaskId(event) {
  const privateProps = event?.extendedProperties?.private ?? event?.privateProperties ?? {};
  if (privateProps.todoistTaskId) return String(privateProps.todoistTaskId);
  const description = event?.description ?? '';
  const match = new RegExp(`${DESCRIPTION_MARKER_KEY}=([^\\s]+)`).exec(description);
  return match?.[1] ? String(match[1]) : null;
}

export function isManagedEvent(event) {
  const privateProps = event?.extendedProperties?.private ?? event?.privateProperties ?? {};
  if (privateProps.managedBy === MANAGED_BY) return true;
  return extractManagedTaskId(event) !== null;
}
