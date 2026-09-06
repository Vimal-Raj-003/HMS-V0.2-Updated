import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
// `.js` is required, not optional: this compiles under `moduleResolution:
// "Bundler"` either way, but the emitted code is run by Node's ESM loader
// against a CommonJS package that publishes no `exports` map, so the
// extensionless form resolves at build time and throws ERR_MODULE_NOT_FOUND
// at boot. `HTTP_CODE_METADATA` is not re-exported from the package root,
// so the deep import itself has to stay.
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { ProblemType } from '@vims/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { catchError, concatMap, from, map, of, throwError, type Observable } from 'rxjs';
import { getContext } from '../context/request-context.js';
import { AppError } from '../problem/app-error.js';
import { IDEMPOTENT_KEY, type IdempotencyOptions } from './idempotency.decorator.js';
import { checkIdempotencyKey, fingerprintRequest } from './idempotency.fingerprint.js';
import { IdempotencyService } from './idempotency.service.js';

/** Set on a response that was served from the store rather than re-executed. */
export const REPLAY_HEADER = 'idempotent-replay';

/**
 * `CLAUDE.md` §3 step "Idempotency on all money-moving and order-creating
 * endpoints", implemented once instead of per service.
 *
 * It runs as an interceptor rather than a guard because it has to be on *both*
 * sides of the handler: a guard can refuse a duplicate, but only something
 * wrapping the call can store what the first call answered, and replaying the
 * first answer — not merely suppressing the second execution — is what the
 * client needs. A retried registration that returns 409 instead of the original
 * 201 leaves the receptionist with a patient who exists and a screen that says
 * the registration failed.
 *
 * Ordering is what makes this safe: Nest runs guards before interceptors, so
 * authentication (step 2), tenancy (step 3) and policy (step 6) have all
 * completed by the time a key is written. A key is therefore always scoped to a
 * hospital that the caller was entitled to reach, and one tenant's key can never
 * shadow another's.
 *
 * The four outcomes, and why each is what it is:
 *
 *  - **no key on a route that requires one** → 400. Failing closed is the point;
 *    accepting the request would mean the submission least protected against a
 *    double-click is the one that silently gets no protection at all.
 *  - **same key, same request, already finished** → the stored response, verbatim.
 *  - **same key, same request, still running** → 409. The alternative is to hold
 *    the connection open and hope, which converts a duplicate click into a
 *    thread leak on the busiest screen in the hospital.
 *  - **same key, different request** → 409. This is a client bug, and returning
 *    the first response would answer a question the caller did not ask — the
 *    receipt for ₹500 in reply to a submission for ₹5,000.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(IdempotencyService) private readonly store: IdempotencyService,
  ) {}

  async intercept(execution: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (execution.getType() !== 'http') return next.handle();

    const options = this.reflector.getAllAndOverride<IdempotencyOptions | undefined>(IDEMPOTENT_KEY, [
      execution.getHandler(),
      execution.getClass(),
    ]);
    if (options === undefined) return next.handle();

    const request = execution.switchToHttp().getRequest<FastifyRequest>();
    const reply = execution.switchToHttp().getResponse<FastifyReply>();

    const check = checkIdempotencyKey(request.headers['idempotency-key']);
    if (check.kind === 'missing') {
      throw new AppError(
        ProblemType.IDEMPOTENCY_KEY_MISSING,
        'This action must be sent with an Idempotency-Key header so that a retry cannot repeat it.',
        {
          nextAction:
            'Generate one key per submission (a UUID is ideal), reuse it for every retry of that submission, and use a new one for the next.',
        },
      );
    }
    if (check.kind === 'invalid') {
      throw new AppError(ProblemType.IDEMPOTENCY_KEY_MISSING, check.detail, {
        nextAction: 'Send a single Idempotency-Key header holding a UUID.',
      });
    }

    const ctx = getContext();
    if (ctx.hospitalId === null) {
      // Unreachable through the guard chain, and stated as an error rather than
      // trusted: a key with no tenant would be global, and one hospital's retry
      // would replay another hospital's response.
      throw new AppError(
        ProblemType.INTERNAL_ERROR,
        'This route requires an idempotency key but has no tenant scope, and has been refused.',
      );
    }

    const route = routeOf(request);
    const requestHash = fingerprintRequest({
      method: request.method,
      route,
      params: request.params,
      query: request.query,
      body: request.body,
    });

    const reservation = await this.store.reserve({
      key: check.key,
      route,
      method: request.method,
      requestHash,
      ttlHours: options.ttlHours,
      lockSeconds: options.lockSeconds,
    });

    switch (reservation.kind) {
      case 'replay':
        // The stored status is the same route's success status by construction,
        // which is why the body alone is handed back to Nest: it applies the
        // route's own status code and the two cannot drift apart.
        void reply.header(REPLAY_HEADER, 'true');
        return of(reservation.body);

      case 'in_flight':
        throw new AppError(
          ProblemType.IDEMPOTENCY_KEY_REUSED,
          'This submission is already being processed. It has not been lost.',
          {
            clinicalImpact: 'Nothing has been duplicated — the first attempt is still running.',
            nextAction: 'Wait a moment and check the record before submitting again.',
          },
        );

      case 'fingerprint_mismatch':
        throw new AppError(
          ProblemType.IDEMPOTENCY_KEY_REUSED,
          'This idempotency key was already used for a different request, so it cannot be reused.',
          {
            clinicalImpact:
              'Nothing was changed. Answering with the earlier result would have replied to a different submission than the one sent.',
            nextAction: 'Use a new idempotency key for a new submission.',
          },
        );

      case 'proceed':
        break;
    }

    const reservationId = reservation.id;
    const status = this.successStatus(execution, request.method);

    return next.handle().pipe(
      concatMap((body: unknown) =>
        from(this.store.complete(reservationId, status, body)).pipe(map(() => body)),
      ),
      catchError((error: unknown) =>
        from(this.store.abandon(reservationId)).pipe(concatMap(() => throwError(() => error))),
      ),
    );
  }

  /**
   * The status Nest will send, computed rather than observed.
   *
   * At the point the interceptor sees the result, Nest has not yet applied the
   * route's status to the reply — reading `reply.statusCode` here yields 200 for
   * a route that is about to answer 201, and the replay would then differ from
   * the original in the one field a client switches on.
   */
  private successStatus(execution: ExecutionContext, method: string): number {
    const explicit = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, execution.getHandler());
    if (typeof explicit === 'number') return explicit;
    return method.toUpperCase() === 'POST' ? 201 : 200;
  }
}

/**
 * The route *pattern*, not the resolved URL.
 *
 * `/cash/receipts/:id/void` rather than `/cash/receipts/9f2…/void`, so the key is
 * scoped to the operation while the specific id travels in the fingerprint. The
 * fallback exists because `routeOptions` is Fastify's own shape and a URL with a
 * query string would otherwise scope the key to the query as well.
 */
function routeOf(request: FastifyRequest): string {
  const pattern = request.routeOptions.url;
  if (typeof pattern === 'string' && pattern.length > 0) return pattern.slice(0, 200);
  const [path] = request.url.split('?');
  return (path ?? request.url).slice(0, 200);
}
