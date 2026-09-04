const PARTS_FORMATTERS = new Map();

function getFormatter(timeZone, withSeconds = true) {
  const key = `${timeZone}:${withSeconds}`;
  if (!PARTS_FORMATTERS.has(key)) {
    PARTS_FORMATTERS.set(
      key,
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: withSeconds ? '2-digit' : undefined,
      }),
    );
  }
  return PARTS_FORMATTERS.get(key);
}

export function dateToParts(date, timeZone, withSeconds = true) {
  const parts = getFormatter(timeZone, withSeconds).formatToParts(date);
  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour ?? 0),
    minute: Number(values.minute ?? 0),
    second: Number(values.second ?? 0),
  };
}

export function getOffsetMs(date, timeZone) {
  const parts = dateToParts(date, timeZone);
  const reconstructedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return reconstructedUtc - date.getTime();
}

export function zonedDateTimeToUtc(dateString, timeString, timeZone) {
  const [year, month, day] = dateString.split('-').map(Number);
  const [hour, minute, second = 0] = timeString.split(':').map(Number);
  const seed = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = seed;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offset = getOffsetMs(new Date(guess), timeZone);
    const adjusted = seed - offset;
    if (adjusted === guess) break;
    guess = adjusted;
  }
  return new Date(guess);
}

export function formatDateInTimeZone(date, timeZone) {
  const parts = dateToParts(new Date(date), timeZone, false);
  return `${parts.year.toString().padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function formatTimeInTimeZone(date, timeZone) {
  const parts = dateToParts(new Date(date), timeZone);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export function formatRfc3339InTimeZone(date, timeZone) {
  const parts = dateToParts(new Date(date), timeZone);
  const offsetMinutes = Math.round(getOffsetMs(new Date(date), timeZone) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const offsetHour = String(Math.floor(abs / 60)).padStart(2, '0');
  const offsetMinute = String(abs % 60).padStart(2, '0');
  return `${parts.year.toString().padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}${sign}${offsetHour}:${offsetMinute}`;
}

export function toUtcRfc3339(date) {
  if (!date) return null;
  return new Date(date).toISOString().replace('.000Z', 'Z');
}

export function addMinutes(date, minutes) {
  return new Date(new Date(date).getTime() + minutes * 60_000);
}

export function addDaysToDateString(dateString, days) {
  const utc = new Date(`${dateString}T00:00:00Z`);
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

export function compareDates(a, b) {
  return new Date(a).getTime() - new Date(b).getTime();
}

export function clampInterval(interval, range) {
  const start = new Date(Math.max(interval.start.getTime(), range.start.getTime()));
  const end = new Date(Math.min(interval.end.getTime(), range.end.getTime()));
  if (end <= start) return null;
  return { start, end };
}

export function mergeIntervals(intervals) {
  const sorted = [...intervals]
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (sorted.length === 0) return [];
  const merged = [sorted[0]];
  for (const current of sorted.slice(1)) {
    const last = merged.at(-1);
    if (current.start <= last.end) {
      if (current.end > last.end) {
        last.end = current.end;
      }
      continue;
    }
    merged.push({ start: new Date(current.start), end: new Date(current.end) });
  }
  return merged;
}

export function subtractIntervals(base, busyIntervals) {
  const mergedBusy = mergeIntervals(busyIntervals.map((interval) => ({ start: new Date(interval.start), end: new Date(interval.end) })));
  const free = [];
  let cursor = new Date(base.start);
  for (const busy of mergedBusy) {
    if (busy.end <= cursor) continue;
    if (busy.start > cursor) {
      free.push({ start: new Date(cursor), end: new Date(Math.min(busy.start.getTime(), base.end.getTime())) });
    }
    if (busy.end > cursor) {
      cursor = new Date(Math.max(cursor.getTime(), busy.end.getTime()));
    }
    if (cursor >= base.end) break;
  }
  if (cursor < base.end) {
    free.push({ start: new Date(cursor), end: new Date(base.end) });
  }
  return free.filter((interval) => interval.end > interval.start);
}

export function minutesBetween(start, end) {
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000);
}

export function isSameDateInTimeZone(left, right, timeZone) {
  return formatDateInTimeZone(left, timeZone) === formatDateInTimeZone(right, timeZone);
}

export function endOfDay(dateString, timeZone) {
  return zonedDateTimeToUtc(addDaysToDateString(dateString, 1), '00:00:00', timeZone);
}

export function startOfDay(dateString, timeZone) {
  return zonedDateTimeToUtc(dateString, '00:00:00', timeZone);
}
