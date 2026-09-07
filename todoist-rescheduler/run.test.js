/**
 * Path / CLI-flag smoke tests for the flatten layout.
 * CommonJS wrapper tests + ESM policy path (dynamic import).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseArgs,
  PACKAGE_ROOT,
  SCHEDULER,
} = require('./run.js');

test('engine binary exists at package-relative path', () => {
  assert.equal(
    SCHEDULER,
    path.join(PACKAGE_ROOT, 'engine', 'bin', 'daily-scheduler.js'),
  );
  assert.ok(fs.existsSync(SCHEDULER), `missing ${SCHEDULER}`);
});

test('PACKAGE_ROOT is the todoist-rescheduler directory', () => {
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'run.js')));
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'engine')));
  assert.equal(path.basename(PACKAGE_ROOT), 'todoist-rescheduler');
});

test('parseArgs --dry-run stays plan-only', () => {
  const opts = parseArgs(['--dry-run', '--timezone', 'UTC']);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.apply, false);
});

test('parseArgs with neither flag defaults to apply', () => {
  const opts = parseArgs(['--timezone', 'UTC']);
  assert.equal(opts.apply, true);
  assert.equal(opts.dryRun, false);
});

test('defaultPolicyPath resolves to package POLICY.md', async () => {
  const { defaultPolicyPath } = await import('./engine/src/policy.js');
  const expected = path.resolve(PACKAGE_ROOT, 'POLICY.md');
  assert.equal(defaultPolicyPath(), expected);
});
