import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getContext } from '../context/request-context.js';
import { PUBLIC_KEY } from '../policy/permission.decorator.js';
import { AppError } from '../problem/app-error.js';

/**
 * Step 3 — the tenant must be resolved before any handler runs.
 *
 * `docs/01` §3: "nothing bypasses steps 3, 6, 8." A request that reaches a
 * service without a hospital would open its transaction with no scope; RLS would
 * then return nothing, and the symptom — an empty ward list — looks like missing
 * data rather than a broken guard. Failing here makes it look like what it is.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(execution: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      execution.getHandler(),
      execution.getClass(),
    ]);
    if (isPublic === true) return true;

    const ctx = getContext();
    if (ctx.hospitalId === null) {
      throw AppError.unauthenticated('No hospital is associated with this session.');
    }
    return true;
  }
}
