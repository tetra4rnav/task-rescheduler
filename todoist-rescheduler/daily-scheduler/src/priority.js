import { compareStrings } from './util.js';
import { formatDateInTimeZone } from './time.js';
import { taskDeadline, taskEarliestStart } from './normalize.js';

function daysBetweenDateStrings(a, b) {
  const start = new Date(`${a}T00:00:00Z`);
  const end = new Date(`${b}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

function ageInDays(createdAt, now) {
  if (!createdAt) return 0;
  return Math.max(0, Math.floor((now.getTime() - new Date(createdAt).getTime()) / 86_400_000));
}

export function computeTaskScore(task, {
  now,
  calendarTimezone,
  todoistTimezone,
  config,
  duration,
  lastScheduledProject = null,
}) {
  const weights = config.scoreWeights;
  const todayInTodoist = formatDateInTimeZone(now, todoistTimezone);
  let overdueDays = 0;

  // OVERDUE applies ONLY to the hard deadline (Todoist deadline = issue target
  // date). Matt 2026-09-05: due date is the issue START date (着手日), NOT a
  // deadline — a passed start date does not make a task overdue, it only makes
  // it eligible to start (handled as earliest-start constraint). Treating due
  // as overdue inflated scores by up to 450 and skewed scheduling.
  if (task.deadline_at) {
    if (task.deadline_at < todayInTodoist) {
      overdueDays = Math.max(1, daysBetweenDateStrings(task.deadline_at, todayInTodoist));
    }
  }

  const deadline = taskDeadline(task, { todoistTimezone });
  // Earliest start (issue start date / 着手日). Must be returned so the planner
  // can pass it to findSlot as a start constraint and use it for ordering.
  const earliestStart = taskEarliestStart(task, { todoistTimezone });
  // Start-date (着手日) urgency: a due date is the issue start date — not a hard
  // deadline, but it is a "planned start" signal. Tasks whose start date is
  // near or already passed should pull ahead of unanchored filler, else anchored
  // work loses priority to low-score backlog (verified regression 2026-09-05).
  // We compute a bounded pull using the same day-buckets as deadlines but a
  // fraction of the weight, so it orders without gating.
  let startDateUrgency = 0;
  if (earliestStart) {
    // A due date that has already passed just means "eligible to start" (着手日
    // passed) — not urgent. Only a start date still AHEAD of today pulls the
    // task forward, so upcoming-planned work front-loads.
    const dayDiff = Math.floor((earliestStart.getTime() - now.getTime()) / 86_400_000);
    if (dayDiff >= 0 && dayDiff < 1) startDateUrgency = Math.round((weights.deadlineSameDay || 350) * 0.5);
    else if (dayDiff >= 1 && dayDiff < 2) startDateUrgency = Math.round((weights.deadlineNextDay || 250) * 0.5);
    else if (dayDiff >= 2 && dayDiff < 5) startDateUrgency = Math.round((weights.deadlineSoon || 100) * 0.5);
  }
  let deadlineUrgency = 0;
  if (deadline && !overdueDays) {
    const dayDiff = Math.floor((deadline.getTime() - now.getTime()) / 86_400_000);
    if (dayDiff < 1) deadlineUrgency = weights.deadlineSameDay || 0;
    else if (dayDiff < 2) deadlineUrgency = weights.deadlineNextDay || 0;
    else if (dayDiff < 5) deadlineUrgency = weights.deadlineSoon || 0;
  }

  let overdueWeight = 0;
  if (overdueDays > 0) {
    overdueWeight = (weights.overdueBase || 0) + (overdueDays * (weights.overduePerDay || 0));
    if (weights.overdueCap) {
      overdueWeight = Math.min(overdueWeight, weights.overdueCap);
    }
  }

  const todoistPriorityWeight = weights.todoistPriority[task.priority] ?? 0;
  const projectWeight = (config.projectWeights ?? {})[task.project_name ?? ''] ?? 0;
  const ageWeight = Math.min(weights.ageCap || 0, ageInDays(task.created_at, now) * (weights.agePerDay || 0));
  const contextSwitchPenalty = lastScheduledProject && task.project_name && lastScheduledProject !== task.project_name
    ? (weights.contextSwitchPenalty || 0)
    : 0;
  const longTaskPenalty = duration.duration_minutes > 60
    ? Math.floor((duration.duration_minutes - 60) / 30 + 1) * (weights.longTaskPenaltyPer30Minutes || 0)
    : 0;
  const explicitDurationBonus = duration.duration_source === 'todoist_duration'
    ? Number(weights.explicitDurationBonus ?? config.explicitDurationScoreBonus ?? 0)
    : 0;
  const hasDescriptionBonus = task.description && task.description.trim().length > 0 
    ? (weights.hasDescriptionBonus || 0)
    : 0;

  const score = overdueWeight
    + todoistPriorityWeight
    + deadlineUrgency
    + startDateUrgency
    + projectWeight
    + ageWeight
    + explicitDurationBonus
    + hasDescriptionBonus
    - contextSwitchPenalty
    - longTaskPenalty;

  return {
    score,
    breakdown: {
      overdue_days: overdueDays,
      overdue_weight: overdueWeight,
      todoist_priority_weight: todoistPriorityWeight,
      deadline_urgency: deadlineUrgency,
      start_date_urgency: startDateUrgency,
      project_weight: projectWeight,
      age_weight: ageWeight,
      explicit_duration_bonus: explicitDurationBonus,
      has_description_bonus: hasDescriptionBonus,
      context_switch_penalty: contextSwitchPenalty,
      long_task_penalty: longTaskPenalty,
    },
    deadline,
    earliestStart,
  };
}

export function compareTaskPriority(left, right) {
  const leftDeadline = left.deadline ? left.deadline.getTime() : Number.POSITIVE_INFINITY;
  const rightDeadline = right.deadline ? right.deadline.getTime() : Number.POSITIVE_INFINITY;
  return right.score - left.score
    || leftDeadline - rightDeadline
    || right.task.priority - left.task.priority
    || new Date(left.task.created_at || left.task.id).getTime() - new Date(right.task.created_at || right.task.id).getTime()
    || compareStrings(left.task.id, right.task.id);
}
