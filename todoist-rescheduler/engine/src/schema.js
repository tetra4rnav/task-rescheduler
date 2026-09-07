import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAN_STATUSES } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAN_SCHEMA_PATH = path.resolve(__dirname, '../schemas/plan.schema.json');

export function readSchema() {
  return JSON.parse(fs.readFileSync(PLAN_SCHEMA_PATH, 'utf8'));
}

function assertType(errors, condition, pathText, message) {
  if (!condition) errors.push(`${pathText}: ${message}`);
}

export function validatePlan(plan) {
  const errors = [];
  const requiredTopLevel = ['schema_version', 'run_id', 'generated_at', 'timezone', 'mode', 'inputs', 'scheduled', 'unscheduled', 'manual_review', 'operations', 'errors', 'warnings'];
  for (const key of requiredTopLevel) {
    assertType(errors, key in plan, key, 'is required');
  }
  assertType(errors, typeof plan.schema_version === 'string', 'schema_version', 'must be a string');
  assertType(errors, typeof plan.run_id === 'string', 'run_id', 'must be a string');
  assertType(errors, typeof plan.timezone === 'string', 'timezone', 'must be a string');
  assertType(errors, plan.mode === 'dry-run' || plan.mode === 'apply', 'mode', 'must be dry-run or apply');
  assertType(errors, plan.inputs && typeof plan.inputs === 'object', 'inputs', 'must be an object');
  assertType(errors, Array.isArray(plan.scheduled), 'scheduled', 'must be an array');
  assertType(errors, Array.isArray(plan.unscheduled), 'unscheduled', 'must be an array');
  assertType(errors, Array.isArray(plan.manual_review), 'manual_review', 'must be an array');
  assertType(errors, Array.isArray(plan.errors), 'errors', 'must be an array');
  assertType(errors, Array.isArray(plan.warnings), 'warnings', 'must be an array');

  for (const [index, item] of (plan.scheduled ?? []).entries()) {
    const base = `scheduled[${index}]`;
    for (const key of ['task_id', 'title', 'duration_source', 'start', 'end', 'scheduled_start', 'assignment_source', 'planner_version', 'idempotency_key']) {
      assertType(errors, typeof item[key] === 'string', `${base}.${key}`, 'must be a string');
    }
    assertType(errors, Number.isFinite(item.duration_minutes), `${base}.duration_minutes`, 'must be numeric');
    assertType(errors, item.deadline_at === null || typeof item.deadline_at === 'string', `${base}.deadline_at`, 'must be null or a string');
    assertType(errors, Number.isFinite(item.score), `${base}.score`, 'must be numeric');
    assertType(errors, typeof item.score_breakdown === 'object' && item.score_breakdown !== null, `${base}.score_breakdown`, 'must be an object');
    assertType(errors, Array.isArray(item.reason_codes), `${base}.reason_codes`, 'must be an array');
  }

  for (const [index, item] of (plan.unscheduled ?? []).entries()) {
    const base = `unscheduled[${index}]`;
    assertType(errors, typeof item.task_id === 'string', `${base}.task_id`, 'must be a string');
    assertType(errors, typeof item.reason_code === 'string', `${base}.reason_code`, 'must be a string');
  }

  for (const [index, item] of (plan.manual_review ?? []).entries()) {
    const base = `manual_review[${index}]`;
    assertType(errors, typeof item.task_id === 'string', `${base}.task_id`, 'must be a string');
    assertType(errors, typeof item.reason_code === 'string', `${base}.reason_code`, 'must be a string');
  }

  const operationBuckets = ['calendar_create', 'calendar_update', 'calendar_noop', 'calendar_stale', 'todoist_due_update'];
  for (const bucket of operationBuckets) {
    assertType(errors, Array.isArray(plan.operations?.[bucket]), `operations.${bucket}`, 'must be an array');
    for (const [index, item] of (plan.operations?.[bucket] ?? []).entries()) {
      assertType(errors, PLAN_STATUSES.includes(item.status), `operations.${bucket}[${index}].status`, 'must be a known status');
    }
  }

  return { valid: errors.length === 0, errors };
}
