import { Module } from '@nestjs/common';
import { AuditService } from '../../../core/audit/audit.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { TokenService } from '../../../core/auth/token.service.js';
import { ENV, loadEnv } from '../../../core/config/env.js';
import { DatabaseService } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { PolicyService } from '../../../core/policy/policy.service.js';
import { AuthService } from '../../platform/auth/auth.service.js';
import { QueueController } from './queue.controller.js';
import { QueueService } from './queue.service.js';

/**
 * EN-006 — queue management, wired as its own Nest module.
 *
 * **On the platform providers listed below.** They are the same classes
 * `AppModule` already provides, and Nest gives an imported module its own
 * injector: a provider declared in `AppModule` is not visible here, and a module
 * that only imported `AppModule` would be a cycle. Declaring them means this
 * module boots on its own — `imports: [QueueModule]` is all the wiring it needs
 * — at the cost of a second `DatabaseService`, and therefore a second connection
 * pool.
 *
 * That cost is real and should not survive: the right shape is a `CoreModule` in
 * `src/core` that provides and exports these once, imported by `AppModule`,
 * `QueueModule` and `CashModule` alike. That change belongs in `app.module.ts`
 * and `src/core`, both outside this module's remit, so it is flagged here rather
 * than made silently. Until then, size `DATABASE_POOL_MAX` knowing three pools
 * open per process.
 */
@Module({
  controllers: [QueueController],
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    DatabaseService,
    AuditService,
    OutboxService,
    CursorService,
    PasswordService,
    TokenService,
    AuthService,
    PolicyService,
    QueueService,
  ],
  exports: [QueueService],
})
export class QueueModule {}
