import { Module, forwardRef } from '@nestjs/common';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { AppModule } from '../../../app.module.js';
import { PatientController } from './patient.controller.js';
import { PatientDedupeService } from './patient.dedupe.service.js';
import { PatientMergeService } from './patient.merge.service.js';
import { PatientSearchService } from './patient.search.service.js';
import { PatientService } from './patient.service.js';

/**
 * OP-001's patient master / MPI.
 *
 * **To wire this up**, add it to `AppModule`'s `imports`:
 *
 * ```ts
 * imports: [forwardRef(() => PatientModule)]
 * ```
 *
 * `forwardRef` on both sides because the dependency is genuinely circular:
 * `AppModule` owns and exports the platform services this module needs
 * (`DatabaseService`, `AuditService`, `OutboxService`, `CursorService`,
 * `PolicyService`) and registers the three global guards, so `PatientModule`
 * must import it — while `AppModule` must import `PatientModule` for the routes
 * to exist. Nest resolves that with `forwardRef`; declaring the platform
 * services again here would give this module a *second* `DatabaseService`, and
 * therefore a second connection pool, which is the kind of duplication that only
 * shows up as connection exhaustion under load.
 *
 * `NumberingService` is provided here rather than imported because `AppModule`
 * does not currently provide it at all — nothing before Phase 1 allocated a
 * human-facing number. It is stateless and takes the caller's transaction, so a
 * per-module instance is correct rather than merely tolerable; if a second
 * module needs it later it belongs in the platform providers.
 */
@Module({
  imports: [forwardRef(() => AppModule)],
  controllers: [PatientController],
  providers: [
    NumberingService,
    PatientDedupeService,
    PatientService,
    PatientSearchService,
    PatientMergeService,
  ],
  exports: [PatientService, PatientSearchService, PatientMergeService],
})
export class PatientModule {}
