const SENSITIVE_PATTERNS = [
  /(Authorization\s*:\s*Bearer\s+)[^\s]+/gi,
  /(Bearer\s+)[A-Za-z0-9._~-]+/g,
  /(TODOIST_API_TOKEN\s*=\s*)[^\s]+/g,
  /(access_token\s*[=:]\s*)[^\s,]+/gi,
  /(refresh_token\s*[=:]\s*)[^\s,]+/gi,
  /(client_secret\s*[=:]\s*)[^\s,]+/gi,
  /(password\s*[=:]\s*)[^\s,]+/gi,
];

export function redactSecrets(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const pattern of SENSITIVE_PATTERNS) {
    text = text.replace(pattern, '$1[REDACTED]');
  }
  return text;
}

export function createLogger({ runId, verbose = false, stderr = process.stderr } = {}) {
  const write = (level, message, meta) => {
    const payload = meta === undefined ? '' : ` ${redactSecrets(meta)}`;
    stderr.write(`[${runId ?? 'run'}] ${level.toUpperCase()} ${redactSecrets(message)}${payload}\n`);
  };

  return {
    info(message, meta) {
      write('info', message, meta);
    },
    warn(message, meta) {
      write('warn', message, meta);
    },
    error(message, meta) {
      write('error', message, meta);
    },
    debug(message, meta) {
      if (verbose) write('debug', message, meta);
    },
  };
}
