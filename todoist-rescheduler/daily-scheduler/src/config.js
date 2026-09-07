import fs from 'node:fs/promises';
import { DEFAULT_REGISTRY_PATH } from './registry.js';
import {
  DEFAULT_ACCOUNT,
  DEFAULT_CALENDAR_IDS,
  DEFAULT_CONFIG,
  DEFAULT_DAYS,
  DEFAULT_MAX_DAILY_MINUTES,
  DEFAULT_MIN_BREAK_MINUTES,
  DEFAULT_TIMEZONE,
  DEFAULT_TODOIST_TIMEZONE,
  DEFAULT_WORKING_HOURS,
  PLAN_SCHEMA_VERSION,
  PLANNER_VERSION,
  TODOIST_API_BASE_URL,
} from './constants.js';
import { InputError } from './errors.js';
import { deepFreeze, ensureArray, parseWindow, toInt } from './util.js';
import { formatDateInTimeZone } from './time.js';

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    durationRules: {
      ...base.durationRules,
      ...override?.durationRules,
      projects: {
        ...base.durationRules.projects,
        ...override?.durationRules?.projects,
      },
      labels: {
        ...base.durationRules.labels,
        ...override?.durationRules?.labels,
      },
      taskPatterns: override?.durationRules?.taskPatterns ?? base.durationRules.taskPatterns,
    },
    projectWeights: {
      ...base.projectWeights,
      ...override?.projectWeights,
    },
    projectDailyCapacityMinutes: {
      ...base.projectDailyCapacityMinutes,
      ...override?.projectDailyCapacityMinutes,
    },
    scoreWeights: {
      ...base.scoreWeights,
      ...override?.scoreWeights,
      todoistPriority: {
        ...base.scoreWeights.todoistPriority,
        ...override?.scoreWeights?.todoistPriority,
      },
    },
    keywordDurations: override?.keywordDurations ?? base.keywordDurations,
  };
}

function parseBooleanFlag(name, args, index, state, value = true) {
  state[name] = value;
  return index;
}

export async function parseCli(argv, { now = new Date() } = {}) {
  const [maybeCommand, ...rest] = argv;
  const command = maybeCommand && !maybeCommand.startsWith('--') ? maybeCommand : 'run';
  const args = maybeCommand && !maybeCommand.startsWith('--') ? rest : argv;
  const parsed = {
    command,
    mode: command === 'apply' ? 'apply' : 'dry-run',
    json: false,
    verbose: false,
    days: DEFAULT_DAYS,
    timezone: DEFAULT_TIMEZONE,
    todoistTimezone: DEFAULT_TODOIST_TIMEZONE,
    account: DEFAULT_ACCOUNT,
    calendars: [...DEFAULT_CALENDAR_IDS],
    workingHours: DEFAULT_WORKING_HOURS,
    maxDailyMinutes: DEFAULT_MAX_DAILY_MINUTES,
    minBreakMinutes: DEFAULT_MIN_BREAK_MINUTES,
    syncTodoistDue: false,
    todoistOnly: false,
    noCalendar: false,
    todoistApiBaseUrl: TODOIST_API_BASE_URL,
    registryPath: DEFAULT_REGISTRY_PATH,
    config: DEFAULT_CONFIG,
    schemaVersion: PLAN_SCHEMA_VERSION,
    plannerVersion: PLANNER_VERSION,
    approveDeadlineMigrations: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--date':
        parsed.date = args[++index];
        break;
      case '--timezone':
        parsed.timezone = args[++index];
        parsed.todoistTimezone = parsed.timezone;
        break;
      case '--todoist-timezone':
        throw new InputError('--todoist-timezone was removed; use --timezone as the single operational timezone');
      case '--days':
        parsed.days = toInt(args[++index], DEFAULT_DAYS);
        break;
      case '--account':
        parsed.account = args[++index];
        break;
      case '--calendar': {
        const value = args[++index];
        parsed.calendars = value.includes(',') ? value.split(',').map((item) => item.trim()).filter(Boolean) : [value];
        break;
      }
      case '--working-hours':
        parsed.workingHours = args[++index];
        break;
      case '--max-daily-minutes':
        parsed.maxDailyMinutes = toInt(args[++index], DEFAULT_MAX_DAILY_MINUTES);
        break;
      case '--min-break-minutes':
        parsed.minBreakMinutes = toInt(args[++index], DEFAULT_MIN_BREAK_MINUTES);
        break;
      case '--json':
        parseBooleanFlag('json', args, index, parsed);
        break;
      case '--verbose':
        parseBooleanFlag('verbose', args, index, parsed);
        break;
      case '--apply':
        parsed.mode = 'apply';
        break;
      case '--dry-run':
        parsed.mode = 'dry-run';
        break;
      case '--sync-todoist-due':
        parsed.syncTodoistDue = true;
        break;
      case '--todoist-only':
        parsed.todoistOnly = true;
        parsed.syncTodoistDue = true;
        break;
      case '--no-calendar':
        parseBooleanFlag('noCalendar', args, index, parsed);
        break;
      case '--config':
        parsed.configPath = args[++index];
        break;
      case '--todoist-file':
        parsed.todoistFile = args[++index];
        break;
      case '--calendar-file':
        parsed.calendarFile = args[++index];
        break;
      case '--plan-file':
        parsed.planFile = args[++index];
        break;
      case '--registry-path':
        parsed.registryPath = args[++index];
        break;
      case '--placements':
        parsed.placementsFile = args[++index];
        break;
      case '--model':
        parsed.model = args[++index];
        break;
      case '--overrides':
      case '--overrides-file':
        parsed.overridesFile = args[++index];
        break;
      case '--approve-deadline-migrations':
        parsed.approveDeadlineMigrations = true;
        break;
      case '--now':
        parsed.now = args[++index];
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      default:
        throw new InputError(`Unknown argument: ${arg}`);
    }
  }

  if (!parsed.date) {
    parsed.date = formatDateInTimeZone(parsed.now ? new Date(parsed.now) : now, parsed.timezone);
  }

  if (!parseWindow(parsed.workingHours)) {
    throw new InputError(`Invalid --working-hours value: ${parsed.workingHours}`);
  }
  if (parsed.days < 1) throw new InputError('--days must be >= 1');
  if (parsed.maxDailyMinutes < 1) throw new InputError('--max-daily-minutes must be >= 1');
  if (parsed.minBreakMinutes < 0) throw new InputError('--min-break-minutes must be >= 0');

  if (parsed.configPath) {
    const configContent = JSON.parse(await fs.readFile(parsed.configPath, 'utf8'));
    parsed.config = mergeConfig(DEFAULT_CONFIG, configContent);
  }
  // --model CLI overrides llmDuration.model (B案: model from CLI, per 2026-09-05 design).
  // Clone llmDuration to avoid mutating the shared DEFAULT_CONFIG (which is frozen).
  if (parsed.model) {
    const llm = { ...parsed.config.llmDuration };
    llm.enabled = true;
    llm.model = parsed.model;
    parsed.config = { ...parsed.config, llmDuration: Object.freeze(llm) };
  }
  parsed.todoistTimezone = parsed.timezone;

  if (parsed.command === 'run' && parsed.mode !== 'apply') {
    parsed.mode = 'dry-run';
  }
  if (parsed.command === 'plan') {
    parsed.mode = 'dry-run';
  }

  if (parsed.command === 'migrate-deadlines' && parsed.mode === 'apply') {
    if (!parsed.approveDeadlineMigrations || !parsed.planFile) {
      throw new InputError('migrate-deadlines --apply requires --approve-deadline-migrations and --plan-file');
    }
  }

  if (parsed.todoistOnly) {
    parsed.syncTodoistDue = true;
  }

  if (parsed.mode === 'apply' && parsed.command !== 'migrate-deadlines' && !parsed.planFile) {
    throw new InputError('apply mode requires --plan <path> containing a previously generated plan hash to ensure idempotency and drift detection');
  }

  if (parsed.overridesFile) {
    try {
      const overridesContent = await fs.readFile(parsed.overridesFile, 'utf8');
      parsed.overrides = JSON.parse(overridesContent);
    } catch {
      throw new InputError(`Failed to load overrides from ${parsed.overridesFile}`);
    }
  }

  return deepFreeze({
    ...parsed,
    calendars: ensureArray(parsed.calendars),
    config: deepFreeze(parsed.config),
  });
}

export function helpText() {
  return `daily-scheduler <command> [options]\n\nCommands:\n  plan               Generate deterministic plan JSON (dry-run)\n  apply              Generate and apply plan\n  verify             Verify current state against deterministic plan\n  migrate-deadlines  Preview date-only due migration; apply requires an approved plan file\n  dump               Dump analyzed tasks info for LLM interpretation\n  run                plan by default; apply with --apply\n\nOptions:\n  --date YYYY-MM-DD\n  --timezone UTC                  # single operational timezone (Matt 2026-09-04 directive)\n  --days 3\n  --account your-email-at-provider.example\n  --calendar primary[,secondary]\n  --working-hours 10:00-24:00     # full-day window; 24:00 == next day 00:00Z\n  --max-daily-minutes 1440        # formal-only (24h/day) — effectively off\n  --min-break-minutes 15\n  --json\n  --verbose\n  --dry-run\n  --apply\n  --sync-todoist-due\n  --todoist-only     Read Calendar for availability, write scheduled times only to Todoist due datetime
  --no-calendar      Skip Calendar fetch entirely (use for OAuth outages; planner uses working-hours-only windows)\n  --config /path/to/config.json\n  --todoist-file /path/to/tasks.json\n  --calendar-file /path/to/events.json\n  --plan-file /path/to/plan.json\n  --overrides /path/to/overrides.json\n  --approve-deadline-migrations\n  --now RFC3339  # deterministic testing`;
}
