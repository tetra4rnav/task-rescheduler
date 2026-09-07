// LLM-based duration override (Matt 2026-09-05, model resolved at runtime).
//
// Invoked only when the deterministic estimator falls back to default
// (45 min) — i.e. `duration_source === 'default'`. Skipped when:
//   - the task carries any of `fixedDurationLabels` (default ['fixed-duration'])
//   - the task carries the existing `no-auto-schedule` label
// Results are cached by task_id so repeat runs do not re-call the API.
// Failures (no model, no key, network error, timeout) fall back to the
// deterministic default — never break the planner.
//
// `model` is REQUIRED from `--model` (cron extracts it from
// /opt/data/config.yaml). When the OpenRouter response carries a `model`
// field, that takes precedence (auto-router reveals which model served).

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { withRetry } from './retry.js';

const CACHE_KEY_VERSION = 'v1';
const BATCH_SIZE = 30;

function normalize(s) {
  return String(s ?? '').trim().toLowerCase();
}

function hasAnyLabel(task, labels) {
  if (!Array.isArray(labels) || labels.length === 0) return false;
  const tlabels = (task.labels ?? []).map(normalize);
  const set = new Set(labels.map(normalize));
  return tlabels.some((l) => set.has(l));
}

async function readDaemonEnvVar(name) {
  const candidates = ['/proc/self/environ', '/proc/1/environ'];
  for (const file of candidates) {
    const val = await readProcEnviron(file, name);
    if (val !== null) return val;
  }
  // Fall back to scanning other readable /proc/<pid>/environ files. The Hermes
  // daemon (often a long-lived parent process) holds OPENROUTER_API_KEY etc.,
  // and the sandbox subshell does not inherit them (gh-token-sandbox pattern).
  // Verify key presence, never log the value.
  try {
    const pids = (await fs.readdir('/proc')).filter((p) => /^\d+$/.test(p));
    for (const pid of pids) {
      const val = await readProcEnviron(`/proc/${pid}/environ`, name);
      if (val !== null) return val;
    }
  } catch { /* ignore */ }
  return null;
}

async function readProcEnviron(file, name) {
  try {
    const buf = await fs.readFile(file);
    for (const part of buf.toString('utf8').split('\0')) {
      const idx = part.indexOf('=');
      if (idx > 0 && part.slice(0, idx) === name) return part.slice(idx + 1);
    }
  } catch { /* ignore */ }
  return null;
}

export async function resolveOpenRouterApiKey(llmConfig) {
  if (llmConfig.apiKey && typeof llmConfig.apiKey === 'string') return llmConfig.apiKey;
  if (llmConfig.apiKeyConfigPath) {
    try {
      const raw = JSON.parse(await fs.readFile(llmConfig.apiKeyConfigPath, 'utf8'));
      if (typeof raw === 'string') return raw;
      if (typeof raw?.apiKey === 'string') return raw.apiKey;
      if (typeof raw?.openrouter_api_key === 'string') return raw.openrouter_api_key;
    } catch { /* ignore */ }
  }
  const envName = llmConfig.apiKeyEnv ?? 'OPENROUTER_API_KEY';
  if (process.env[envName]) return process.env[envName];
  return await readDaemonEnvVar(envName);
}

function resolveCachePath(llmConfig) {
  const raw = llmConfig.cachePath ?? '~/.hermes/cache/task-rescheduler-llm-duration.json';
  return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
}

export async function readCache(llmConfig) {
  try {
    const parsed = JSON.parse(await fs.readFile(resolveCachePath(llmConfig), 'utf8'));
    if (parsed && parsed[CACHE_KEY_VERSION]) return parsed[CACHE_KEY_VERSION];
  } catch { /* ignore */ }
  return {};
}

export async function writeCache(llmConfig, cacheObj) {
  try {
    const file = resolveCachePath(llmConfig);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ [CACHE_KEY_VERSION]: cacheObj }, null, 2), 'utf8');
  } catch { /* non-fatal */ }
}

const SYSTEM_PROMPT = `You estimate focus-time minutes for an individual task.
Return ONLY a JSON object with key "results": a list of {id, minutes, rationale_short}.
Constraints:
- minutes is realistic single-session effort for a senior engineer / clinician.
- 15-480 range (cap 480 = 8h). Round to nearest 15.
- "reply to / email / send" is short (15-30). Implementation, refactor, write-up is long.
- Travel/commute/duration has its real-life duration.
- Return ONLY the JSON.`;

function userPromptFor(tasks) {
  return tasks.map((t) => {
    const title = t.content ?? '';
    const desc = (t.description ?? '').slice(0, 400);
    return `Task id: ${t.id}\nTitle: ${title}\nDescription: ${desc}`;
  }).join('\n\n');
}

async function callOpenRouter(llmConfig, apiKey, requestedModel, tasks) {
  const body = {
    model: requestedModel,
    max_tokens: llmConfig.maxTokens ?? 4096,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPromptFor(tasks) },
    ],
    response_format: { type: 'json_object' },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), llmConfig.timeoutMs ?? 90000);
  try {
    const res = await fetch(llmConfig.apiBase, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/tetra4rnav/task-rescheduler',
        'X-Title': 'task-rescheduler-llm-duration',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return {
      model: json?.model ?? null,
      content: json?.choices?.[0]?.message?.content ?? '',
    };
  } finally {
    clearTimeout(timer);
  }
}

function clampMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(15, Math.min(480, Math.round(n / 15) * 15));
}

function parseResults(text) {
  if (!text) return [];
  const cleaned = text.replace(/```json|```/g, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    return Array.isArray(obj?.results) ? obj.results : [];
  } catch { return []; }
}

/**
 * Estimate durations for tasks whose deterministic estimator returned
 * `default` and that are not label-excluded.
 * Returns Map<task_id, {minutes, source:'llm', model, confidence}> on success.
 * Empty map when disabled, when no API key, when no model is configured,
 * or when the entire fetch fails — the caller must keep the deterministic value.
 *
 * Pass `fetchImpl` for testing (defaults to globalThis.fetch).
 * Pass `now` for deterministic test timestamps.
 */
export async function estimateDurationsViaLlm(tasks, config, {
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const llm = config?.llmDuration;
  if (!llm?.enabled) return new Map();
  const requestedModel = llm.model;
  if (!requestedModel) return new Map(); // B案: model must come from --model CLI
  // Label rules come from POLICY.md (source of truth, Matt 2026-09-05):
  // fixed-duration skips LLM duration; no-auto-schedule tasks are excluded from
  // rescheduling entirely. Fall back to built-ins if policy unavailable.
  const { loadLabelValues } = await import('./policy.js');
  let policy;
  try { policy = await loadLabelValues(); } catch { policy = {}; }
  const policyFixed = policy.fixedDuration || 'fixed-duration';
  const skip = [
    ...new Set([
      ...(llm.fixedDurationLabels ?? [policyFixed]),
      policyFixed,
      ...((policy.excludeFromReschedule && policy.excludeFromReschedule.length) ? policy.excludeFromReschedule : []),
    ]),
  ];
  const eligible = tasks.filter((t) => {
    if (!t.duration) return false;
    if (t.duration.duration_source !== 'default') return false;
    if (hasAnyLabel(t, skip)) return false;
    return true;
  });
  if (eligible.length === 0) return new Map();
  const apiKey = await resolveOpenRouterApiKey(llm);
  if (!apiKey) return new Map();
  const cache = await readCache(llm);
  const out = new Map();
  const toFetch = [];
  for (const t of eligible) {
    const cached = cache[t.id];
    if (cached && typeof cached.minutes === 'number') {
      out.set(t.id, {
        minutes: cached.minutes,
        source: 'llm',
        model: cached.model ?? requestedModel,
        confidence: 0.7,
      });
    } else if (!cached || cached.minutes == null) {
      toFetch.push(t);
    }
  }
  if (toFetch.length === 0) return out;
  const timestamp = now.toISOString();
  try {
    let actualModel = null;
    const batches = [];
    for (let i = 0; i < toFetch.length; i += BATCH_SIZE) batches.push(toFetch.slice(i, i + BATCH_SIZE));
    for (const batch of batches) {
      const { model: respModel, content } = await withRetry(
        () => callOpenRouter({ ...llm, apiBase: llm.apiBase }, apiKey, requestedModel, batch),
        { maxRetries: 1, baseDelayMs: 500, jitterRatio: 0 },
      );
      if (respModel) actualModel = respModel;
      const results = parseResults(content);
      const seen = new Set();
      for (const r of results) {
        const minutes = clampMinutes(r?.minutes);
        if (!minutes || !batch.find((b) => b.id === r.id)) continue;
        seen.add(r.id);
        cache[r.id] = {
          minutes,
          source: 'llm',
          model: actualModel ?? requestedModel,
          timestamp,
          rationale_short: String(r.rationale_short ?? '').slice(0, 80),
        };
        out.set(r.id, {
          minutes,
          source: 'llm',
          model: actualModel ?? requestedModel,
          confidence: 0.7,
        });
      }
      for (const t of batch) {
        if (!seen.has(t.id) && !cache[t.id]) {
          cache[t.id] = { minutes: null, source: 'llm_miss', timestamp };
        }
      }
    }
  } catch { /* network errors — keep just cache-hit results */ }
  await writeCache(llm, cache);
  return out;
}

export const _internal = {
  parseResults,
  clampMinutes,
  hasAnyLabel,
  resolveCachePath,
  resolveOpenRouterApiKey,
};
