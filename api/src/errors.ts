/** Base class for errors that map cleanly onto an HTTP response. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'BAD_REQUEST', details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'CONFLICT', details);
  }
}

/** A state transition not present in ALLOWED_TRANSITIONS. */
export class IllegalTransitionError extends AppError {
  constructor(from: string, to: string) {
    super(`Illegal transition ${from} -> ${to}`, 409, 'ILLEGAL_TRANSITION', { from, to });
  }
}

/** A legal transition whose guard condition is not met (e.g. approval without passed checks). */
export class GuardError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'GUARD_FAILED', details);
  }
}
