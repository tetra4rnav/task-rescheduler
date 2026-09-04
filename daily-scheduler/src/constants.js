export const APP_NAME = 'task-rescheduler';
export const PLANNER_VERSION = '1.1.0';
export const PLAN_SCHEMA_VERSION = '1.1';
export const TODOIST_API_BASE_URL = 'https://api.todoist.com/api/v1';
export const MANAGED_BY = 'task-rescheduler';
export const DESCRIPTION_MARKER_KEY = 'TETRA_TODOIST_TASK_ID';
export const DEFAULT_TIMEZONE = 'America/New_York';
export const DEFAULT_TODOIST_TIMEZONE = DEFAULT_TIMEZONE;
export const DEFAULT_ACCOUNT = 'your-email-at-provider.example';
export const DEFAULT_CALENDAR_IDS = ['primary'];
export const DEFAULT_WORKING_HOURS = '09:00-18:00';
export const DEFAULT_LUNCH_HOURS = '12:00-13:00';
export const DEFAULT_DAYS = 3;
export const DEFAULT_MAX_DAILY_MINUTES = 360;
export const DEFAULT_MIN_BREAK_MINUTES = 15;
export const DEFAULT_PREP_MINUTES = 15;
export const DEFAULT_AUTO_SCHEDULE_LABEL = 'auto-schedule';
export const DEFAULT_ASSIGNMENT_MARKER_LABEL = 'task-rescheduler-assigned';
export const DEFAULT_PLANNER_VERSION_LABEL_PREFIX = 'task-rescheduler-planner-v';
export const DEFAULT_PAGE_SIZE = 200;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;

export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  INPUT: 2,
  AUTH: 3,
  API: 4,
  PLAN: 5,
  APPLY_PARTIAL: 6,
  VERIFY_MISMATCH: 7,
});

export const DEFAULT_CONFIG = Object.freeze({
  excludedProjectIds: [],
  excludedProjectNames: [],
  excludedLabels: ['no-auto-schedule'],
  requireAutoScheduleLabel: false,
  autoScheduleLabel: DEFAULT_AUTO_SCHEDULE_LABEL,
  assignmentMarkerLabel: DEFAULT_ASSIGNMENT_MARKER_LABEL,
  plannerVersionLabelPrefix: DEFAULT_PLANNER_VERSION_LABEL_PREFIX,
  recurringPolicy: 'defer',
  lunchHours: DEFAULT_LUNCH_HOURS,
  prepMinutes: DEFAULT_PREP_MINUTES,
  operationalTimezone: DEFAULT_TIMEZONE,
  deadlineHorizonDays: 14,
  undatedWipLimit: 8,
  lowConfidenceManualReviewThreshold: 0.6,
  lowConfidenceManualReviewLimit: 3,
  highScoreEscalationThreshold: 80,
  explicitDurationScoreBonus: 12,
  projectWeights: {},
  projectDailyCapacityMinutes: {},
  durationRules: {
    projects: {},
    labels: {},
    taskPatterns: [],
  },
  keywordDurations: [
    {
      category: 'writing',
      minutes: 90,
      confidence: 0.72,
      keywords: ['write', 'writing', 'draft', 'drafting', 'analysis', 'analyze', 'essay', 'report'],
    },
    {
      category: 'research',
      minutes: 60,
      confidence: 0.65,
      keywords: ['research', 'review', 'validate', 'validation', 'check', 'investigate', 'study'],
    },
    {
      category: 'routine_admin',
      minutes: 30,
      confidence: 0.7,
      keywords: ['email', 'admin', 'form', 'invoice', 'expense', 'calendar', 'schedule'],
    },
    {
      category: 'simple_action',
      minutes: 15,
      confidence: 0.55,
      keywords: ['call', 'send', 'reply', 'book', 'buy', 'pay', 'submit', 'upload'],
    },
  ],
  defaultDurationMinutes: 45,
  scoreWeights: {
    overdueBase: 400,
    overduePerDay: 50,
    todoistPriority: { 1: 0, 2: 100, 3: 200, 4: 300 },
    deadlineSameDay: 350,
    deadlineNextDay: 250,
    deadlineSoon: 100,
    agePerDay: 2,
    ageCap: 20,
    contextSwitchPenalty: 8,
    longTaskPenaltyPer30Minutes: 5,
    explicitDurationBonus: 12,
    hasDescriptionBonus: 15,
  },
});

export const PLAN_STATUSES = Object.freeze([
  'planned',
  'applied',
  'verified',
  'failed',
  'skipped',
  'noop',
]);
