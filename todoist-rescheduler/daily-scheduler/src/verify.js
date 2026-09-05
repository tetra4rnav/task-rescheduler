import { groupBy } from './util.js';

function eventMatchesOperation(event, operation) {
  const privateProps = event.privateProperties ?? {};
  return operation.start === event.startRfc3339
    && operation.end === event.endRfc3339
    && operation.desired_summary === (event.summary ?? '')
    && operation.desired_description.trim() === (event.description ?? '').trim()
    && Object.entries(operation.desired_private_properties ?? {}).every(([key, value]) => String(privateProps[key] ?? '') === String(value));
}

export function verifyPlan(plan, { calendarEvents = [], tasks = [], verifyCalendar = true, verifyTodoist = true } = {}) {
  const mismatches = [];
  const eventsByTaskId = groupBy(calendarEvents.filter((event) => event.managedTaskId), (event) => event.managedTaskId);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const verifiedPlan = structuredClone(plan);

  if (verifyCalendar) {
    for (const bucket of ['calendar_create', 'calendar_update', 'calendar_noop']) {
      for (const operation of verifiedPlan.operations[bucket]) {
        if (operation.status === 'failed' || operation.status === 'skipped') continue;
        const candidates = [...(eventsByTaskId.get(operation.task_id) ?? [])];
        const match = candidates.find((event) => operation.event_id ? event.id === operation.event_id : true) ?? candidates[0];
        if (!match) {
          mismatches.push({ type: 'calendar', task_id: operation.task_id, reason: 'EVENT_NOT_FOUND' });
          operation.status = 'failed';
          continue;
        }
        if (!eventMatchesOperation(match, operation)) {
          mismatches.push({ type: 'calendar', task_id: operation.task_id, event_id: match.id, reason: 'EVENT_MISMATCH' });
          operation.status = 'failed';
          continue;
        }
        operation.status = bucket === 'calendar_noop' ? 'noop' : 'verified';
      }
    }
  }

  if (verifyTodoist) {
    for (const operation of verifiedPlan.operations.todoist_due_update) {
      if (operation.status === 'noop' || operation.status === 'skipped' || operation.status === 'failed') continue;
      const task = tasksById.get(operation.task_id);
      if (!task) {
        mismatches.push({ type: 'todoist', task_id: operation.task_id, reason: 'TASK_NOT_FOUND' });
        operation.status = 'failed';
        continue;
      }
      if (task.due.datetime !== operation.desired_due) {
        mismatches.push({ type: 'todoist', task_id: operation.task_id, reason: 'DUE_MISMATCH' });
        operation.status = 'failed';
        continue;
      }
      const actualLabels = [...task.labels].sort();
      const desiredLabels = [...(operation.desired_labels ?? [])].sort();
      if (JSON.stringify(actualLabels) !== JSON.stringify(desiredLabels)) {
        mismatches.push({ type: 'todoist', task_id: operation.task_id, reason: 'LABEL_MISMATCH' });
        operation.status = 'failed';
        continue;
      }
      operation.status = 'verified';
    }
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
    plan: verifiedPlan,
  };
}
