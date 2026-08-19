import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './core/auth/auth.guard.js';
import { PasswordService } from './core/auth/password.service.js';
import { TokenService } from './core/auth/token.service.js';
import { AuditService } from './core/audit/audit.service.js';
import { ENV, loadEnv } from './core/config/env.js';
import { ContextMiddleware } from './core/context/context.middleware.js';
import { DatabaseService } from './core/db/database.service.js';
import { HealthController } from './core/health/health.controller.js';
import { OutboxService } from './core/outbox/outbox.service.js';
import { PermissionRegistryService } from './core/policy/permission-registry.service.js';
import { PolicyGuard } from './core/policy/policy.guard.js';
import { ProblemFilter } from './core/problem/problem.filter.js';
import { TenantGuard } from './core/tenancy/tenant.guard.js';
import { AuthController } from './modules/platform/auth/auth.controller.js';
import { AuthService } from './modules/platform/auth/auth.service.js';
import { UsersController, UsersService } from './modules/platform/admin/users.controller.js';
import { SessionController, SessionService } from './modules/platform/session/session.controller.js';

/**
 * Every constructor parameter in this service is annotated with an explicit
 * `@Inject(Type)`.
 *
 * Nest's type-based injection reads `design:paramtypes`, which only exists if
 * the compiler emits decorator metadata. `tsc` does; esbuild — which `tsx` uses
 * — does not. Relying on it therefore means the application works under vitest
 * (swc) and injects `undefined` under `tsx`, with no error until something
 * dereferences it at runtime. That failure is silent and load-bearing, so
 * injection is declared rather than inferred.
 *
 * The guards are registered **globally and in order**: auth (2) → tenant (3) →
 * policy (6). `docs/01` §3 says "nothing bypasses steps 3, 6, 8", and a guard
 * applied per-controller can be bypassed simply by forgetting it on the next
 * controller. Registering them here inverts the default: a new route is closed
 * until it says otherwise.
 *
 * Nest applies `APP_GUARD` providers in declaration order, which is why they are
 * listed in the same order as the lifecycle they implement.
 */
@Module({
  controllers: [HealthController, AuthController, SessionController, UsersController],
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    DatabaseService,
    PermissionRegistryService,
    PasswordService,
    TokenService,
    AuditService,
    OutboxService,
    AuthService,
    UsersService,
    SessionService,
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PolicyGuard },
  ],
  exports: [DatabaseService, AuditService, OutboxService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Must run before every guard: they all read the request context it opens.
    consumer.apply(ContextMiddleware).forRoutes('*path');
  }
}
