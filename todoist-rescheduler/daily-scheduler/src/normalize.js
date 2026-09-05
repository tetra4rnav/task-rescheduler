import { endOfDay, formatDateInTimeZone, formatRfc3339InTimeZone, startOfDay } from './time.js';
import { extractManagedTaskId, isManagedEvent } from './markers.js';

function normalizeDuration(duration) {
  if (!duration) return null;
  if (typeof duration === 'number') return duration;
  if (typeof duration === 'object') {
    const amount = Number(duration.amount ?? duration.value ?? 0);
    const unit = String(duration.unit ?? 'minute').toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (unit.startsWith('hour')) return Math.round(amount * 60);
    return Math.round(amount);
  }
  return null;
}

export function buildProjectNameIndex(projects = []) {
  return new Map(projects.map((project) => [String(project.id), project.name ?? String(project.id)]));
}

export function normalizeTodoistTask(rawTask, {
  projectNames = new Map(),
  excludedProjectIds = [],
  excludedProjectNames = [],
  excludedLabels = [],
  requireAutoScheduleLabel = false,
  autoScheduleLabel = 'auto-schedule',
  assignmentMarkerLabel = 'task-rescheduler-assigned',
  plannerVersionLabelPrefix = 'task-rescheduler-planner-v',
} = {}) {
  const projectId = rawTask.project_id == null ? null : String(rawTask.project_id);
  const labels = Array.isArray(rawTask.labels) ? rawTask.labels.map(String) : [];
  const projectName = rawTask.project_name ?? projectNames.get(projectId) ?? null;
  const due = rawTask.due ?? null;
  // Todoist API v1 may place a timestamp in due.date rather than due.datetime.
  // Preserve the semantic distinction by promoting timestamp-shaped values.
  const rawDueDate = due?.date ?? null;
  const dueDateTime = due?.datetime ?? (typeof rawDueDate === 'string' && rawDueDate.includes('T') ? rawDueDate : null);
  const dueDate = dueDateTime ? null : rawDueDate;
  const isRecurring = Boolean(due?.is_recurring);
  const completed = Boolean(rawTask.is_completed ?? rawTask.completed ?? false);
  const cancelled = Boolean(rawTask.is_deleted ?? rawTask.cancelled ?? false);
  const autoSchedule = labels.includes(autoScheduleLabel);
  const assignmentSource = dueDateTime
    ? (labels.includes(assignmentMarkerLabel) ? 'task-rescheduler' : 'manual')
    : null;
  const plannerVersionLabel = labels.find((label) => label.startsWith(plannerVersionLabelPrefix));
  const plannerVersion = plannerVersionLabel ? plannerVersionLabel.slice(plannerVersionLabelPrefix.length).replaceAll('-', '.') : null;
  const deadlineAt = rawTask.deadline?.date ?? null;
  const excluded =
    completed ||
    cancelled ||
    rawTask.parent_id != null ||
    excludedProjectIds.includes(projectId) ||
    excludedProjectNames.includes(projectName) ||
    labels.some((label) => excludedLabels.includes(label)) ||
    (requireAutoScheduleLabel && !autoSchedule);

  return {
    id: String(rawTask.id),
    content: String(rawTask.content ?? '').trim(),
    description: String(rawTask.description ?? ''),
    project_id: projectId,
    project_name: projectName,
    section_id: rawTask.section_id == null ? null : String(rawTask.section_id),
    labels,
    priority: Number(rawTask.priority ?? 1),
    due: {
      date: dueDate,
      datetime: dueDateTime,
      timezone: due?.timezone ?? null,
      is_recurring: isRecurring,
    },
    deadline_at: deadlineAt,
    scheduled_start: dueDateTime,
    assignment_source: assignmentSource,
    planner_version: plannerVersion,
    auto_schedule: autoSchedule,
    duration: normalizeDuration(rawTask.duration),
    url: rawTask.url ?? null,
    created_at: rawTask.created_at ?? rawTask.added_at ?? null,
    parent_id: rawTask.parent_id == null ? null : String(rawTask.parent_id),
    completed,
    cancelled,
    excluded,
    original_due: dueDateTime ?? dueDate ?? null,
  };
}

export function classifyTaskTarget(task, { now, calendarTimezone, todoistTimezone }) {
  if (task.excluded) return { include: false, reason: 'EXCLUDED' };
  if (task.due.is_recurring) return { include: true, reason: 'RECURRING' };
  if (task.due.datetime) {
    if (task.assignment_source === 'manual') {
      return { include: true, reason: 'MANUAL_ASSIGNMENT' };
    }
    return { include: true, reason: 'TETRA_ASSIGNMENT' };
  }
  if (task.due.date) {
    return { include: true, reason: 'DATE_ONLY_DUE_REQUIRES_MIGRATION' };
  }
  return { include: true, reason: task.deadline_at ? 'HAS_DEADLINE' : 'NO_DUE' };
}

export function taskDeadline(task, { todoistTimezone }) {
  // Matt 2026-09-05: Todoist deadline == issue target date == the ONLY hard
  // deadline. Todoist due date == issue start date == 着手日 (earliest start),
  // NOT a deadline. Only deadline_at may gate a slot.
  if (task.deadline_at) {
    return endOfDay(task.deadline_at, todoistTimezone);
  }
  return null;
}

// Earliest start constraint derived from Todoist due (issue start date / 着手日).
// A task may not be scheduled to begin before this instant.
export function taskEarliestStart(task, { todoistTimezone }) {
  if (task.due.datetime) {
    return new Date(task.due.datetime);
  }
  if (task.due.date) {
    return endOfDay(task.due.date, todoistTimezone);
  }
  return null;
}

export function normalizeCalendarEvent(rawEvent, { calendarId = 'primary', timezone }) {
  const status = rawEvent.status ?? 'confirmed';
  const transparency = rawEvent.transparency ?? 'opaque';
  const allDay = Boolean(rawEvent.start?.date && !rawEvent.start?.dateTime);
  const start = allDay
    ? startOfDay(rawEvent.start.date, timezone)
    : new Date(rawEvent.start?.dateTime ?? rawEvent.start?.date ?? rawEvent.start);
  const end = allDay
    ? startOfDay(rawEvent.end?.date ?? rawEvent.start?.date, timezone)
    : new Date(rawEvent.end?.dateTime ?? rawEvent.end?.date ?? rawEvent.end);
  const normalized = {
    id: String(rawEvent.id),
    calendarId: rawEvent.calendarId ?? calendarId,
    summary: rawEvent.summary ?? '',
    description: rawEvent.description ?? '',
    status,
    transparency,
    start,
    end,
    allDay,
    raw: rawEvent,
    managedTaskId: extractManagedTaskId(rawEvent),
    managed: isManagedEvent(rawEvent),
    privateProperties: rawEvent.extendedProperties?.private ?? rawEvent.privateProperties ?? {},
  };
  return normalized;
}

export function isBusyCalendarEvent(event) {
  if (event.status === 'cancelled') return false;
  if (event.transparency === 'transparent' || event.transparency === 'free') return false;
  return event.end > event.start;
}

export function serializeEventWindow(event, timeZone) {
  return {
    start: formatRfc3339InTimeZone(event.start, timeZone),
    end: formatRfc3339InTimeZone(event.end, timeZone),
  };
}
