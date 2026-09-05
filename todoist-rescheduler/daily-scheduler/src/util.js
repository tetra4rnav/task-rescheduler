import crypto from 'node:crypto';
import fs from 'node:fs/promises';

export function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function stableSort(items, comparator) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => comparator(left.item, right.item) || left.index - right.index)
    .map((entry) => entry.item);
}

export function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}

export function ensureArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

export function isoNow(date = new Date()) {
  return new Date(date).toISOString();
}

export function randomRunId() {
  return crypto.randomUUID();
}

export function toInt(value, defaultValue = 0) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export async function readJsonFile(path) {
  const content = await fs.readFile(path, 'utf8');
  return JSON.parse(content);
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function pickDefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

export function compareStrings(a, b) {
  return String(a).localeCompare(String(b), 'en');
}

export function parseTimeOfDay(input) {
  const match = /^(?<hour>\d{2}):(?<minute>\d{2})$/.exec(input);
  if (!match?.groups) return null;
  return { hour: Number(match.groups.hour), minute: Number(match.groups.minute) };
}

export function parseWindow(input) {
  const match = /^(?<start>\d{2}:\d{2})-(?<end>\d{2}:\d{2})$/.exec(input);
  if (!match?.groups) return null;
  return { start: match.groups.start, end: match.groups.end };
}
