import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCli } from '../src/config.js';

test('--model enables llmDuration when config default is off', async () => {
  const options = await parseCli(['plan', '--timezone', 'UTC', '--model', 'openrouter/auto-beta'], { now: new Date('2026-03-08T13:10:00Z') });
  assert.equal(options.config.llmDuration.enabled, true);
  assert.equal(options.config.llmDuration.model, 'openrouter/auto-beta');
});

test('no --model leaves llmDuration off by default', async () => {
  const options = await parseCli(['plan', '--timezone', 'UTC'], { now: new Date('2026-03-08T13:10:00Z') });
  assert.equal(options.config.llmDuration.enabled, false);
  assert.equal(options.config.llmDuration.model, null);
});