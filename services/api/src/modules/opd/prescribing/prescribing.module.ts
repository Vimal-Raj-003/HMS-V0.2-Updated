import { Module, forwardRef, type Provider, type Type } from '@nestjs/common';
import { AppModule } from '../../../app.module.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { CdssAlertsService } from './cdss.alerts.service.js';
import { CdssController } from './cdss.controller.js';
import { CdssService } from './cdss.service.js';
import { DrugsService } from './drugs.service.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { PrescribingController } from './prescribing.controller.js';
import { PrescriptionService } from './prescription.service.js';

/**
 * OP-002 §3.3–§3.4 and EN-029: e-prescribing, the CDSS rules engine and CPOE.
 *
 * **Wiring.** `PRESCRIBING_CONTROLLERS` and `PRESCRIBING_PROVIDERS` are exported
 * separately so they can be spread straight into `AppModule`'s own arrays — the
 * way every module in this application is actually wired, and the reason there
 * is one connection pool rather than one per feature. `PrescribingModule` exists
 * for the alternative wiring (`imports: [forwardRef(() => PrescribingModule)]`)
 * and is the same list, so neither shape needs an edit here.
 *
 * `NumberingService` is listed because prescriptions and orders burn the `RX`
 * and `ORD` series. `AppModule` already provides it, so when these arrays are
 * spread into it the duplicate collapses to one provider — the same treatment
 * `SCHEDULING_PROVIDERS` gets today.
 */
export const PRESCRIBING_CONTROLLERS: Type<unknown>[] = [
  PrescribingController,
  CdssController,
  OrdersController,
];

export const PRESCRIBING_PROVIDERS: Provider[] = [
  NumberingService,
  CdssService,
  CdssAlertsService,
  DrugsService,
  PrescriptionService,
  OrdersService,
];

@Module({
  imports: [forwardRef(() => AppModule)],
  controllers: PRESCRIBING_CONTROLLERS,
  providers: PRESCRIBING_PROVIDERS,
  exports: [PrescriptionService, OrdersService, CdssService],
})
export class PrescribingModule {}
