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
import { CursorService } from './core/pagination/cursor.service.js';
import { PermissionRegistryService } from './core/policy/permission-registry.service.js';
import { PolicyGuard } from './core/policy/policy.guard.js';
import { PolicyService } from './core/policy/policy.service.js';
import { ProblemFilter } from './core/problem/problem.filter.js';
import { TenantGuard } from './core/tenancy/tenant.guard.js';
import { AuthController } from './modules/platform/auth/auth.controller.js';
import { AuthService } from './modules/platform/auth/auth.service.js';
import { AuditLogController } from './modules/platform/admin/audit-log.controller.js';
import { AuditLogService } from './modules/platform/admin/audit-log.service.js';
import { BranchesController } from './modules/platform/admin/branches.controller.js';
import { BranchesService } from './modules/platform/admin/branches.service.js';
import { FlagsController } from './modules/platform/admin/flags.controller.js';
import { FlagsService } from './modules/platform/admin/flags.service.js';
import { LicenceController } from './modules/platform/admin/licence.controller.js';
import { LicenceService } from './modules/platform/admin/licence.service.js';
import { RolesController } from './modules/platform/admin/roles.controller.js';
import { RolesService } from './modules/platform/admin/roles.service.js';
import { SettingsController } from './modules/platform/admin/settings.controller.js';
import { SettingsService } from './modules/platform/admin/settings.service.js';
import { UsersController } from './modules/platform/admin/users.controller.js';
import { UsersService } from './modules/platform/admin/users.service.js';
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
  controllers: [
    HealthController,
    AuthController,
    SessionController,
    // The admin console (EN-007 §6). `RolesController` is mounted at `admin` so
    // it can own both `admin/roles` and `admin/permissions`; the rest own one
    // path prefix each.
    UsersController,
    RolesController,
    BranchesController,
    SettingsController,
    FlagsController,
    LicenceController,
    AuditLogController,
  ],
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    DatabaseService,
    PermissionRegistryService,
    PasswordService,
    TokenService,
    AuditService,
    OutboxService,
    CursorService,
    PolicyService,
    AuthService,
    SessionService,
    UsersService,
    RolesService,
    BranchesService,
    SettingsService,
    FlagsService,
    LicenceService,
    AuditLogService,
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PolicyGuard },
  ],
  exports: [DatabaseService, AuditService, OutboxService, CursorService, PolicyService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Must run before every guard: they all read the request context it opens.
    consumer.apply(ContextMiddleware).forRoutes('*path');
  }
}
