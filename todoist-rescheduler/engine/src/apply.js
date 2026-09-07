import { todoistDurationWriteFields } from './duration.js';
import { ApplyPartialError, StateDriftError, VerifyError } from './errors.js';
import { formatRfc3339InTimeZone } from './time.js';
import { pickDefined } from './util.js';
import { verifyPlan } from './verify.js';

// Calendar is read-only. Writes are Todoist due_datetime and, when empty and
// not fixed, duration. Labels are never written.

async function applyTodoistDueOperations(plan, { todoistClient, options, taskLookup, logger }) {
  if (!options.syncTodoistDue && !options.todoistOnly) return;
  for (const operation of plan.operations.todoist_due_update) {
    if (operation.status === 'noop' || operation.status === 'skipped') continue;
    const task = taskLookup.get(operation.task_id);
    if (!task || task.due.is_recurring) {
      operation.status = 'skipped';
      continue;
    }
    try {
      await todoistClient.updateTaskDue(operation.task_id, pickDefined({
        due_datetime: operation.desired_due,
        ...todoistDurationWriteFields(operation.desired_duration_minutes),
      }));
      operation.status = 'applied';
      logger?.info?.('todoist due updated', { taskId: operation.task_id });
    } catch (error) {
      operation.status = 'failed';
      operation.error = error.message;
      plan.errors.push({ code: 'TODOIST_DUE_UPDATE_FAILED', message: error.message, task_id: operation.task_id });
    }
  }
}

export async function applyPlan(approvedPlan, {
  // NOTE: calendarClient was removed (2026-09-05) — calendar is read-only.
  todoistClient,
  reloadState,
  options,
  logger,
}) {
  if (approvedPlan.mode === 'dry-run') {
    throw new ApplyPartialError('Cannot apply a plan generated with mode: dry-run; regenerate with command: apply / run --apply');
  }

  const freshState = await reloadState();
  const { sha256 } = await import('./util.js');
  // options.now must match original generation for testing/drift check otherwise time elapsed alters scores or windows
  const deterministicOptions = { ...options, now: approvedPlan.generated_at };
  
  const freshPlan = await (await import('./planner.js')).buildPlan({
    tasks: freshState.tasks,
    calendarEvents: freshState.calendarEvents,
    options: deterministicOptions,
    runId: approvedPlan.run_id,
    generatedAt: approvedPlan.generated_at,
  });

  if (freshPlan.state_hash !== approvedPlan.state_hash) {
    throw new StateDriftError(`State drift detected: the current live state produces hash ${freshPlan.state_hash}, which differs from the approved plan ${approvedPlan.state_hash}. Regenerate the plan.`);
  }

  const mutablePlan = structuredClone(approvedPlan);
  let workingPlan = mutablePlan;

  // NOTE: Calendar WRITE is removed. No calendar_create/update operations are
  // ever applied. Calendar events are read-only input for availability.

  const stateBeforeTodoist = await reloadState();
  const taskLookup = new Map(stateBeforeTodoist.tasks.map((task) => [task.id, task]));
  await applyTodoistDueOperations(workingPlan, { todoistClient, options, taskLookup, logger });

  const stateAfterTodoist = await reloadState();
  const verified = verifyPlan(workingPlan, {
    calendarEvents: stateAfterTodoist.calendarEvents.map((event) => ({
      ...event,
      startRfc3339: formatRfc3339InTimeZone(event.start, options.timezone),
      endRfc3339: formatRfc3339InTimeZone(event.end, options.timezone),
    })),
    tasks: stateAfterTodoist.tasks,
    verifyCalendar: false,
  });

  if (!verified.ok) {
    throw new VerifyError('Verification mismatch after apply', { plan: verified.plan, mismatches: verified.mismatches });
  }

  const failedOperations = [
    ...verified.plan.operations.calendar_create,
    ...verified.plan.operations.calendar_update,
    ...verified.plan.operations.todoist_due_update,
  ].filter((operation) => operation.status === 'failed');

  if (failedOperations.length > 0) {
    throw new ApplyPartialError('Apply completed with partial failures', { plan: verified.plan, failedOperations });
  }

  return verified.plan;
}
