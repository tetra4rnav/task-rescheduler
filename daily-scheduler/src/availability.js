import { addDaysToDateString, addMinutes, clampInterval, mergeIntervals, minutesBetween, subtractIntervals, zonedDateTimeToUtc } from './time.js';
import { parseWindow } from './util.js';

export function buildPlanningWindow({ startDate, days, timezone, workingHours, lunchHours, now, prepMinutes }) {
  const work = parseWindow(workingHours);
  const lunch = parseWindow(lunchHours);
  const dayWindows = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDaysToDateString(startDate, offset);
    const workStart = zonedDateTimeToUtc(date, `${work.start}:00`, timezone);
    const workEnd = zonedDateTimeToUtc(date, `${work.end}:00`, timezone);
    let effectiveStart = workStart;
    const prepReady = addMinutes(now, prepMinutes);
    if (prepReady > effectiveStart && prepReady < workEnd) {
      effectiveStart = prepReady;
    }
    if (offset > 0) {
      effectiveStart = workStart;
    }
    const base = { date, start: effectiveStart, end: workEnd };
    const blocked = [];
    if (lunch) {
      blocked.push({
        start: zonedDateTimeToUtc(date, `${lunch.start}:00`, timezone),
        end: zonedDateTimeToUtc(date, `${lunch.end}:00`, timezone),
        type: 'lunch',
      });
    }
    dayWindows.push({
      date,
      base,
      workStart,
      workEnd,
      blocked,
    });
  }
  return dayWindows;
}

export function buildBusyIntervals(events, window) {
  const range = {
    start: window[0]?.workStart,
    end: window.at(-1)?.workEnd,
  };
  return mergeIntervals(
    events
      .map((event) => clampInterval(event, range))
      .filter(Boolean),
  );
}

export function findSlot({
  durationMinutes,
  deadline,
  dayWindows,
  baseBusyIntervals,
  scheduledIntervals,
  dailyAllocatedMinutes,
  maxDailyMinutes,
  breakMinutes,
  projectName = null,
  projectDailyAllocatedMinutes = new Map(),
  projectDailyCapacityMinutes = {},
  earliestStartTime = null,
  fixedStartTime = null,
}) {
  const scheduledBusy = scheduledIntervals.map((interval) => ({
    start: interval.start,
    end: addMinutes(interval.end, breakMinutes),
  })).sort((a, b) => a.start - b.start);

  for (const day of dayWindows) {
    if ((dailyAllocatedMinutes.get(day.date) ?? 0) + durationMinutes > maxDailyMinutes) continue;
    const projectLimit = projectDailyCapacityMinutes[projectName ?? ''];
    const projectDayKey = `${projectName ?? ''}\u0000${day.date}`;
    if (Number.isFinite(projectLimit)
      && (projectDailyAllocatedMinutes.get(projectDayKey) ?? 0) + durationMinutes > projectLimit) continue;
    const free = subtractIntervals(day.base, [
      ...day.blocked,
      ...baseBusyIntervals,
      ...scheduledBusy,
    ]);
    for (const slot of free) {
      let candidateStart = slot.start;
      if (earliestStartTime) {
        const earliest = new Date(earliestStartTime);
        if (candidateStart < earliest) candidateStart = earliest;
      }
      if (fixedStartTime) {
        const fixed = new Date(fixedStartTime);
        if (fixed < slot.start || fixed > slot.end) continue;
        candidateStart = fixed;
      }
      const candidateEnd = addMinutes(candidateStart, durationMinutes);
      if (candidateEnd > slot.end) continue;
      if (deadline && candidateEnd > deadline) continue;
      return { date: day.date, start: candidateStart, end: candidateEnd };
    }
  }
  return null;
}

export function registerScheduledInterval(
  scheduledIntervals,
  dailyAllocatedMinutes,
  slot,
  { projectName = null, projectDailyAllocatedMinutes = new Map() } = {},
) {
  const minutes = minutesBetween(slot.start, slot.end);
  scheduledIntervals.push({ start: slot.start, end: slot.end });
  dailyAllocatedMinutes.set(slot.date, (dailyAllocatedMinutes.get(slot.date) ?? 0) + minutes);
  const projectDayKey = `${projectName ?? ''}\u0000${slot.date}`;
  projectDailyAllocatedMinutes.set(projectDayKey, (projectDailyAllocatedMinutes.get(projectDayKey) ?? 0) + minutes);
}
