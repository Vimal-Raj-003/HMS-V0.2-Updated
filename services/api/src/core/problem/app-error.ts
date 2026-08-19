import { PROBLEM_STATUS, ProblemType, type ProblemFieldError, type ProblemTypeKey } from '@vims/contracts';

/**
 * The only error type the API throws deliberately.
 *
 * Carrying the RFC 9457 problem type rather than an HTTP status means the status
 * is derived in exactly one place (`PROBLEM_STATUS` in `packages/contracts`),
 * so a decision like "a cross-tenant read is a 404, not a 403, because a 403
 * confirms the row exists" (docs/09 §3.1) cannot be undone by a controller
 * choosing its own number.
 */
export class AppError extends Error {
  readonly type: ProblemTypeKey;
  readonly status: number;
  readonly detail: string;
  readonly errors: readonly ProblemFieldError[];
  readonly clinicalImpact?: string;
  readonly nextAction?: string;
  readonly reference?: string;

  constructor(
    type: ProblemTypeKey,
    detail: string,
    options: {
      errors?: readonly ProblemFieldError[];
      clinicalImpact?: string;
      nextAction?: string;
      reference?: string;
      cause?: unknown;
    } = {},
  ) {
    super(detail, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.type = type;
    this.status = PROBLEM_STATUS[type];
    this.detail = detail;
    this.errors = options.errors ?? [];
    if (options.clinicalImpact !== undefined) this.clinicalImpact = options.clinicalImpact;
    if (options.nextAction !== undefined) this.nextAction = options.nextAction;
    if (options.reference !== undefined) this.reference = options.reference;
  }

  /**
   * A cross-tenant miss and a genuine miss must be indistinguishable to the
   * caller, or the API becomes an existence oracle for other hospitals' records.
   */
  static notFound(what: string): AppError {
    return new AppError(ProblemType.NOT_FOUND, `${what} was not found.`, {
      nextAction: 'Check the identifier and try again.',
    });
  }

  static unauthenticated(detail = 'Sign in to continue.'): AppError {
    return new AppError(ProblemType.UNAUTHENTICATED, detail);
  }

  static permissionDenied(detail = 'You do not have permission to do this.'): AppError {
    return new AppError(ProblemType.PERMISSION_DENIED, detail, {
      nextAction: 'Ask your administrator to grant the required role.',
    });
  }

  static validation(errors: readonly ProblemFieldError[]): AppError {
    return new AppError(ProblemType.VALIDATION_FAILED, 'The request could not be validated.', { errors });
  }

  static conflict(detail: string): AppError {
    return new AppError(ProblemType.CONFLICT, detail);
  }

  static rateLimited(detail = 'Too many requests. Please wait and try again.'): AppError {
    return new AppError(ProblemType.RATE_LIMITED, detail);
  }
}
