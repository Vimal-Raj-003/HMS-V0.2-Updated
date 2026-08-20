import { Injectable, type NestMiddleware } from '@nestjs/common';
import { newId } from '@vims/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { runWithContext, type MutableRequestContext } from './request-context.js';

/** The path portion of a request target, bounded to what `api_route` can hold. */
export function pathOf(url: string | undefined): string {
  const raw = url ?? '/';
  const queryAt = raw.indexOf('?');
  const path = queryAt === -1 ? raw : raw.slice(0, queryAt);
  return path.length <= 200 ? path : path.slice(0, 200);
}

/**
 * Step 1 — opens the request context and the trace.
 *
 * The trace id is echoed on every response, including errors, because it is the
 * reference a user reads out to the helpdesk (`primitives/problem.ts`). An
 * inbound `x-trace-id` is honoured so a trace started in the browser or by an
 * upstream proxy survives into the API logs as one story rather than two.
 */
@Injectable()
export class ContextMiddleware implements NestMiddleware {
  use(req: FastifyRequest['raw'], res: FastifyReply['raw'], next: () => void): void {
    const inbound = req.headers['x-trace-id'];
    const traceId =
      typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 64 ? inbound : newId();

    const forwardedFor = req.headers['x-forwarded-for'];
    const ip =
      (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0]?.trim() : undefined) ??
      req.socket.remoteAddress ??
      null;

    const ctx: MutableRequestContext = {
      traceId,
      requestId: newId(),
      startedAtMs: Date.now(),
      method: req.method ?? 'GET',
      // Path only — the query string is deliberately dropped.
      //
      // `route` is what lands in `core.audit_log.api_route`, and a query string
      // carries identifiers: a page cursor encodes a row id, a search carries a
      // patient id or a business key. `docs/04` §7 keeps identifiers out of logs
      // and audit payloads (the filter is recorded by name in `reason_text`, the
      // values never are), and the column is `varchar(200)`, which a signed
      // cursor alone can overflow.
      route: pathOf(req.url),
      ip,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      userId: null,
      sessionId: null,
      hospitalId: null,
      branchId: null,
      grantedBranchIds: [],
      scope: 'branch',
      roleKeys: [],
      impersonatorUserId: null,
      reason: null,
    };

    res.setHeader('x-trace-id', traceId);
    runWithContext(ctx, next);
  }
}
