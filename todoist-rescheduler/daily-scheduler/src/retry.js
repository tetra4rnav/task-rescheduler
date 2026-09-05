import { DEFAULT_MAX_RETRIES, DEFAULT_MAX_RETRY_AFTER_MS } from './constants.js';
import { ApiError, AuthError } from './errors.js';

export function parseRetryAfterMs(headerValue, capMs = DEFAULT_MAX_RETRY_AFTER_MS) {
  if (!headerValue) return null;
  const asNumber = Number(headerValue);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.min(asNumber * 1000, capMs);
  }
  const asDate = Date.parse(headerValue);
  if (Number.isFinite(asDate)) {
    return Math.min(Math.max(0, asDate - Date.now()), capMs);
  }
  return null;
}

export async function withRetry(operation, {
  maxRetries = DEFAULT_MAX_RETRIES,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger,
} = {}) {
  let attempt = 0;
  let lastError;
  while (attempt <= maxRetries) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const status = error?.status ?? error?.meta?.status;
      if (status === 401 || status === 403) {
        throw new AuthError(error.message, error.meta ?? { status });
      }
      if (status !== 429 || attempt === maxRetries) {
        throw error;
      }
      const waitMs = parseRetryAfterMs(error?.meta?.retryAfter ?? error?.retryAfter) ?? Math.min(1000 * (2 ** attempt), 10_000);
      logger?.warn?.('rate limited, retrying', { attempt, waitMs });
      await sleep(waitMs);
      attempt += 1;
    }
  }
  throw lastError ?? new ApiError('retry loop exhausted');
}
