import type { Provider, Type } from '@nestjs/common';
import { CareTeamService } from './care-team.service.js';
import { ClinicalDocumentService } from './documents.service.js';
import { EncounterController } from './encounter.controller.js';
import { EncounterService } from './encounter.service.js';
import { MrdService } from './mrd.service.js';
import { PatientClinicalController } from './patient-clinical.controller.js';
import { TimelineService } from './timeline.service.js';
import { VitalsController } from './vitals.controller.js';
import { VitalsService } from './vitals.service.js';

/**
 * Phase 2 — OP-007 (vital room), OP-002 (encounter, consultation, timeline) and
 * the NC-003 foundation.
 *
 * **Wiring.** There is no `@Module` class here, only the two arrays, for the
 * reason written in `app.module.ts` and repeated in `masters.module.ts`: Nest
 * gives an imported module its own injector, so `imports: [ClinicalModule]`
 * would produce a second `pg.Pool` against the same database and a second
 * policy cache. Spreading the arrays into `AppModule` keeps one pool and one
 * guard chain.
 *
 * Add to `app.module.ts`:
 *
 * ```ts
 * import { CLINICAL_CONTROLLERS, CLINICAL_PROVIDERS } from './modules/opd/clinical/clinical.module.js';
 * // controllers: [..., ...CLINICAL_CONTROLLERS]
 * // providers:   [..., ...CLINICAL_PROVIDERS]
 * ```
 *
 * `NumberingService` is deliberately **not** listed below: `AppModule` already
 * provides it, and `MrdService` injects that instance to allocate the `MRD`
 * series. Re-declaring it here would give this module its own copy of a service
 * whose whole job is to hand out numbers that must not collide.
 */
export const CLINICAL_CONTROLLERS: Type<unknown>[] = [
  VitalsController,
  EncounterController,
  PatientClinicalController,
];

export const CLINICAL_PROVIDERS: Provider[] = [
  CareTeamService,
  ClinicalDocumentService,
  MrdService,
  VitalsService,
  EncounterService,
  TimelineService,
];
