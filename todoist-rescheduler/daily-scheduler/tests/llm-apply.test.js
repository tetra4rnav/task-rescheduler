import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { applyLlmPlacements } from '../src/llm_apply.js';
import { writeRegistry } from '../src/registry.js';
import { normalizeTodoistTask } from '../src/normalize.js';

class FakeTodoistClient {
  constructor() {
    this.calls = [];
  }

  async updateTaskDue(taskId, payload) {
    this.calls.push({ taskId, payload: structuredClone(payload) });
    return { ok: true };
  }
}

async function withRegistry() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-apply-'));
  const registryPath = path.join(dir, 'tasks-registry.json');
  await writeRegistry({ schema_version: '1', updated_at: null, tasks: [] }, registryPath);
  return registryPath;
}

function task(raw) {
  return normalizeTodoistTask(raw, { excludedLabels: [] });
}

test('apply-llm writes duration when the live task has none and is not fixed', async () => {
  const client = new FakeTodoistClient();
  const registryPath = await withRegistry();
  const tasks = [task({ id: 'a', content: 'Empty', labels: [], due: null })];
  const result = await applyLlmPlacements(
    [{ task_id: 'a', due: '2026-09-06T10:00:00Z', duration_minutes: 45 }],
    { todoistClient: client, tasks, registryPath, fixedDurationLabel: 'fixed-duration' },
  );
  assert.equal(result.errors.length, 0);
  assert.equal(result.applied[0].duration_minutes, 45);
  assert.deepEqual(client.calls[0].payload, {
    due_datetime: '2026-09-06T10:00:00Z',
    duration: { amount: 45, unit: 'minute' },
  });
});

test('apply-llm due-only placements still apply', async () => {
  const client = new FakeTodoistClient();
  const registryPath = await withRegistry();
  const tasks = [task({ id: 'a', content: 'Empty', labels: [], due: null })];
  await applyLlmPlacements(
    [{ task_id: 'a', due: '2026-09-06T10:00:00Z' }],
    { todoistClient: client, tasks, registryPath, fixedDurationLabel: 'fixed-duration' },
  );
  assert.deepEqual(client.calls[0].payload, { due_datetime: '2026-09-06T10:00:00Z' });
});

test('apply-llm skips duration when Todoist already has one', async () => {
  const client = new FakeTodoistClient();
  const registryPath = await withRegistry();
  const tasks = [task({
    id: 'a',
    content: 'Has duration',
    labels: [],
    due: null,
    duration: { amount: 20, unit: 'minute' },
  })];
  const result = await applyLlmPlacements(
    [{ task_id: 'a', due: '2026-09-06T10:00:00Z', duration_minutes: 90 }],
    { todoistClient: client, tasks, registryPath, fixedDurationLabel: 'fixed-duration' },
  );
  assert.equal(result.applied[0].duration_minutes, null);
  assert.deepEqual(client.calls[0].payload, { due_datetime: '2026-09-06T10:00:00Z' });
});

test('apply-llm skips duration when the fixed_duration label is present', async () => {
  const client = new FakeTodoistClient();
  const registryPath = await withRegistry();
  const tasks = [task({ id: 'a', content: 'Fixed', labels: ['fixed-duration'], due: null })];
  const result = await applyLlmPlacements(
    [{ task_id: 'a', due: '2026-09-06T10:00:00Z', duration_minutes: 90 }],
    { todoistClient: client, tasks, registryPath, fixedDurationLabel: 'fixed-duration' },
  );
  assert.equal(result.applied[0].duration_minutes, null);
  assert.deepEqual(client.calls[0].payload, { due_datetime: '2026-09-06T10:00:00Z' });
});
