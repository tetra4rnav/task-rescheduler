import { EXIT_CODES } from './constants.js';

export class SchedulerError extends Error {
  constructor(message, { code = EXIT_CODES.PLAN, meta = undefined, cause = undefined } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
    this.meta = meta;
  }
}

export class InputError extends SchedulerError {
  constructor(message, meta) {
    super(message, { code: EXIT_CODES.INPUT, meta });
  }
}

export class AuthError extends SchedulerError {
  constructor(message, meta) {
    super(message, { code: EXIT_CODES.AUTH, meta });
  }
}

export class ApiError extends SchedulerError {
  constructor(message, meta) {
    super(message, { code: EXIT_CODES.API, meta });
  }
}

export class PlanError extends SchedulerError {
  constructor(message, meta) {
    super(message, { code: EXIT_CODES.PLAN, meta });
  }
}

export class StateDriftError extends SchedulerError {
  constructor(message, meta) {
    super(message, { code: EXIT_CODES.PLAN, meta });
  }
}

export class ApplyPartialError extends SchedulerError {
  constructor(message, meta) {
    super(message, { code: EXIT_CODES.APPLY_PARTIAL, meta });
  }
}

export class VerifyError extends SchedulerError {
  constructor(message, meta) {
    super(message, { code: EXIT_CODES.VERIFY_MISMATCH, meta });
  }
}
