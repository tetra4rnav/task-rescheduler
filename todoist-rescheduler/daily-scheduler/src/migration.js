import { PLAN_SCHEMA_VERSION, PLANNER_VERSION } from './constants.js';
import { ApplyPartialError, InputError, VerifyError } from './errors.js';
import { isoNow } from './util.js';

function isDateOnlyDue(task) {
  return Boolean(task.due.date && !task.due.datetime && !task.due.is_recurring);
}

export function buildDeadlineMigrationPlan({ tasks, runId, generatedAt = isoNow(), options }) {
  const operations = tasks
    .filter((task) => !task.excluded && isDateOnlyDue(task))
    .map((task) => ({
      status: 'planned',
      task_id: task.id,
      title: task.content,
      previous_due_date: task.due.date,
      previous_deadline_at: task.deadline_at,
      desired_deadline_at: task.deadline_at ?? task.due.date,
      clear_due: true,
      assignment_source: null,
      planner_version: options.plannerVersion ?? PLANNER_VERSION,
    }));

  return {
    schema_version: PLAN_SCHEMA_VERSION,
    migration_type: 'date_only_due_to_deadline',
    run_id: runId,
    generated_at: generatedAt,
    mode: options.mode,
    approval_required: true,
    operations,
    errors: [],
    warnings: operations.length > 0 ? [{
      code: 'DEADLINE_MIGRATION_REQUIRES_APPROVAL',
      message: 'No Todoist changes occur unless this exact saved plan is applied with explicit approval.',
      count: operations.length,
    }] : [],
  };
}

export function validateDeadlineMigrationPlan(plan) {
  if (plan?.migration_type !== 'date_only_due_to_deadline' || !Array.isArray(plan.operations)) {
    throw new InputError('Invalid deadline migration plan');
  }
  for (const operation of plan.operations) {
    if (!operation.task_id || !/^\d{4}-\d{2}-\d{2}$/.test(operation.desired_deadline_at ?? '')) {
      throw new InputError('Invalid deadline migration operation', { operation });
    }
  }
}

export async function applyDeadlineMigrationPlan(plan, { tasks, todoistClient }) {
  validateDeadlineMigrationPlan(plan);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const applied = structuredClone(plan);
  applied.mode = 'apply';

  for (const operation of applied.operations) {
    const task = tasksById.get(operation.task_id);
    if (!task || task.excluded || !isDateOnlyDue(task)) {
      operation.status = 'failed';
      operation.error = 'SOURCE_STATE_MISMATCH';
      applied.errors.push({ code: 'SOURCE_STATE_MISMATCH', task_id: operation.task_id });
      continue;
    }
    if (task.due.date !== operation.previous_due_date || task.deadline_at !== operation.previous_deadline_at) {
      operation.status = 'failed';
      operation.error = 'SOURCE_STATE_DRIFT';
      applied.errors.push({ code: 'SOURCE_STATE_DRIFT', task_id: operation.task_id });
      continue;
    }
    try {
      await todoistClient.updateTask(operation.task_id, {
        deadline_date: operation.desired_deadline_at,
        due_string: 'no date',
      });
      operation.status = 'applied';
    } catch (error) {
      operation.status = 'failed';
      operation.error = error.message;
      applied.errors.push({ code: 'DEADLINE_MIGRATION_FAILED', task_id: operation.task_id, message: error.message });
    }
  }

  if (applied.operations.some((operation) => operation.status === 'failed')) {
    throw new ApplyPartialError('Deadline migration completed with partial failures', { plan: applied });
  }
  return applied;
}

export function verifyDeadlineMigrationPlan(plan, tasks) {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const verified = structuredClone(plan);
  const mismatches = [];
  for (const operation of verified.operations) {
    const task = tasksById.get(operation.task_id);
    if (!task || task.due.date || task.due.datetime || task.deadline_at !== operation.desired_deadline_at) {
      operation.status = 'failed';
      mismatches.push({ task_id: operation.task_id, reason: 'MIGRATION_VERIFY_MISMATCH' });
    } else {
      operation.status = 'verified';
    }
  }
  if (mismatches.length > 0) {
    throw new VerifyError('Deadline migration verification mismatch', { plan: verified, mismatches });
  }
  return verified;
}
