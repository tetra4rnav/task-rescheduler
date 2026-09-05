import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRegistry } from '../src/registry.js';

const tasks = [
  {
    id: 't1',
    content: '[tetra4rnav/naniwahp-geniac #1](https://github.com/tetra4rnav/naniwahp-geniac/issues/1) 文献レビュー',
    description: '',
    project_name: 'GENIAC-PRIZE2026',
    priority: 2,
    due: { datetime: '2026-08-27T12:00:00Z' },
    deadline_at: '2026-08-30',
    labels: ['github-issue'],
  },
  {
    id: 't2',
    content: '普通のタスク (githubでない)',
    description: '',
    project_name: 'Inbox',
    priority: 1,
    due: { date: '2026-09-06' },
    deadline_at: null,
    labels: [],
  },
];

test('registry detects github issues and non-issue tasks', () => {
  const registry = mergeRegistry({ schema_version: '1', tasks: [] }, tasks, { now: '2026-09-05T00:00:00Z' });
  assert.equal(registry.tasks.length, 2);
  const gh = registry.tasks.find((t) => t.id === 't1');
  assert.equal(gh.is_github_issue, true);
  assert.equal(gh.owner, 'tetra4rnav');
  assert.equal(gh.repo, 'naniwahp-geniac');
  assert.equal(gh.issue_number, 1);
  const plain = registry.tasks.find((t) => t.id === 't2');
  assert.equal(plain.is_github_issue, false);
});

test('registry preserves rescheduled flag across merges and drops removed tasks', () => {
  const first = mergeRegistry({ schema_version: '', tasks: [] }, tasks, { now: '2026-09-05T00:00:00Z' });
  // Simulate t1 being scheduled in a previous run.
  first.tasks[0].rescheduled = true;
  first.tasks[0].last_rescheduled_at = '2026-09-05T00:00:00Z';

  const nextTasks = tasks.filter((t) => t.id !== 't2'); // t2 now completed/removed
  const second = mergeRegistry(first, nextTasks, { now: '2026-09-06T00:00:00Z' });
  assert.equal(second.tasks.length, 1);
  assert.equal(second.tasks[0].rescheduled, true, 'flag carried over to new registry');
  assert.equal(second.tasks[0].last_rescheduled_at, '2026-09-05T00:00:00Z');
});