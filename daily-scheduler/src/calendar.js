import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { ApiError, AuthError } from './errors.js';
import { pickDefined, readJsonFile } from './util.js';

const execFile = promisify(execFileCallback);

function unwrapCalendarList(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.results)) return body.results;
  if (Array.isArray(body?.events)) return body.events;
  return [];
}

function buildGogError(error, stderr) {
  const combined = `${stderr ?? ''} ${error?.message ?? ''}`.trim();
  if (/unauth|oauth|token|credential/i.test(combined)) {
    return new AuthError('gog calendar authentication failed', { stderr: combined });
  }
  return new ApiError('gog calendar command failed', { stderr: combined, exitCode: error?.code });
}

export class GogCalendarClient {
  constructor({ account, logger, execFileImpl = execFile } = {}) {
    this.account = account;
    this.logger = logger;
    this.execFileImpl = execFileImpl;
  }

  async run(args) {
    const baseArgs = ['calendar', ...args, '--json', '--results-only', '--no-input'];
    if (this.account) {
      baseArgs.push('--account', this.account);
    }
    this.logger?.debug?.('running gog command', { args: baseArgs.filter((value) => value !== this.account) });
    try {
      const { stdout } = await this.execFileImpl('gog', baseArgs, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      return stdout.trim() ? JSON.parse(stdout) : [];
    } catch (error) {
      throw buildGogError(error, error?.stderr);
    }
  }

  async listEvents({ calendarIds, from, to, managedBy } = {}) {
    const results = [];
    for (const calendarId of calendarIds) {
      const args = ['events', calendarId, '--from', from, '--to', to, '--all-pages', '--max', '2500'];
      if (managedBy) {
        args.push('--private-prop-filter', `managedBy=${managedBy}`);
      }
      const body = await this.run(args);
      for (const event of unwrapCalendarList(body)) {
        results.push({ ...event, calendarId });
      }
    }
    return results;
  }

  async createEvent(calendarId, event) {
    const args = [
      'create',
      calendarId,
      '--summary', event.summary,
      '--from', event.start,
      '--to', event.end,
      '--timezone', event.timezone,
      '--description', event.description,
      '--transparency', 'opaque',
    ];
    for (const [key, value] of Object.entries(event.privateProperties ?? {})) {
      args.push('--private-prop', `${key}=${value}`);
    }
    return this.run(args);
  }

  async updateEvent(calendarId, eventId, event) {
    const args = [
      'update',
      calendarId,
      eventId,
      '--summary', event.summary,
      '--from', event.start,
      '--to', event.end,
      '--description', event.description,
    ];
    for (const [key, value] of Object.entries(event.privateProperties ?? {})) {
      args.push('--private-prop', `${key}=${value}`);
    }
    return this.run(args);
  }
}

export async function loadCalendarFixture(filePath) {
  const data = await readJsonFile(filePath);
  return Array.isArray(data) ? data : data.events ?? data.results ?? [];
}

export function buildManagedEventPayload(operation, timezone) {
  return pickDefined({
    summary: operation.desired_summary,
    description: operation.desired_description,
    privateProperties: operation.desired_private_properties,
    start: operation.start,
    end: operation.end,
    timezone,
  });
}
