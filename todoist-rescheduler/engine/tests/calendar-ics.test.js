import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import {
  GoogleCalendarClient,
  parseIcsEvents,
  resolveCalendarIcsUrls,
  unfoldIcs,
} from '../src/calendar.js';
import { isBusyCalendarEvent, normalizeCalendarEvent } from '../src/normalize.js';
import { InputError } from '../src/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '../fixtures');

test('resolveCalendarIcsUrls prefers CLI over env', () => {
  assert.deepEqual(
    resolveCalendarIcsUrls({
      cliUrls: ['https://example.com/a.ics'],
      env: { GOOGLE_CALENDAR_ICS_URL: 'https://example.com/b.ics' },
    }),
    ['https://example.com/a.ics'],
  );
  assert.deepEqual(
    resolveCalendarIcsUrls({
      cliUrls: [],
      env: { GOOGLE_CALENDAR_ICS_URL: 'https://a.ics, https://b.ics' },
    }),
    ['https://a.ics', 'https://b.ics'],
  );
});

test('parseIcsEvents matches fixture busy windows', async () => {
  const text = await readFile(path.join(fixturesDir, 'calendar-events.ics'), 'utf8');
  const raw = parseIcsEvents(text, {
    from: '2026-03-08T00:00:00Z',
    to: '2026-03-11T00:00:00Z',
  });
  const events = raw.map((e) => normalizeCalendarEvent(e, {
    calendarId: 'primary',
    timezone: 'UTC',
  }));

  const morning = events.find((e) => e.id === 'evt-01');
  assert.ok(morning);
  assert.equal(morning.start.toISOString(), '2026-03-08T13:00:00.000Z');
  assert.equal(morning.end.toISOString(), '2026-03-08T14:00:00.000Z');
  assert.equal(isBusyCalendarEvent(morning), true);

  const lunch = events.find((e) => e.id === 'evt-04');
  assert.equal(isBusyCalendarEvent(lunch), false);

  const cancelled = events.find((e) => e.id === 'evt-06');
  assert.equal(isBusyCalendarEvent(cancelled), false);

  const allDay = events.find((e) => e.id === 'evt-05');
  assert.equal(allDay.allDay, true);

  const weekly = events.filter((e) => String(e.id).startsWith('evt-weekly'));
  assert.equal(weekly.length, 1, 'only one weekly instance falls in 08–11 Mar window');

  const wider = parseIcsEvents(text, {
    from: '2026-03-08T00:00:00Z',
    to: '2026-03-30T00:00:00Z',
  }).filter((e) => String(e.id).startsWith('evt-weekly'));
  assert.equal(wider.length, 3, `expected COUNT=3 weekly expansion, got ${wider.length}`);
});

test('listEvents fails clearly when ICS URL is missing', async () => {
  const client = new GoogleCalendarClient({ icsUrls: [] });
  await assert.rejects(
    () => client.listEvents({ from: '2026-03-08T00:00:00Z', to: '2026-03-09T00:00:00Z' }),
    (err) => err instanceof InputError && /GOOGLE_CALENDAR_ICS_URL/.test(err.message),
  );
});

test('listEvents fetches ICS via injectable fetch', async () => {
  const ics = await readFile(path.join(fixturesDir, 'calendar-events.ics'), 'utf8');
  const client = new GoogleCalendarClient({
    icsUrls: ['https://calendar.google.com/calendar/ical/private-SECRET/basic.ics'],
    fetchImpl: async (url) => {
      assert.match(url, /basic\.ics$/);
      return {
        ok: true,
        status: 200,
        text: async () => ics,
      };
    },
  });
  const events = await client.listEvents({
    from: '2026-03-08T00:00:00Z',
    to: '2026-03-09T00:00:00Z',
  });
  assert.ok(events.some((e) => e.id === 'evt-01'));
});

test('unfoldIcs joins folded lines', () => {
  const folded = 'SUMMARY:Hello\n  world';
  assert.equal(unfoldIcs(folded), 'SUMMARY:Hello world');
});
