import { compareStrings } from './util.js';
import { formatDateInTimeZone } from './time.js';
import { taskDeadline } from './normalize.js';

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
  
  if (task.deadline_at) {
    if (task.deadline_at < todayInTodoist) {
      overdueDays = Math.max(1, daysBetweenDateStrings(task.deadline_at, todayInTodoist));
    }
  } else if (task.due && task.due.datetime && new Date(task.due.datetime) < now) {
    overdueDays = Math.max(1, Math.floor((now.getTime() - new Date(task.due.datetime).getTime()) / 86_400_000) + 1);
  } else if (task.due && task.due.date && task.due.date < todayInTodoist) {
    overdueDays = Math.max(1, daysBetweenDateStrings(task.due.date, todayInTodoist));
  }

  const deadline = taskDeadline(task, { todoistTimezone });
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
      project_weight: projectWeight,
      age_weight: ageWeight,
      explicit_duration_bonus: explicitDurationBonus,
      has_description_bonus: hasDescriptionBonus,
      context_switch_penalty: contextSwitchPenalty,
      long_task_penalty: longTaskPenalty,
    },
    deadline,
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
