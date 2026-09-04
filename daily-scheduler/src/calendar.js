import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { ApiError, AuthError } from './errors.js';
import { readJsonFile } from './util.js';

const execFile = promisify(execFileCallback);

// Path resolution for the google-workspace CLI wrapper that replaces `gog`.
// The google-workspace skill ships `scripts/google_api.py` (a Python CLI)
// which read/writes Google Calendar via OAuth. We invoke it in read-only
// mode; Calendar WRITE operations are intentionally removed (see Git log /
// Matt 2026-09-05 directive: "google calendar は書き込み機能を削除して読み込みのみにする").
const GOOGLE_API_SCRIPT = process.env.GOOGLE_API_SCRIPT
  ?? '/opt/data/skills/productivity/google-workspace/scripts/google_api.py';
const GOOGLE_API_PYTHON = process.env.GOOGLE_API_PYTHON
  ?? '/opt/data/home/.hermes/venvs/google-workspace/bin/python3';

function unwrapCalendarList(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.results)) return body.results;
  if (Array.isArray(body?.events)) return body.events;
  return [];
}

function buildGoogleError(error, stderr) {
  const combined = `${stderr ?? ''} ${error?.message ?? ''}`.trim();
  if (/unauth|oauth|token|credential|Not authenticated/i.test(combined)) {
    return new AuthError('google calendar authentication failed', { stderr: combined });
  }
  return new ApiError('google_api calendar command failed', { stderr: combined, exitCode: error?.code, message: error?.message });
}

export class GoogleCalendarClient {
  constructor({ logger, execFileImpl = execFile } = {}) {
    this.logger = logger;
    this.execFileImpl = execFileImpl;
    this.script = GOOGLE_API_SCRIPT;
    this.python = GOOGLE_API_PYTHON;
  }

  async run(args) {
    this.logger?.debug?.('running google_api.py calendar', { args });
    try {
      const { stdout } = await this.execFileImpl(this.python, [this.script, ...args], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env },
      });
      return stdout.trim() ? JSON.parse(stdout) : [];
    } catch (error) {
      throw buildGoogleError(error, error?.stderr);
    }
  }

  async listEvents({ calendarIds, from, to, managedBy } = {}) {
    const results = [];
    for (const calendarId of calendarIds) {
      const args = ['calendar', 'list', '--start', from, '--end', to, '--calendar', calendarId, '--max', '2500'];
      if (managedBy) {
        // google_api.py does not support a managedBy private-property filter;
        // managedBy filtering happens in the planner via `isBusyCalendarEvent`.
        this.logger?.warn?.('managedBy filter is not supported by google_api.py; ignoring');
      }
      const body = await this.run(args);
      for (const event of unwrapCalendarList(body)) {
        results.push({ ...event, calendarId });
      }
    }
    return results;
  }
}

export function loadCalendarFixture(filePath) {
  return readJsonFile(filePath).then((data) =>
    Array.isArray(data) ? data : data.events ?? data.results ?? []
  );
}