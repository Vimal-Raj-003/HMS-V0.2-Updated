import type { Provider, Type } from '@nestjs/common';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { InvestigationsController } from './investigations.controller.js';
import { InvestigationsService } from './investigations.service.js';
import { PacsController } from './pacs.controller.js';
import { PacsService } from './pacs.service.js';
import { RadAccessService } from './rad-access.service.js';
import { RadExamsController } from './rad-exams.controller.js';
import { RadExamsService } from './rad-exams.service.js';
import { RadOrdersController } from './rad-orders.controller.js';
import { RadOrdersService } from './rad-orders.service.js';
import { RadReportsController } from './rad-reports.controller.js';
import { RadReportsService } from './rad-reports.service.js';

/**
 * Phase 3 — OP-008 (RIS), EN-008 (PACS index and disclosure) and OP-022 (the
 * investigation console).
 *
 * **Wiring.** There is no `@Module` class here, only the two arrays, for the
 * reason written in `app.module.ts` and repeated in `clinical.module.ts` and
 * `masters.module.ts`: Nest gives an imported module its own injector, so
 * `imports: [RadiologyModule]` would produce a second `pg.Pool` against the same
 * database and a second policy cache. Spreading the arrays into `AppModule`
 * keeps one pool and one guard chain.
 *
 * Add to `app.module.ts`:
 *
 * ```ts
 * import { RADIOLOGY_CONTROLLERS, RADIOLOGY_PROVIDERS } from './modules/diagnostics/radiology/radiology.module.js';
 * // controllers: [..., ...RADIOLOGY_CONTROLLERS]
 * // providers:   [..., ...RADIOLOGY_PROVIDERS.filter((p) => p !== NumberingService)]
 * ```
 *
 * `NumberingService` **is** listed below, unlike in `clinical.module.ts`, because
 * this module must also be mountable on its own in the integration suite before
 * `app.module.ts` is edited — and `AppModule` provides but does not export it.
 * It is stateless and allocates inside the caller's transaction, so a second
 * instance is correct rather than merely tolerable: the row lock that makes
 * `RAD_ACC` collision-free is taken by the transaction, not by the object. The
 * `.filter()` above keeps one instance once the arrays are spread.
 *
 * `PolicyService`, `DatabaseService`, `AuditService`, `OutboxService` and
 * `CursorService` are **not** listed: `AppModule` exports all five, so the
 * module that spreads these arrays already has them.
 */
export const RADIOLOGY_CONTROLLERS: Type<unknown>[] = [
  RadOrdersController,
  RadExamsController,
  RadReportsController,
  PacsController,
  InvestigationsController,
];

export const RADIOLOGY_PROVIDERS: Provider[] = [
  NumberingService,
  RadAccessService,
  RadOrdersService,
  RadExamsService,
  RadReportsService,
  PacsService,
  InvestigationsService,
];
