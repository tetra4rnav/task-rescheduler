#!/usr/bin/env node
/*
 * rescheduler/run.js — deterministic 5-stage Todoist rescheduler orchestrator.
 *
 * Stages 1, 2, 3 are owned by this binary.
 * Stages 4 (memory) and 5 (report) are handled by the cron payload.
 *
 * All work is deterministic, no LLM.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const WORKSPACE = path.resolve(__dirname, '..', '..');
const SCHEDULER = path.join(WORKSPACE, 'scripts', 'daily-scheduler', 'bin', 'daily-scheduler.js');
const ARTIFACT_ROOT = process.env.RESCHEDULER_ARTIFACT_DIR || '/tmp/rescheduler';

const DEFAULT_TZ = 'America/New_York';
const DEFAULT_DAYS = 3;
const DEFAULT_WORKING_HOURS = '09:00-18:00';
const DEFAULT_MAX_DAILY = 360;
const DEFAULT_MIN_BREAK = 15;

function parseArgs(argv) {
  const opts = {
    timezone: DEFAULT_TZ,
    days: DEFAULT_DAYS,
    account: 'your-email-at-provider.example',
    calendars: ['primary'],
    workingHours: DEFAULT_WORKING_HOURS,
    maxDailyMinutes: DEFAULT_MAX_DAILY,
    minBreakMinutes: DEFAULT_MIN_BREAK,
    dryRun: false,
    apply: false,
    noCalendar: false,
    compact: false,
    overridesFile: null,
    runId: null,
  };
  const list = argv.slice();
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a === '--timezone') { opts.timezone = list[++i]; }
    else if (a === '--days') { opts.days = Number(list[++i]); }
    else if (a === '--account') { opts.account = list[++i]; }
    else if (a === '--calendar') { opts.calendars = list[++i].split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a === '--working-hours') { opts.workingHours = list[++i]; }
    else if (a === '--max-daily-minutes') { opts.maxDailyMinutes = Number(list[++i]); }
    else if (a === '--min-break-minutes') { opts.minBreakMinutes = Number(list[++i]); }
    else if (a === '--dry-run') { opts.dryRun = true; }
    else if (a === '--apply') { opts.apply = true; }
    else if (a === '--no-calendar') { opts.noCalendar = true; }
    else if (a === '--compact') { opts.compact = true; }
    else if (a === '--overrides') { opts.overridesFile = list[++i]; }
    else if (a === '--run-id') { opts.runId = list[++i]; }
    else if (a === '--json') { /* ignore */ }
    else { throw new Error(`Unknown argument: ${a}`); }
  }
  if (!opts.apply && !opts.dryRun) opts.apply = true; // default: apply
  return opts;
}

function runScheduler(args) {
  try {
    const stdout = execFileSync('node', [SCHEDULER].concat(args), {
      encoding: 'utf8', cwd: WORKSPACE, stdio: ['inherit', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout).trim(), stderr: '' };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || '').trim(),
      status: error.status,
      message: error.message,
    };
  }
}

function baseFlags(opts) {
  const flags = [
    '--timezone', opts.timezone,
    '--days', String(opts.days),
    '--account', opts.account,
    '--calendar', opts.calendars.join(','),
    '--working-hours', opts.workingHours,
    '--max-daily-minutes', String(opts.maxDailyMinutes),
    '--min-break-minutes', String(opts.minBreakMinutes),
    '--json',
  ];
  if (opts.noCalendar) flags.push('--no-calendar');
  if (opts.overridesFile) flags.push('--overrides', opts.overridesFile);
  return flags;
}

function makeRunId() {
  const now = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
  const r = Math.random().toString(36).slice(2, 8);
  return `${now}-${r}`;
}

function run_(argv) {
  const opts = parseArgs(argv);
  if (!opts.runId) opts.runId = makeRunId();
  const outDir = path.join(ARTIFACT_ROOT, opts.runId);
  fs.mkdirSync(outDir, { recursive: true });

  const result = {
    run_id: opts.runId,
    mode: opts.apply && !opts.dryRun ? 'apply' : 'plan-only',
    no_calendar: opts.noCalendar,
  };

  // ---- Stage 1: Todoist fetch  +  Stage 2: Calendar fetch (optional) ----
  const planArgs = ['plan', '--todoist-only'].concat(baseFlags(opts));
  const planRun = runScheduler(planArgs);

  if (!planRun.ok) {
    result.stage1 = { ok: false, code: 'FETCH', message: planRun.message, stderr: planRun.stderr };
    result.ok = false;
    fs.writeFileSync(path.join(outDir, 'fetch.jsonl'), JSON.stringify(result) + '\n');
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return { exitCode: 1, result };
  }

  let plan;
  try {
    plan = JSON.parse(planRun.stdout);
  } catch (e) {
    result.stage1 = { ok: false, code: 'FETCH_PARSE', message: String(e.message), stdout_head: planRun.stdout.slice(0, 800) };
    result.ok = false;
    fs.writeFileSync(path.join(outDir, 'fetch.jsonl'), JSON.stringify(result) + '\n');
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return { exitCode: 1, result };
  }

  result.stage1 = {
    ok: true,
    todoist_task_count: plan.inputs ? plan.inputs.todoist_task_count : null,
    calendar_event_count: plan.inputs ? plan.inputs.calendar_event_count : null,
    calendar_source: opts.noCalendar ? 'skipped' : 'live',
  };

  // Persist fetched plan to artifact (will be used by Stage 3 apply).
  fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(outDir, 'fetch.jsonl'), JSON.stringify({ stage: '1+2_fetch', ok: true, calendar_source: result.stage1.calendar_source, tasks: result.stage1.todoist_task_count, events: result.stage1.calendar_event_count }) + '\n');

  // ---- Stage 3: reschedule ----
  if (opts.dryRun || !opts.apply) {
    result.stage3 = { ok: true, mode: 'plan-only', applied_operations: 0, changed_operations: 0 };
  } else {
    const planFile = path.join(outDir, 'plan.json');
    const applyArgs = ['apply', '--todoist-only'].concat(baseFlags(opts)).concat(['--plan-file', planFile]);
    const applyRun = runScheduler(applyArgs);

    if (!applyRun.ok) {
      result.stage3 = { ok: false, code: 'APPLY', message: applyRun.message, stderr: applyRun.stderr, stdout_head: applyRun.stdout.slice(0, 800) };
      result.ok = false;
      fs.writeFileSync(path.join(outDir, 'reschedule.jsonl'), JSON.stringify({ stage: '3_reschedule', ok: false, error: result.stage3 }) + '\n');
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return { exitCode: 1, result };
    }

    let applied;
    try {
      applied = JSON.parse(applyRun.stdout);
    } catch (e) {
      result.stage3 = { ok: false, code: 'APPLY_PARSE', message: String(e.message), stdout_head: applyRun.stdout.slice(0, 800) };
      result.ok = false;
      fs.writeFileSync(path.join(outDir, 'reschedule.jsonl'), JSON.stringify({ stage: '3_reschedule', ok: false, error: result.stage3 }) + '\n');
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return { exitCode: 1, result };
    }

    const ops = (applied.operations && applied.operations.todoist_due_update) || [];
    const changed = ops.filter((o) => o.status && o.status !== 'noop');
    const drift = (applied.verification && applied.verification.mismatches) || [];
    result.stage3 = {
      ok: true,
      mode: 'applied',
      applied_operations: ops.length,
      changed_operations: changed.length,
      drift_count: drift.length,
    };
    fs.writeFileSync(path.join(outDir, 'reschedule.jsonl'), JSON.stringify({ stage: '3_reschedule', ok: true, applied: ops.length, changed: changed.length, drift: drift.length }) + '\n');
    fs.writeFileSync(path.join(outDir, 'applied.json'), JSON.stringify({ changed_tasks: changed.map((o) => ({ task_id: o.task_id, desired_due: o.desired_due, status: o.status })), drift }, null, 2));
  }

  // Summary from fetched plan
  result.scheduled_count = (plan.scheduled || []).length;
  result.unscheduled_count = (plan.unscheduled || []).length;
  result.manual_review_count = (plan.manual_review || []).length;
  result.warnings_count = (plan.warnings || []).length;
  result.errors_count = (plan.errors || []).length;
  result.ok = true;

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return { exitCode: 0, result };
}

module.exports = { run: run_, parseArgs };

if (require.main === module) {
  const { exitCode } = run_(process.argv.slice(2));
  process.exitCode = exitCode;
}