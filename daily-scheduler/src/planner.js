import { buildPlanningWindow, buildBusyIntervals, findSlot, registerScheduledInterval } from './availability.js';
import { PLAN_SCHEMA_VERSION, PLANNER_VERSION } from './constants.js';
import { estimateDuration } from './duration.js';
import { buildIdempotencyKey } from './markers.js';
import { classifyTaskTarget, isBusyCalendarEvent, taskDeadline } from './normalize.js';
import { computeTaskScore, compareTaskPriority } from './priority.js';
import { addDaysToDateString, formatDateInTimeZone, formatRfc3339InTimeZone, toUtcRfc3339 } from './time.js';
import { compareStrings, groupBy, isoNow, stableSort, sha256 } from './util.js';

function sortEventsByStart(left, right) {
  return left.start - right.start || left.end - right.end || compareStrings(left.id, right.id);
}

function buildTodoistDueOperation(task, scheduledItem, options) {
  const desiredDue = toUtcRfc3339(scheduledItem.start);
  const currentDue = toUtcRfc3339(task.due.datetime);
  const status = currentDue === desiredDue ? 'noop' : 'planned';
  return {
    status,
    task_id: task.id,
    previous_due: task.original_due,
    desired_due: desiredDue,
    scheduled_start: scheduledItem.start,
    desired_timezone: options.timezone,
    recurring: task.due.is_recurring,
    previous_labels: task.labels,
    desired_labels: [...new Set([
      ...task.labels.filter((label) => !label.startsWith(options.config.plannerVersionLabelPrefix)),
      options.config.assignmentMarkerLabel,
      `${options.config.plannerVersionLabelPrefix}${(options.plannerVersion ?? PLANNER_VERSION).replaceAll('.', '-')}`,
    ])].sort(),
    assignment_source: 'task-rescheduler',
    planner_version: options.plannerVersion ?? PLANNER_VERSION,
  };
}

export function buildPlan({ tasks, calendarEvents, options, runId, generatedAt = isoNow() }) {
  const now = new Date(options.now ?? generatedAt);
  // managesCalendar controls whether the task's OWN previously-managed calendar
  // events are excluded from the busy set (so a task isn't blocked by its own
  // past placement). Calendar WRITE (create/update/delete) is removed
  // (2026-09-05); this flag only affects availability parsing now.
  const managesCalendar = !options.todoistOnly;
  const warnings = [];
  const errors = [];
  const targetTasks = [];
  const manualReview = [];
  const deferred = [];

  // Apply overrides if any
  const overrides = options.overrides ?? {};
  for (const task of tasks) {
    if (overrides[task.id]) {
      const override = overrides[task.id];
      if (override.priority !== undefined) task.priority = override.priority;
      if (override.duration_minutes !== undefined) {
        task.duration = { amount: override.duration_minutes, unit: 'minute' };
      }
      if (override.deadline_at !== undefined) task.deadline_at = override.deadline_at;
      if (override.due_date !== undefined) task.due = { ...task.due, date: override.due_date };
      if (override.due_datetime !== undefined) task.due = { ...task.due, datetime: override.due_datetime };
      if (override.earliest_start_time !== undefined) task.overridden_earliest_start_time = override.earliest_start_time;
      if (override.fixed_start_time !== undefined) task.overridden_fixed_start_time = override.fixed_start_time;
    }
  }

  for (const task of tasks) {
    const classification = classifyTaskTarget(task, {
      now: new Date(options.now ?? generatedAt),
      calendarTimezone: options.timezone,
      todoistTimezone: options.todoistTimezone,
    });
    if (!classification.include) continue;
    if (classification.reason === 'RECURRING') {
      deferred.push({
        task_id: task.id,
        title: task.content,
        reason_code: 'RECURRING_DEFERRED',
        escalation: false,
      });
      continue;
    }
    targetTasks.push({ ...task, target_reason: classification.reason });
  }

  const targetTaskIds = new Set(targetTasks.map((task) => task.id));
  const managedEventsByTaskId = managesCalendar
    ? groupBy(calendarEvents.filter((event) => event.managedTaskId), (event) => event.managedTaskId)
    : new Map();
  const busyEvents = [];
  const staleManagedEvents = [];

  for (const event of calendarEvents.filter(isBusyCalendarEvent)) {
    if (!managesCalendar || !event.managedTaskId) {
      busyEvents.push(event);
      continue;
    }
    const allForTask = [...(managedEventsByTaskId.get(event.managedTaskId) ?? [])].sort(sortEventsByStart);
    const canonical = allForTask[0];
    const isCanonical = canonical?.id === event.id;
    if (!targetTaskIds.has(event.managedTaskId) || !isCanonical) {
      staleManagedEvents.push({
        event_id: event.id,
        task_id: event.managedTaskId,
        start: formatRfc3339InTimeZone(event.start, options.timezone),
        end: formatRfc3339InTimeZone(event.end, options.timezone),
        reason_code: targetTaskIds.has(event.managedTaskId) ? 'DUPLICATE_MANAGED_EVENT' : 'STALE_MANAGED_EVENT',
      });
      busyEvents.push(event);
    }
  }

  const operationalTimezone = options.timezone;
  const deadlineHorizonDate = addDaysToDateString(
    formatDateInTimeZone(now, operationalTimezone),
    Number(options.config.deadlineHorizonDays ?? options.days),
  );
  const scoredCandidates = targetTasks.filter((task) => task.target_reason !== 'PERSISTED_ASSIGNMENT').map((task) => {
    const duration = estimateDuration(task, options.config);
    const scoreData = computeTaskScore(task, {
      now,
      calendarTimezone: operationalTimezone,
      todoistTimezone: operationalTimezone,
      config: options.config,
      duration,
      lastScheduledProject: null,
    });
    return { task, duration, ...scoreData };
  });

  const lowConfidenceCandidates = scoredCandidates.filter((entry) => entry.duration.duration_source === 'default'
    || entry.duration.confidence < Number(options.config.lowConfidenceManualReviewThreshold ?? 0.6));

  for (const entry of lowConfidenceCandidates) {
    const code = entry.duration.duration_source === 'default'
      ? 'DEFAULT_DURATION_LOW_CONFIDENCE'
      : 'DURATION_CONFIDENCE_BELOW_THRESHOLD';
      
    // Instead of deferring and manual review, log a warning and let it schedule autonomously
    warnings.push({
      code: 'LOW_CONFIDENCE_AUTONOMOUS_SCHEDULE',
      message: `${code}: ${entry.task.content} was autonomously scheduled despite low duration confidence.`,
      task_id: entry.task.id,
      count: 1,
    });
  }

  // All candidates flow through to eligibility without being removed for manual review
  const eligibleAfterConfidence = scoredCandidates;
  const horizonEligible = [];
  for (const entry of eligibleAfterConfidence) {
    if (entry.task.deadline_at && entry.task.deadline_at > deadlineHorizonDate) {
      deferred.push({
        task_id: entry.task.id,
        title: entry.task.content,
        reason_code: 'DEADLINE_OUTSIDE_HORIZON',
        deadline_at: entry.task.deadline_at,
        deadline_horizon_date: deadlineHorizonDate,
        score: entry.score,
        escalation: false,
      });
    } else {
      horizonEligible.push(entry);
    }
  }

  const undated = stableSort(
    // "Undated" = no deadline AND no due (start) date. A task with a due date
    // (issue start / 着手日) is temporally anchored and must not be capped by
    // the undated WIP limit. Matt 2026-09-05.
    horizonEligible.filter((entry) =>
      !entry.task.deadline_at && !entry.task.due.date && !entry.task.due.datetime),
    compareTaskPriority,
  );
  const undatedWipLimit = Number(options.config.undatedWipLimit ?? 8);
  const undatedAllowedIds = new Set(undated.slice(0, undatedWipLimit).map((entry) => entry.task.id));
  for (const entry of undated.slice(undatedWipLimit)) {
    deferred.push({
      task_id: entry.task.id,
      title: entry.task.content,
      reason_code: 'UNDATED_WIP_LIMIT',
      score: entry.score,
      escalation: false,
    });
  }
  const estimatedTasks = horizonEligible.filter((entry) =>
    // Admit: has hard deadline, OR has a start-date anchor (着手日, not subject
    // to undated WIP cap), OR is within the undated WIP allowance.
    entry.task.deadline_at || entry.task.due.date || entry.task.due.datetime || undatedAllowedIds.has(entry.task.id),
  );

  const dayWindows = buildPlanningWindow({
    startDate: options.date,
    days: options.days,
    timezone: options.timezone,
    workingHours: options.workingHours,
    lunchHours: options.config.lunchHours,
    now,
    prepMinutes: options.config.prepMinutes,
  });
  const baseBusyIntervals = buildBusyIntervals(
    busyEvents.map((event) => ({ start: event.start, end: event.end })),
    dayWindows,
  );

  const dailyAllocatedMinutes = new Map();
  const projectDailyAllocatedMinutes = new Map();

  const scheduledIntervals = [];

  const scheduled = [];
  const unscheduled = [];
  let remaining = [...estimatedTasks];
  let lastScheduledProject = null;

  while (remaining.length > 0) {
    const scored = stableSort(
      remaining.map((entry) => {
        const scoreData = computeTaskScore(entry.task, {
          now,
          calendarTimezone: options.timezone,
          todoistTimezone: options.todoistTimezone,
          config: options.config,
          duration: entry.duration,
          lastScheduledProject,
        });
        return { ...entry, ...scoreData };
      }),
      compareTaskPriority,
    );

    const current = scored[0];
    remaining = remaining.filter((entry) => entry.task.id !== current.task.id);

    const hardDeadline = (current.deadline && current.deadline < now)
      ? null
      : current.deadline;
    const slot = findSlot({
      durationMinutes: current.duration.duration_minutes,
      deadline: hardDeadline,
      earliestStartTime: current.earliestStart ?? null,
      dayWindows,
      baseBusyIntervals,
      scheduledIntervals,
      dailyAllocatedMinutes,
      maxDailyMinutes: options.maxDailyMinutes,
      breakMinutes: options.minBreakMinutes,
      projectName: current.task.project_name,
      projectDailyAllocatedMinutes,
      projectDailyCapacityMinutes: options.config.projectDailyCapacityMinutes ?? {},
    });

    if (!slot) {
      const escalation = current.score >= Number(options.config.highScoreEscalationThreshold ?? 80);
      unscheduled.push({
        task_id: current.task.id,
        title: current.task.content,
        reason_code: current.deadline ? 'NO_SLOT_BEFORE_DEADLINE' : 'NO_SLOT_AVAILABLE',
        score: current.score,
        score_breakdown: current.breakdown,
        escalation,
        escalation_code: escalation ? 'HIGH_SCORE_UNSCHEDULED' : null,
      });
      continue;
    }

    registerScheduledInterval(scheduledIntervals, dailyAllocatedMinutes, slot, {
      projectName: current.task.project_name,
      projectDailyAllocatedMinutes,
    });
    lastScheduledProject = current.task.project_name ?? lastScheduledProject;

    const start = formatRfc3339InTimeZone(slot.start, options.timezone);
    const end = formatRfc3339InTimeZone(slot.end, options.timezone);
    const scheduledItem = {
      task_id: current.task.id,
      title: current.task.content,
      project: current.task.project_name,
      priority: current.task.priority,
      original_due: current.task.original_due,
      deadline_at: current.task.deadline_at,
      scheduled_start: start,
      assignment_source: 'task-rescheduler',
      planner_version: options.plannerVersion ?? PLANNER_VERSION,
      duration_minutes: current.duration.duration_minutes,
      duration_source: current.duration.duration_source,
      matched_rule: current.duration.matched_rule,
      confidence: current.duration.confidence,
      score: current.score,
      score_breakdown: current.breakdown,
      start,
      end,
      plan_date: slot.date,
      reason_codes: [current.task.target_reason, current.duration.duration_source.toUpperCase()],
      idempotency_key: buildIdempotencyKey({
        taskId: current.task.id,
        start,
        end,
        plannerVersion: options.plannerVersion ?? PLANNER_VERSION,
      }),
    };
    scheduled.push(scheduledItem);
  }

  const operations = {
    calendar_create: [],
    calendar_update: [],
    calendar_noop: [],
    calendar_stale: [],
    todoist_due_update: [],
  };

  for (const item of scheduled) {
    const task = targetTasks.find((candidate) => candidate.id === item.task_id);
    // Calendar WRITE removed (2026-09-05): no create/update/noop ops are
    // generated here. Only Todoist due timestamps are written.
    if ((options.syncTodoistDue || options.todoistOnly) && !task.due.is_recurring) {
      operations.todoist_due_update.push(buildTodoistDueOperation(task, item, options));
    }
  }

  const escalatedUnscheduled = unscheduled.filter((item) => item.escalation);
  if (escalatedUnscheduled.length > 0) {
    warnings.push({
      code: 'HIGH_SCORE_UNSCHEDULED',
      message: 'High-score tasks could not be scheduled and require explicit escalation in the report.',
      count: escalatedUnscheduled.length,
      task_ids: escalatedUnscheduled.map((item) => item.task_id),
    });
  }

  const plan = {
    schema_version: PLAN_SCHEMA_VERSION,
    run_id: runId,
    generated_at: generatedAt,
    timezone: options.timezone,
    mode: options.mode,
    todoist_only: options.todoistOnly,
    inputs: {
      todoist_task_count: tasks.length,
      calendar_event_count: calendarEvents.length,
      window: {
        start: options.date,
        days: options.days,
        calendars: options.calendars,
      },
    },
    scheduled,
    unscheduled,
    deferred,
    manual_review: manualReview,
    operations,
    errors,
    warnings,
  };

  plan.state_hash = sha256(JSON.stringify({ scheduled: plan.scheduled, manual_review: plan.manual_review, unscheduled: plan.unscheduled, deferred: plan.deferred, tasks: tasks.length, events: calendarEvents.length }));
  return plan;
}
