#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { DEFAULT_CONFIG } from '../src/constants.js';
import { estimateDuration } from '../src/duration.js';
import { normalizeCalendarEvent, normalizeTodoistTask } from '../src/normalize.js';
import { buildPlan } from '../src/planner.js';
import { readSchema, validatePlan } from '../src/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const tasks = JSON.parse(readFileSync(path.join(root, 'fixtures/todoist-tasks.json'), 'utf8'));
const events = JSON.parse(readFileSync(path.join(root, 'fixtures/calendar-events.json'), 'utf8'));
const sampleConfig = JSON.parse(readFileSync(path.join(root, 'fixtures/sample-config.json'), 'utf8'));

const options = {
  command: 'plan',
  mode: 'dry-run',
  date: '2026-03-08',
  days: 3,
  timezone: 'America/New_York',
  todoistTimezone: 'Asia/Tokyo',
  account: 'your-email-at-provider.example',
  calendars: ['primary'],
  workingHours: '09:00-18:00',
  maxDailyMinutes: 360,
  minBreakMinutes: 15,
  plannerVersion: '1.0.0',
  now: '2026-03-08T13:10:00Z',
  syncTodoistDue: false,
  config: {
    ...structuredClone(DEFAULT_CONFIG),
    ...sampleConfig,
    durationRules: {
      ...structuredClone(DEFAULT_CONFIG.durationRules),
      ...sampleConfig.durationRules,
      projects: {
        ...structuredClone(DEFAULT_CONFIG.durationRules.projects),
        ...sampleConfig.durationRules.projects,
      },
      labels: {
        ...structuredClone(DEFAULT_CONFIG.durationRules.labels),
        ...sampleConfig.durationRules.labels,
      },
      taskPatterns: sampleConfig.durationRules.taskPatterns,
    },
    projectWeights: {
      ...structuredClone(DEFAULT_CONFIG.projectWeights),
      ...sampleConfig.projectWeights,
    },
  },
};

const normalizedTasks = tasks.map((task) => normalizeTodoistTask(task, {
  excludedProjectIds: options.config.excludedProjectIds,
  excludedProjectNames: options.config.excludedProjectNames,
  excludedLabels: options.config.excludedLabels,
}));
const normalizedEvents = events.map((event) => normalizeCalendarEvent(event, { calendarId: 'primary', timezone: options.timezone }));
const plan = buildPlan({
  tasks: normalizedTasks,
  calendarEvents: normalizedEvents,
  options,
  runId: 'typecheck',
  generatedAt: '2026-03-08T13:10:00Z',
});
const schema = readSchema();
const validation = validatePlan(plan);

assert.equal(typeof schema.$id, 'string');
assert.equal(validation.valid, true, validation.errors.join('\n'));
assert.equal(typeof estimateDuration(normalizedTasks[0], options.config).duration_minutes, 'number');
assert.equal(Array.isArray(plan.scheduled), true);

console.log('typecheck ok');
