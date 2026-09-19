import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ApiError } from '../src/errors.js';
import { applyLlmPlacements, describeTodoistError, isItemDurationInvalid } from '../src/llm_apply.js';
import { loadRegistry, writeRegistry } from '../src/registry.js';
import { normalizeTodoistTask } from '../src/normalize.js';

const DUE = '2026-09-06T10:00:00Z';
const DURATION_INVALID_BODY = {
  error: 'Item duration is invalid',
  error_code: 546,
  error_tag: 'ITEM_DURATION_INVALID',
  http_code: 400,
};

class FakeTodoistClient {
  constructor({ onCall } = {}) {
    this.calls = [];
    this.onCall = onCall;
  }

  async updateTaskDue(taskId, payload) {
    this.calls.push({ taskId, payload: structuredClone(payload) });
    if (this.onCall) await this.onCall(taskId, payload);
    return { ok: true };
  }
}

function durationInvalidError() {
  return new ApiError('Todoist API request failed with status 400', {
    status: 400,
    body: structuredClone(DURATION_INVALID_BODY),
  });
}

async function withRegistry(entries = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-apply-'));
  const registryPath = path.join(dir, 'tasks-registry.json');
  await writeRegistry({
    schema_version: '1',
    updated_at: null,
    tasks: entries.map((entry) => ({
      id: entry.id,
      rescheduled: entry.rescheduled ?? false,
      last_rescheduled_at: entry.last_rescheduled_at ?? null,
    })),
  }, registryPath);
  return registryPath;
}

function task(raw) {
  return normalizeTodoistTask(raw, { excludedLabels: [] });
}

function rescheduledIds(registry) {
  return registry.tasks.filter((t) => t.rescheduled).map((t) => t.id);
}

test('describeTodoistError keeps the Todoist body and 546 tag', () => {
  const described = describeTodoistError(durationInvalidError());
  assert.match(described.message, /ITEM_DURATION_INVALID/);
  assert.match(described.message, /error_code 546/);
  assert.equal(described.error_code, 546);
  assert.equal(described.error_tag, 'ITEM_DURATION_INVALID');
  assert.deepEqual(described.body, DURATION_INVALID_BODY);
  assert.equal(isItemDurationInvalid(durationInvalidError()), true);
});

test('apply-llm writes due first, then duration in a separate request', async () => {
  const client = new FakeTodoistClient();
  const registryPath = await withRegistry([{ id: 'a' }]);
  const tasks = [task({ id: 'a', content: 'Empty', labels: [], due: null })];
  const result = await applyLlmPlacements(
    [{ task_id: 'a', due: DUE, duration_minutes: 45 }],
    { todoistClient: client, tasks, registryPath, fixedDurationLabel: 'fixed-duration' },
  );
  assert.equal(result.errors.length, 0);
  assert.equal(result.applied[0].duration_minutes, 45);
  assert.deepEqual(client.calls, [
    { taskId: 'a', payload: { due_datetime: DUE } },
    { taskId: 'a', payload: { duration: { amount: 45, unit: 'minute' } } },
  ]);
});

test('apply-llm due-only placements still apply', async () => {
  const client = new FakeTodoistClient();
  const registryPath = await withRegistry([{ id: 'a' }]);
  const tasks = [task({ id: 'a', content: 'Empty', labels: [], due: null })];
  await applyLlmPlacements(
    [{ task_id: 'a', due: DUE }],
    { todoistClient: client, tasks, registryPath, fixedDurationLabel: 'fixed-duration' },
  );
  assert.deepEqual(client.calls, [
    { taskId: 'a', payload: { due_datetime: DUE } },
  ]);
});

test('apply-llm skips duration when Todoist already has one', async () => {
  const client = new FakeTodoistClient();
  const registryPath = await withRegistry([{ id: 'a' }]);
  const tasks = [task({
    id: 'a',
    content: 'Has duration',
    labels: [],
    due: null,
    duration: { amount: 20, unit: 'minute' },
  })];
  const result = await applyLlmPlacements(
    [{ task_id: 'a', due: DUE, duration_minutes: 90 }],
    { todoistClient: client, tasks, registryPath, fixedDurationLabel: 'fixed-duration' },
  );
  assert.equal(result.applied[0].duration_minutes, null);
  assert.deepEqual(client.calls, [
    { taskId: 'a', payload: { due_datetime: DUE } },
  ]);
});

test('apply-llm skips duration when the fixed_duration label is present', async () => {
  const client = new FakeTodoistClient();
  const registryPath = await withRegistry([{ id: 'a' }]);
  const tasks = [task({ id: 'a', content: 'Fixed', labels: ['fixed-duration'], due: null })];
  const result = await applyLlmPlacements(
    [{ task_id: 'a', due: DUE, duration_minutes: 90 }],
    { todoistClient: client, tasks, registryPath, fixedDurationLabel: 'fixed-duration' },
  );
  assert.equal(result.applied[0].duration_minutes, null);
  assert.deepEqual(client.calls, [
    { taskId: 'a', payload: { due_datetime: DUE } },
  ]);
});

test('apply-llm skips duration on recurring tasks', async () => {
  const client = new FakeTodoistClient();
  const registryPath = await withRegistry([{ id: 'a' }]);
  const tasks = [task({
    id: 'a',
    content: 'Recurring',
    labels: [],
    due: { date: 'every day', is_recurring: true },
  })];
  const result = await applyLlmPlacements(
    [{ task_id: 'a', due: DUE, duration_minutes: 45 }],
    { todoistClient: client, tasks, registryPath, fixedDurationLabel: 'fixed-duration' },
  );
  assert.equal(result.applied[0].duration_minutes, null);
  assert.deepEqual(client.calls, [
    { taskId: 'a', payload: { due_datetime: DUE } },
  ]);
});

test('apply-llm keeps due when the separate duration write is ITEM_DURATION_INVALID', async () => {
  const logs = [];
  const client = new FakeTodoistClient({
    onCall(_taskId, payload) {
      if (payload.duration) throw durationInvalidError();
    },
  });
  const registryPath = await withRegistry([{ id: 'a' }]);
  const tasks = [task({ id: 'a', content: 'Empty', labels: [], due: null })];
  const result = await applyLlmPlacements(
    [{ task_id: 'a', due: DUE, duration_minutes: 45 }],
    {
      todoistClient: client,
      tasks,
      registryPath,
      fixedDurationLabel: 'fixed-duration',
      logger: { error: (message, meta) => logs.push({ message, meta }) },
    },
  );

  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].status, 'applied');
  assert.equal(result.applied[0].duration_minutes, null);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].step, 'duration');
  assert.equal(result.errors[0].recovered, true);
  assert.equal(result.errors[0].error_code, 546);
  assert.equal(result.errors[0].error_tag, 'ITEM_DURATION_INVALID');
  assert.deepEqual(result.errors[0].body, DURATION_INVALID_BODY);
  assert.match(result.errors[0].error, /ITEM_DURATION_INVALID/);
  assert.equal(logs[0].meta.body.error_tag, 'ITEM_DURATION_INVALID');

  const registry = await loadRegistry(registryPath);
  assert.deepEqual(rescheduledIds(registry), ['a']);
});

test('apply-llm retries due-only when the first due write returns ITEM_DURATION_INVALID', async () => {
  let dueAttempts = 0;
  const client = new FakeTodoistClient({
    onCall(_taskId, payload) {
      if (payload.due_datetime) {
        dueAttempts += 1;
        if (dueAttempts === 1) throw durationInvalidError();
      }
    },
  });
  const registryPath = await withRegistry([{ id: 'a' }]);
  const tasks = [task({ id: 'a', content: 'Empty', labels: [], due: null })];
  const result = await applyLlmPlacements(
    [{ task_id: 'a', due: DUE, duration_minutes: 45 }],
    { todoistClient: client, tasks, registryPath, fixedDurationLabel: 'fixed-duration' },
  );
  assert.equal(dueAttempts, 2);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].duration_minutes, 45);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].step, 'due');
  assert.equal(result.errors[0].recovered, true);
  assert.equal(result.errors[0].error_tag, 'ITEM_DURATION_INVALID');
  assert.ok(client.calls.every((call) => !(call.payload.due_datetime && call.payload.duration)));
});

test('apply-llm surfaces due-write body and does not mark failed tasks rescheduled', async () => {
  const dueFail = new ApiError('Todoist API request failed with status 400', {
    status: 400,
    body: { error: 'Invalid due', error_code: 50, error_tag: 'INVALID_DUE', http_code: 400 },
  });
  const client = new FakeTodoistClient({
    onCall(taskId) {
      if (taskId === 'fail') throw dueFail;
    },
  });
  const registryPath = await withRegistry([
    { id: 'ok' },
    { id: 'fail' },
  ]);
  const tasks = [
    task({ id: 'ok', content: 'OK', labels: [], due: null, duration: { amount: 20, unit: 'minute' } }),
    task({ id: 'fail', content: 'Fail', labels: [], due: null, duration: { amount: 20, unit: 'minute' } }),
  ];
  const result = await applyLlmPlacements(
    [
      { task_id: 'ok', due: DUE, duration_minutes: 20 },
      { task_id: 'fail', due: DUE, duration_minutes: 20 },
    ],
    { todoistClient: client, tasks, registryPath, fixedDurationLabel: 'fixed-duration' },
  );

  assert.deepEqual(result.applied.map((row) => row.task_id), ['ok']);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].task_id, 'fail');
  assert.equal(result.errors[0].step, 'due');
  assert.equal(result.errors[0].error_tag, 'INVALID_DUE');
  assert.equal(result.errors[0].body.error, 'Invalid due');
  assert.equal(result.errors[0].recovered, undefined);

  const registry = await loadRegistry(registryPath);
  assert.deepEqual(rescheduledIds(registry), ['ok']);
  assert.equal(registry.tasks.find((t) => t.id === 'fail').rescheduled, false);
});
