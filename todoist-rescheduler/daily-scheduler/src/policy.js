// POLICY.md loader — the single source of truth for reschedule policy.
//
// Reads the human/machine-readable policy file at repo/todoist-rescheduler/
// POLICY.md and parses the YAML front-matter `labels:` block. That block is
// the authoritative definition for label rules (exclude-from-reschedule,
// assignment marker, planner version prefix, fixed-duration). The rest of the
// markdown is human/LLM narrative.
//
// Why: `no-auto-schedule` etc. used to be hard-coded in constants.js and
// llm_duration.js. They now live in POLICY.md (Matt 2026-09-05).

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default: repo_root/todoist-rescheduler/POLICY.md, walking up from this module
// (daily-scheduler/src/policy.js) → ../.. = todoist-rescheduler/, then POLICY.md.
export function defaultPolicyPath() {
  return path.resolve(__dirname, '..', '..', 'POLICY.md');
}

// Test hook + override.
export function resolvePolicyPath(policyPath = process.env.TASK_RESCHEDULER_POLICY || defaultPolicyPath()) {
  return policyPath;
}

function parseLabels(frontMatter) {
  // frontMatter is the text between '---' lines. We only need the labels block.
  const labels = {};
  const lines = frontMatter.split('\n');
  let inLabels = false;
  let arrayKey = null; // current key collecting a block-style list (e.g. exclude_from_reschedule:)
  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();
    if (!inLabels) {
      if (/^labels:$/.test(trimmed)) { inLabels = true; }
      continue;
    }
    if (trimmed === '') continue;
    // A list block item under the current array key:   - <value>  (# comment)
    if (arrayKey && /^-\s+(.+?)\s*(#.*)?$/.test(line.trim())) {
      const item = line.trim().replace(/^-\s+/, '').split('#')[0].trim();
      if (item) {
        labels[arrayKey] = (labels[arrayKey] || []).concat(item);
      }
      continue;
    }
    // block list under a header key:  key:   (then following - lines)
    const listKey = /^\s{2,}(\S+?):\s*$/.exec(line);
    if (listKey) {
      arrayKey = listKey[1].trim();
      labels[arrayKey] = labels[arrayKey] || [];
      continue;
    }
    arrayKey = null;
    // labeled item:   - <key>: <value>
    const labeledItem = /^\s{2}-\s+(.+?):\s*(.*)$/.exec(line);
    if (labeledItem) {
      labels[labeledItem[1].trim()] = labeledItem[2].trim();
      continue;
    }
    // scalar under labels: key: value
    const kv = /^\s{2,}(\S+?):\s*(.*)$/.exec(line);
    if (kv) { labels[kv[1].trim()] = kv[2].trim(); continue; }
    // anything else (new top-level key / heading) ends the labels block
    if (!line.startsWith(' ')) inLabels = false;
  }
  return labels;
}

/** Parse YAML front-matter (`--- ... ---`) and return { labels: {...} }. */
export function parsePolicyMarkdown(text) {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  if (!m) return { labels: {} };
  return { labels: parseLabels(m[1]) };
}

function normalizeLabelList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'object' && v !== null) return Object.values(v);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  if (typeof v === 'undefined') return [];
  return [];
}
function firstString(v) {
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

export async function loadLabels({ policyPath } = {}) {
  const p = resolvePolicyPath(policyPath);
  try {
    const text = await fs.readFile(p, 'utf8');
    const { labels } = parsePolicyMarkdown(text);
    return labels || {};
  } catch (err) {
    // POLICY.md missing → built-in defaults so the pipeline never breaks.
    return {
      exclude_from_reschedule: ['no-auto-schedule'],
      assignment_marker: 'task-rescheduler-assigned',
      planner_version_prefix: 'task-rescheduler-planner-v',
      fixed_duration: 'fixed-duration',
    };
  }
}

/** Concrete, planner-ready label values. */
export async function loadLabelValues({ policyPath } = {}) {
  const labels = await loadLabels({ policyPath });
  return {
    excludeFromReschedule: normalizeLabelList(labels.exclude_from_reschedule),
    assignmentMarker: firstString(labels.assignment_marker),
    plannerVersionPrefix: firstString(labels.planner_version_prefix),
    fixedDuration: firstString(labels.fixed_duration),
  };
}