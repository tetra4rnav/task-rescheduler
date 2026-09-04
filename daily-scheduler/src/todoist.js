import { URL } from 'node:url';
import { DEFAULT_PAGE_SIZE, TODOIST_API_BASE_URL } from './constants.js';
import { ApiError, AuthError } from './errors.js';
import { withRetry } from './retry.js';
import { pickDefined, readJsonFile } from './util.js';

function parseNextLinkHeader(linkHeader) {
  if (!linkHeader) return null;
  for (const part of String(linkHeader).split(',')) {
    const match = /<([^>]+)>;\s*rel="?next"?/i.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}

function unwrapList(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.results)) return body.results;
  if (Array.isArray(body?.tasks)) return body.tasks;
  if (Array.isArray(body?.items)) return body.items;
  if (Array.isArray(body?.projects)) return body.projects;
  return [];
}

async function parseResponse(response) {
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (response.ok) {
    return { body: json ?? text, headers: response.headers };
  }
  const meta = {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    body: json ?? text,
  };
  if (response.status === 401 || response.status === 403) {
    throw new AuthError('Todoist authentication failed', meta);
  }
  throw new ApiError(`Todoist API request failed with status ${response.status}`, meta);
}

export class TodoistClient {
  constructor({
    token = process.env.TODOIST_API_TOKEN,
    baseUrl = TODOIST_API_BASE_URL,
    fetchImpl = globalThis.fetch,
    sleep,
    logger,
  } = {}) {
    this.token = token;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.logger = logger;
  }

  ensureToken() {
    if (!this.token) {
      throw new AuthError('Missing TODOIST_API_TOKEN environment variable');
    }
  }

  async request(method, pathOrUrl, { query = {}, body } = {}) {
    this.ensureToken();
    const url = pathOrUrl.startsWith('http')
      ? new URL(pathOrUrl)
      : new URL(pathOrUrl.replace(/^\//, ''), `${this.baseUrl.replace(/\/$/, '')}/`);
    for (const [key, value] of Object.entries(query)) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    return withRetry(async () => {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return parseResponse(response);
    }, { sleep: this.sleep, logger: this.logger });
  }

  async paginate(path, { query = {} } = {}) {
    let nextUrl = path;
    let nextQuery = { limit: DEFAULT_PAGE_SIZE, ...query };
    const items = [];
    let pageGuard = 0;
    while (nextUrl && pageGuard < 100) {
      pageGuard += 1;
      const { body, headers } = await this.request('GET', nextUrl, { query: nextQuery });
      items.push(...unwrapList(body));
      const cursor = body?.next_cursor ?? body?.nextCursor ?? body?.next_page_token ?? body?.nextPageToken;
      const nextPageUrl = body?.next_page_url ?? body?.nextPageUrl ?? parseNextLinkHeader(headers.get('link'));
      if (nextPageUrl) {
        nextUrl = nextPageUrl;
        nextQuery = {};
      } else if (cursor) {
        nextUrl = path;
        nextQuery = { ...query, limit: DEFAULT_PAGE_SIZE, cursor };
      } else if (body?.has_more === true && body?.page) {
        nextUrl = path;
        nextQuery = { ...query, limit: DEFAULT_PAGE_SIZE, page: Number(body.page) + 1 };
      } else {
        nextUrl = null;
      }
    }
    return items;
  }

  async listIncompleteTasks() {
    return this.paginate('/tasks');
  }

  async listProjects() {
    return this.paginate('/projects');
  }

  async updateTaskDue(taskId, payload) {
    const { body } = await this.request('POST', `/tasks/${taskId}`, {
      body: pickDefined(payload),
    });
    return body;
  }

  async updateTask(taskId, payload) {
    const { body } = await this.request('POST', `/tasks/${taskId}`, {
      body: pickDefined(payload),
    });
    return body;
  }
}

export async function loadTodoistFixture(filePath) {
  const data = await readJsonFile(filePath);
  return Array.isArray(data) ? data : data.tasks ?? data.results ?? [];
}
