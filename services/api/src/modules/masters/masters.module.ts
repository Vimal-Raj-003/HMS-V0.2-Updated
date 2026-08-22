import type { Provider, Type } from '@nestjs/common';
import { MastersCatalogueService } from './catalogue.service.js';
import {
  ConsultTypesController,
  DepartmentsController,
  RoomsController,
  ServicesController,
  SpecialitiesController,
} from './catalogue.controller.js';
import { DoctorsController } from './doctors.controller.js';
import { DoctorsService } from './doctors.service.js';
import { MastersQueryService } from './masters.query.js';
import { AreasController, ReferenceListsController } from './reference.controller.js';
import { ReferenceService } from './reference.service.js';
import { CashCountersController, QueueDefinitionsController } from './operations.controller.js';
import { MastersOperationsService } from './operations.service.js';

/**
 * EN-027 — master data, read half.
 *
 * **Wiring.** There is no `@Module` class here, only the two arrays. Every
 * Phase-1 module is spread into `AppModule`'s own `controllers` and `providers`
 * rather than imported, and the reason is written in `app.module.ts`: Nest gives
 * an imported module its own injector, so `imports: [MastersModule]` would
 * produce a second `pg.Pool` against the same database and a second policy
 * cache, and reaching back for the shared platform providers would need a
 * `forwardRef` cycle through `app.module.ts`. Exporting the arrays keeps one
 * pool and one guard chain.
 *
 * Add to `app.module.ts`:
 *
 * ```ts
 * import { MASTERS_CONTROLLERS, MASTERS_PROVIDERS } from './modules/masters/masters.module.js';
 * // controllers: [..., ...MASTERS_CONTROLLERS]
 * // providers:   [..., ...MASTERS_PROVIDERS]
 * ```
 *
 * Nothing in this module writes. EN-027's write half is a change-set workflow —
 * propose, validate, submit, approve, activate, with proposer ≠ approver and an
 * effective date (EN-027 §3.4, EN-038) — and a bare `POST /services` that
 * skipped it would let a price change go live with no approval and no change
 * calendar. So the write half waits for the workflow rather than being
 * half-shipped.
 */
export const MASTERS_CONTROLLERS: Type<unknown>[] = [
  DepartmentsController,
  SpecialitiesController,
  ConsultTypesController,
  ServicesController,
  RoomsController,
  DoctorsController,
  ReferenceListsController,
  AreasController,
  QueueDefinitionsController,
  CashCountersController,
];

export const MASTERS_PROVIDERS: Provider[] = [
  MastersQueryService,
  MastersCatalogueService,
  DoctorsService,
  ReferenceService,
  MastersOperationsService,
];
