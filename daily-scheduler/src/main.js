#!/usr/bin/env node
import fs from 'node:fs/promises';
import { applyPlan } from './apply.js';
import { GoogleCalendarClient, loadCalendarFixture } from './calendar.js';
import { parseCli, helpText } from './config.js';
import { EXIT_CODES, MANAGED_BY } from './constants.js';
import { AuthError, InputError, SchedulerError } from './errors.js';
import { formatReport } from './formatter.js';
import { createLogger } from './logger.js';
import { buildPlan } from './planner.js';
import { applyDeadlineMigrationPlan, buildDeadlineMigrationPlan, verifyDeadlineMigrationPlan } from './migration.js';
import { normalizeCalendarEvent, normalizeTodoistTask } from './normalize.js';
import { validatePlan } from './schema.js';
import { addDaysToDateString, endOfDay, formatRfc3339InTimeZone, startOfDay } from './time.js';
import { TodoistClient, loadTodoistFixture } from './todoist.js';
import { isoNow, randomRunId } from './util.js';
import { verifyPlan } from './verify.js';

function summarizeVerificationPlan(plan) {
  return [
    ...plan.operations.calendar_create,
    ...plan.operations.calendar_update,
    ...plan.operations.todoist_due_update.filter((operation) => operation.status !== 'noop'),
  ];
}

async function loadState(options, logger) {
  const todoistClient = new TodoistClient({ logger });
  // Reads Google Calendar availability via google_api.py (formerly `gog`).
  // Calendar WRITE (create/update/delete) is intentionally removed.
  const calendarClient = new GoogleCalendarClient({ logger });
  const todoistRawTasks = options.todoistFile ? await loadTodoistFixture(options.todoistFile) : await todoistClient.listIncompleteTasks();
  const projectIndex = new Map();
  if (!options.todoistFile) {
    for (const project of await todoistClient.listProjects()) {
      projectIndex.set(String(project.id), project.name ?? String(project.id));
    }
  }
  const tasks = todoistRawTasks.map((task) => normalizeTodoistTask(task, {
    projectNames: projectIndex,
    excludedProjectIds: options.config.excludedProjectIds,
    excludedProjectNames: options.config.excludedProjectNames,
    excludedLabels: options.config.excludedLabels,
    requireAutoScheduleLabel: options.config.requireAutoScheduleLabel,
    autoScheduleLabel: options.config.autoScheduleLabel,
    assignmentMarkerLabel: options.config.assignmentMarkerLabel,
    plannerVersionLabelPrefix: options.config.plannerVersionLabelPrefix,
  }));

  const from = formatRfc3339InTimeZone(startOfDay(options.date, options.timezone), options.timezone);
  const lastDate = addDaysToDateString(options.date, options.days - 1);
  const to = formatRfc3339InTimeZone(endOfDay(lastDate, options.timezone), options.timezone);
  let calendarRawEvents;
  let calendarSource;
  if (options.calendarFile) {
    calendarRawEvents = await loadCalendarFixture(options.calendarFile);
    calendarSource = 'fixture';
  } else if (options.noCalendar) {
    calendarRawEvents = [];
    calendarSource = 'skipped';
    logger?.warn?.('Calendar fetch skipped (--no-calendar)');
  } else {
    calendarRawEvents = await calendarClient.listEvents({
      calendarIds: options.calendars,
      from,
      to,
      managedBy: undefined,
    });
    calendarSource = 'live';
  }
  const calendarEvents = calendarRawEvents.map((event) => normalizeCalendarEvent(event, {
    calendarId: event.calendarId ?? options.calendars[0],
    timezone: options.timezone,
  }));

  return { tasks, calendarEvents, todoistClient, calendarClient };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function attachEventRfc3339(events, timezone) {
  return events.map((event) => ({
    ...event,
    startRfc3339: formatRfc3339InTimeZone(event.start, timezone),
    endRfc3339: formatRfc3339InTimeZone(event.end, timezone),
  }));
}

export async function run(argv = process.argv.slice(2), dependencies = {}) {
  const provisionalRunId = randomRunId();
  const options = await parseCli(argv, { now: dependencies.now ?? new Date() });
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return { exitCode: EXIT_CODES.SUCCESS, output: null };
  }
  const logger = createLogger({ runId: provisionalRunId, verbose: options.verbose, stderr: dependencies.stderr ?? process.stderr });
  const generatedAt = isoNow(new Date(options.now ?? dependencies.now ?? new Date()));
  const state = await loadState(options, logger);

  if (options.command === 'dump') {
    const tasksWithDesc = state.tasks
      .filter(t => t.description || t.content)
      .map(t => ({
        id: t.id,
        content: t.content,
        description: t.description,
        priority: t.priority,
        due_date: t.due ? (t.due.date || t.due.datetime) : null
      }));
    process.stdout.write(JSON.stringify(tasksWithDesc, null, 2) + '\n');
    return { exitCode: EXIT_CODES.SUCCESS, output: tasksWithDesc };
  }

  if (options.command === 'migrate-deadlines') {
    if (options.mode !== 'apply') {
      const migrationPlan = buildDeadlineMigrationPlan({
        tasks: state.tasks,
        options,
        runId: provisionalRunId,
        generatedAt,
      });
      printJson(migrationPlan);
      return { exitCode: EXIT_CODES.SUCCESS, output: migrationPlan };
    }

    const approvedPlan = JSON.parse(await fs.readFile(options.planFile, 'utf8'));
    const appliedMigration = await applyDeadlineMigrationPlan(approvedPlan, {
      tasks: state.tasks,
      todoistClient: state.todoistClient,
    });
    const reloaded = await loadState(options, logger);
    const verifiedMigration = verifyDeadlineMigrationPlan(appliedMigration, reloaded.tasks);
    printJson(verifiedMigration);
    return { exitCode: EXIT_CODES.SUCCESS, output: verifiedMigration };
  }

  const plan = buildPlan({
    tasks: state.tasks,
    calendarEvents: state.calendarEvents,
    options,
    runId: provisionalRunId,
    generatedAt,
  });
  const validation = validatePlan(plan);
  if (!validation.valid) {
    throw new SchedulerError('Plan schema validation failed', { code: EXIT_CODES.PLAN, meta: validation.errors });
  }

  if (options.command === 'plan' || (options.command === 'run' && options.mode === 'dry-run')) {
    printJson(plan);
    return { exitCode: EXIT_CODES.SUCCESS, output: plan };
  }

  if (options.command === 'verify' && options.planFile) {
    const existingPlan = JSON.parse(await fs.readFile(options.planFile, 'utf8'));
    const verifyResult = verifyPlan(existingPlan, {
      calendarEvents: attachEventRfc3339(state.calendarEvents, options.timezone),
      tasks: state.tasks,
      verifyCalendar: !existingPlan.todoist_only,
    });
    printJson({ ...verifyResult.plan, verification: { ok: verifyResult.ok, mismatches: verifyResult.mismatches } });
    return { exitCode: verifyResult.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.VERIFY_MISMATCH, output: verifyResult.plan };
  }

  if (options.command === 'verify') {
    const pending = summarizeVerificationPlan(plan).filter((operation) => operation.status !== 'noop');
    const verificationReport = {
      ...plan,
      verification: {
        ok: pending.length === 0,
        mismatches: pending.map((operation) => ({ task_id: operation.task_id, reason: 'PENDING_OPERATION', operation: operation.status })),
      },
    };
    printJson(verificationReport);
    return { exitCode: pending.length === 0 ? EXIT_CODES.SUCCESS : EXIT_CODES.VERIFY_MISMATCH, output: verificationReport };
  }

  if (options.mode !== 'apply') {
    printJson(plan);
    return { exitCode: EXIT_CODES.SUCCESS, output: plan };
  }

  const appliedPlan = await applyPlan(plan, {
    calendarClient: state.calendarClient,
    todoistClient: state.todoistClient,
    options,
    logger,
    reloadState: async () => {
      const reloaded = await loadState(options, logger);
      return reloaded;
    },
  });
  
  let outputReport = '';
  if (options.json) {
    printJson(appliedPlan);
  } else {
    outputReport = formatReport(appliedPlan);
    process.stdout.write(`${outputReport}\n`);
  }
  return { exitCode: EXIT_CODES.SUCCESS, output: appliedPlan, report: outputReport };
}

export async function main() {
  try {
    const { exitCode } = await run();
    process.exitCode = exitCode;
  } catch (error) {
    const code = error instanceof SchedulerError ? error.code : EXIT_CODES.API;
    const payload = error?.meta?.plan ?? {
      schema_version: '1.1',
      run_id: 'failed',
      generated_at: isoNow(),
      timezone: 'UTC',
      mode: 'dry-run',
      todoist_only: false,
      inputs: { todoist_task_count: 0, calendar_event_count: 0, window: { start: null, days: 0, calendars: [] } },
      scheduled: [],
      unscheduled: [],
      manual_review: [],
      operations: { calendar_create: [], calendar_update: [], calendar_noop: [], calendar_stale: [], todoist_due_update: [] },
      errors: [],
      warnings: [],
    };
    payload.errors = [
      ...(payload.errors ?? []),
      { code: error.name ?? 'Error', message: error.message, meta: error.meta ?? null },
    ];
    printJson(payload);
    process.exitCode = code;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
