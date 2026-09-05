import { DESCRIPTION_MARKER_KEY, MANAGED_BY } from './constants.js';
import { sha256 } from './util.js';

// NOTE: buildManagedDescription / buildPrivateProperties were removed
// (2026-09-05) — Calendar WRITE is gone; these produced field payloads for
// calendar events that are no longer created/updated.

export function buildIdempotencyKey({ taskId, start, end, plannerVersion }) {
  return sha256(`${taskId}|${start}|${end}|${plannerVersion}`);
}

export function extractManagedTaskId(event) {
  const privateProps = event?.extendedProperties?.private ?? event?.privateProperties ?? {};
  if (privateProps.todoistTaskId) return String(privateProps.todoistTaskId);
  const description = event?.description ?? '';
  const match = new RegExp(`${DESCRIPTION_MARKER_KEY}=([^\\s]+)`).exec(description);
  return match?.[1] ? String(match[1]) : null;
}

export function isManagedEvent(event) {
  const privateProps = event?.extendedProperties?.private ?? event?.privateProperties ?? {};
  if (privateProps.managedBy === MANAGED_BY) return true;
  return extractManagedTaskId(event) !== null;
}
