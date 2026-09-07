/**
 * Read-only Google Calendar availability via secret iCal (ICS) URLs.
 *
 * No Hermes / gog / google_api.py. Operators share a calendar by copying
 * Calendar settings → Integrate calendar → Secret address in iCal format
 * into GOOGLE_CALENDAR_ICS_URL (or --calendar-ics-url).
 */
import { AuthError, InputError, ApiError } from './errors.js';
import { readJsonFile } from './util.js';

function splitIcsUrls(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => splitIcsUrls(item));
  }
  return String(raw)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function resolveCalendarIcsUrls({ cliUrls, env = process.env } = {}) {
  const fromCli = splitIcsUrls(cliUrls);
  if (fromCli.length) return fromCli;
  return splitIcsUrls(env.GOOGLE_CALENDAR_ICS_URL);
}

/** Unfold RFC 5545 folded lines and normalize newlines. */
export function unfoldIcs(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeIcs(value) {
  return String(value)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseIcsDate(raw, params) {
  const value = raw.trim();
  const isDate = /VALUE=DATE/i.test(params) || (/^\d{8}$/.test(value) && !/T/.test(value));
  if (isDate) {
    const y = value.slice(0, 4);
    const m = value.slice(4, 6);
    const d = value.slice(6, 8);
    return { date: `${y}-${m}-${d}` };
  }
  // 20260308T090000Z or 20260308T090000
  const m = value.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/,
  );
  if (!m) {
    // Fallback: already ISO-ish
    return { dateTime: value };
  }
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? 'Z' : ''}`;
  if (m[7]) return { dateTime: iso };
  const tzid = (params.match(/TZID=([^;:]+)/i) || [])[1];
  // Without a full TZDB we keep a naive offset-less datetime; normalizeCalendarEvent
  // accepts Date.parse which treats local/Z. Prefer appending Z only when UTC.
  if (tzid && /UTC|Etc\/UTC|GMT/i.test(tzid)) {
    return { dateTime: `${iso}Z` };
  }
  // Common Google export with America/New_York uses floating local in the TZID.
  // Attach a fixed -04:00 for EDT fixtures is wrong generally; use the TZID as
  // a hint only when the value has no offset — Date will parse as local.
  // For OSS determinism, treat non-Z as UTC wall-clock of the same digits when
  // no offset is present is incorrect. Instead emit RFC3339 without Z and let
  // normalize use `new Date(dateTime)` which Node treats as local.
  // Better: if TZID looks like America/New_York and fixture uses -04:00, tests
  // use Z or explicit offsets in the ICS fixture.
  return { dateTime: iso };
}

function parseDurationToMs(raw) {
  // PTmHnMnS or PTnH etc.
  const m = String(raw).match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i,
  );
  if (!m) return null;
  const days = Number(m[1] || 0);
  const hours = Number(m[2] || 0);
  const mins = Number(m[3] || 0);
  const secs = Number(m[4] || 0);
  return (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
}

function parsePropLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = left.split(';');
  return {
    name: name.toUpperCase(),
    params: paramParts.join(';'),
    value,
  };
}

/**
 * Parse VEVENT blocks into Google-Calendar-shaped objects for normalizeCalendarEvent.
 * Expands simple RRULE DAILY/WEEKLY within [from, to] when provided.
 */
export function parseIcsEvents(icsText, { calendarId = 'ics', from, to } = {}) {
  const text = unfoldIcs(icsText);
  const events = [];
  const blocks = text.split(/BEGIN:VEVENT/i).slice(1);
  for (const block of blocks) {
    const body = block.split(/END:VEVENT/i)[0] || '';
    const fields = {};
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      const prop = parsePropLine(line);
      if (!prop) continue;
      fields[prop.name] = prop;
    }
    if (!fields.DTSTART) continue;
    const start = parseIcsDate(fields.DTSTART.value, fields.DTSTART.params);
    let end;
    if (fields.DTEND) {
      end = parseIcsDate(fields.DTEND.value, fields.DTEND.params);
    } else if (fields.DURATION) {
      const startMs = Date.parse(start.dateTime || `${start.date}T00:00:00Z`);
      const dur = parseDurationToMs(fields.DURATION.value);
      if (Number.isFinite(startMs) && dur != null) {
        end = { dateTime: new Date(startMs + dur).toISOString() };
      }
    }
    if (!end) continue;

    const statusRaw = (fields.STATUS?.value || 'CONFIRMED').toLowerCase();
    const status = statusRaw === 'cancelled' ? 'cancelled' : 'confirmed';
    const transp = (fields.TRANSP?.value || 'OPAQUE').toUpperCase();
    const transparency = transp === 'TRANSPARENT' ? 'transparent' : 'opaque';
    const summary = unescapeIcs(fields.SUMMARY?.value || '');
    const description = unescapeIcs(fields.DESCRIPTION?.value || '');
    const uid = fields.UID?.value || summary || `evt-${events.length + 1}`;

    const base = {
      id: uid,
      summary,
      description,
      status,
      transparency,
      start,
      end,
      calendarId,
    };

    const rrule = fields.RRULE?.value;
    if (rrule && from && to) {
      events.push(...expandRrule(base, rrule, from, to));
    } else {
      events.push(base);
    }
  }
  return events;
}

function eventStartMs(event) {
  if (event.start?.dateTime) return Date.parse(event.start.dateTime);
  if (event.start?.date) return Date.parse(`${event.start.date}T00:00:00Z`);
  return NaN;
}

function eventEndMs(event) {
  if (event.end?.dateTime) return Date.parse(event.end.dateTime);
  if (event.end?.date) return Date.parse(`${event.end.date}T00:00:00Z`);
  return NaN;
}

function shiftEvent(event, deltaMs) {
  const startMs = eventStartMs(event);
  const endMs = eventEndMs(event);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return event;
  if (event.start.date && event.end.date) {
    const day = 24 * 60 * 60 * 1000;
    const days = Math.round(deltaMs / day);
    const addDays = (iso, n) => {
      const d = new Date(`${iso}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    return {
      ...event,
      id: `${event.id}#${days}`,
      start: { date: addDays(event.start.date, days) },
      end: { date: addDays(event.end.date, days) },
    };
  }
  return {
    ...event,
    id: `${event.id}#${startMs + deltaMs}`,
    start: { dateTime: new Date(startMs + deltaMs).toISOString() },
    end: { dateTime: new Date(endMs + deltaMs).toISOString() },
  };
}

function expandRrule(base, rrule, from, to) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return [base];

  const parts = Object.fromEntries(
    rrule.split(';').map((p) => {
      const [k, v] = p.split('=');
      return [k.toUpperCase(), v];
    }),
  );
  const freq = (parts.FREQ || '').toUpperCase();
  const interval = Math.max(1, Number(parts.INTERVAL || 1));
  const count = parts.COUNT ? Number(parts.COUNT) : Infinity;
  const until = parts.UNTIL
    ? Date.parse(
      parts.UNTIL.length === 8
        ? `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}T23:59:59Z`
        : parseIcsDate(parts.UNTIL, '').dateTime || parts.UNTIL,
    )
    : Infinity;

  let stepMs;
  if (freq === 'DAILY') stepMs = interval * 24 * 60 * 60 * 1000;
  else if (freq === 'WEEKLY') stepMs = interval * 7 * 24 * 60 * 60 * 1000;
  else return [base]; // unsupported FREQ: keep the seed instance only

  const out = [];
  const seedStart = eventStartMs(base);
  if (!Number.isFinite(seedStart)) return [base];
  let i = 0;
  for (let t = seedStart; t <= Math.min(toMs, until) && i < count; t += stepMs, i += 1) {
    const endMs = eventEndMs(base) + (t - seedStart);
    if (endMs < fromMs) continue;
    if (t > toMs) break;
    out.push(shiftEvent(base, t - seedStart));
  }
  return out.length ? out : [];
}

export class GoogleCalendarClient {
  /**
   * @param {{ logger?: object, fetchImpl?: typeof fetch, icsUrls?: string[] }} opts
   */
  constructor({ logger, fetchImpl = globalThis.fetch.bind(globalThis), icsUrls = [] } = {}) {
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.icsUrls = splitIcsUrls(icsUrls);
  }

  async fetchUrl(url) {
    this.logger?.debug?.('fetching calendar ICS', { url: url.replace(/\/private-[^/]+/, '/private-***') });
    let response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: 'text/calendar, text/plain, */*' },
      });
    } catch (error) {
      throw new ApiError('calendar ICS fetch failed', { url, message: error?.message });
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError('calendar ICS URL rejected (check the secret iCal address)', {
        status: response.status,
      });
    }
    if (!response.ok) {
      throw new ApiError('calendar ICS fetch failed', { status: response.status, url });
    }
    return response.text();
  }

  async listEvents({ calendarIds, from, to, icsUrls, managedBy } = {}) {
    if (managedBy) {
      this.logger?.warn?.('managedBy filter is not applied on ICS feeds; ignoring');
    }
    const urls = splitIcsUrls(icsUrls?.length ? icsUrls : this.icsUrls);
    if (!urls.length) {
      throw new InputError(
        'No calendar ICS URL. Set GOOGLE_CALENDAR_ICS_URL or pass --calendar-ics-url '
        + '(Google Calendar → Settings → Integrate calendar → Secret address in iCal format). '
        + 'Or use --calendar-file / --no-calendar.',
      );
    }
    const results = [];
    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i];
      const calendarId = calendarIds?.[i] || calendarIds?.[0] || `ics-${i + 1}`;
      const text = await this.fetchUrl(url);
      results.push(...parseIcsEvents(text, { calendarId, from, to }));
    }
    return results;
  }
}

export function loadCalendarFixture(filePath) {
  return readJsonFile(filePath).then((data) =>
    Array.isArray(data) ? data : data.events ?? data.results ?? []
  );
}

export async function loadCalendarIcsFile(filePath) {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(filePath, 'utf8');
  return parseIcsEvents(text, { calendarId: 'fixture-ics' });
}
