import { Module } from '@nestjs/common';
import { AuditService } from '../../../core/audit/audit.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { TokenService } from '../../../core/auth/token.service.js';
import { ENV, loadEnv } from '../../../core/config/env.js';
import { DatabaseService } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { PolicyService } from '../../../core/policy/policy.service.js';
import { AuthService } from '../../platform/auth/auth.service.js';
import { CashController } from './cash.controller.js';
import { CoSignService } from './cosign.service.js';
import { PaymentsService } from './payments.service.js';
import { ShiftsService } from './shifts.service.js';

/**
 * NC-001 — the cash counter, wired as its own Nest module.
 *
 * The platform providers are declared here for the same reason as in
 * `QueueModule`: Nest gives an imported module its own injector, so a provider
 * declared in `AppModule` is not visible to a module `AppModule` imports. The
 * cost is a second `DatabaseService` and therefore a second connection pool, and
 * the fix — a `CoreModule` under `src/core` that both import — belongs in files
 * outside this module's remit. Flagged rather than done silently.
 */
@Module({
  controllers: [CashController],
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    DatabaseService,
    AuditService,
    OutboxService,
    CursorService,
    NumberingService,
    PasswordService,
    TokenService,
    AuthService,
    PolicyService,
    CoSignService,
    ShiftsService,
    PaymentsService,
  ],
  exports: [ShiftsService, PaymentsService],
})
export class CashModule {}
