import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../src/planner.js';
import { DEFAULT_CONFIG, PLANNER_VERSION } from '../src/constants.js';
import { normalizeTodoistTask } from '../src/normalize.js';

test('34. Todoist-only plans persist scheduled slots as busy intervals for subsequent runs', () => {
  const options = {
    command: 'plan', mode: 'dry-run', date: '2026-03-08', days: 1,
    timezone: 'America/New_York', todoistTimezone: 'America/New_York',
    calendars: ['primary'], workingHours: '09:00-11:00',
    maxDailyMinutes: 120, minBreakMinutes: 0, plannerVersion: PLANNER_VERSION,
    now: '2026-03-08T08:00:00Z', syncTodoistDue: false, todoistOnly: true,
    config: DEFAULT_CONFIG,
  };

  const tasks = [
    normalizeTodoistTask({
      id: 'existing-task',
      content: 'Already placed task',
      duration: { amount: 60, unit: 'minute' },
      due: { datetime: '2026-03-08T13:00:00Z', is_recurring: false },
      labels: ['task-rescheduler-assigned', 'task-rescheduler-planner-v1-1-0'],
      priority: 4,
    }, { excludedLabels: [], assignmentMarkerLabel: 'task-rescheduler-assigned', plannerVersionLabelPrefix: 'task-rescheduler-planner-v' }),
    normalizeTodoistTask({
      id: 'new-task',
      content: 'New task to place with duration',
      duration: { amount: 60, unit: 'minute' },
      labels: [],
      due: null,
      priority: 4,
    }, { excludedLabels: [], assignmentMarkerLabel: 'task-rescheduler-assigned', plannerVersionLabelPrefix: 'task-rescheduler-planner-v' }),
  ];

  const plan = buildPlan({
    tasks,
    calendarEvents: [],
    options,
    runId: 'x',
    generatedAt: '2026-03-08T08:00:00Z',
  });

  const scheduled = plan.scheduled.find(t => t.task_id === 'new-task');
  assert.ok(scheduled, 'New task must be scheduled');
  
  // It shouldn't overlap with 09:00-10:00 which was taken by the existing-task
  const startLocal = scheduled.start.slice(11, 16);
  assert.equal(startLocal, '10:00');
});
