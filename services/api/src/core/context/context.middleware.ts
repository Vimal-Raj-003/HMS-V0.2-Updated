import { Injectable, type NestMiddleware } from '@nestjs/common';
import { newId } from '@vims/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { runWithContext, type MutableRequestContext } from './request-context.js';

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
    const traceId = typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 64 ? inbound : newId();

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
      route: req.url ?? '/',
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
