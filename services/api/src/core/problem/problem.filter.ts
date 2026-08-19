import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { PROBLEM_TITLES, ProblemType, buildProblem, type ProblemTypeKey } from '@vims/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { tryGetContext } from '../context/request-context.js';
import { AppError } from './app-error.js';

/**
 * Step 9 of `docs/01` §3 — every error leaves as `application/problem+json`.
 *
 * Two rules are enforced here rather than trusted to call sites:
 *
 * **Nothing unexpected reaches the client.** An unrecognised throw becomes a
 * generic internal error. A stack trace or a Postgres message can name a table,
 * a constraint or a patient identifier, and `docs/04` §7 keeps all of that out
 * of anything a client or a log aggregator can read.
 *
 * **Every response carries the trace id.** A nurse reading an error at a bedside
 * cannot debug it, but they can read out eight characters, and that is what makes
 * the incident findable.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const ctx = tryGetContext();
    const traceId = ctx?.traceId ?? 'untraced';
    const instance = request.url;

    const { type, detail, status, errors, extras } = this.classify(exception);

    // 5xx is our fault and must be investigable; 4xx is the caller's and is noise
    // at error level.
    if (status >= 500) {
      this.logger.error(
        { traceId, type, err: exception instanceof Error ? exception.message : String(exception) },
        'unhandled error',
      );
    } else {
      this.logger.debug({ traceId, type, status }, 'request rejected');
    }

    // `reference` IS the trace id by contract: primitives/problem.ts calls it
    // "the support reference the user reads out on the phone. Always present,
    // always matches the trace_id in the logs, so a helpdesk call resolves to
    // one request."
    const problem = buildProblem({
      type,
      title: PROBLEM_TITLES[type],
      status,
      reference: traceId,
      detail,
      instance,
      ...(errors.length > 0 ? { errors } : {}),
      ...extras,
    });

    void reply.status(status).header('content-type', 'application/problem+json').send(problem);
  }

  private classify(exception: unknown): {
    type: ProblemTypeKey;
    detail: string;
    status: number;
    errors: ReturnType<typeof AppError.prototype.errors.slice>;
    extras: Record<string, string>;
  } {
    if (exception instanceof AppError) {
      const extras: Record<string, string> = {};
      if (exception.clinicalImpact !== undefined) extras['clinicalImpact'] = exception.clinicalImpact;
      if (exception.nextAction !== undefined) extras['nextAction'] = exception.nextAction;
      if (exception.reference !== undefined) extras['reference'] = exception.reference;
      return {
        type: exception.type,
        detail: exception.detail,
        status: exception.status,
        errors: exception.errors.slice(),
        extras,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: status === 404 ? ProblemType.NOT_FOUND : status === 401 ? ProblemType.UNAUTHENTICATED : ProblemType.BUSINESS_RULE_VIOLATED,
        detail: exception.message,
        status,
        errors: [],
        extras: {},
      };
    }

    // Deliberately generic: the real reason is logged, never returned.
    return {
      type: ProblemType.INTERNAL_ERROR,
      detail: 'Something went wrong on our side. The incident has been recorded.',
      status: 500,
      errors: [],
      extras: {},
    };
  }
}
