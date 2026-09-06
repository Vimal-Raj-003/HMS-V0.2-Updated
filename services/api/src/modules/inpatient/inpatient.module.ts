import { Module, forwardRef, type Provider, type Type } from '@nestjs/common';
import { AppModule } from '../../app.module.js';
import { NumberingService } from '../../core/numbering/numbering.service.js';
import { BedsController } from './beds/beds.controller.js';
import { BedsService } from './beds/beds.service.js';
import { IpBillingController } from './ipbilling/ipbilling.controller.js';
import { IpBillingService } from './ipbilling/ipbilling.service.js';
import { CriticalCareController } from './criticalcare/criticalcare.controller.js';
import { CriticalCareService } from './criticalcare/criticalcare.service.js';
import { TheatreController } from './theatre/theatre.controller.js';
import { TheatreService } from './theatre/theatre.service.js';
import { DischargeController } from './discharge/discharge.controller.js';
import { DischargeService } from './discharge/discharge.service.js';
import { NursingController } from './nursing/nursing.controller.js';
import { NursingService } from './nursing/nursing.service.js';

/**
 * Phase 7 — the ward.
 *
 * 7A first, because everything else in the phase hangs off an admission: the
 * nursing station lists a ward's admissions, the MAR belongs to one, the OT
 * schedules against one, and the final bill reconciles to one.
 *
 * `BedsService` is exported because IP-005 stops the room clock on the same
 * occupancy row this module closes, and the two have to be one transaction.
 * `NursingService` is exported because the worker climbs the escalation ladder
 * on a schedule, and it does so through this service so the outbox events and
 * the audit rows are the same ones a human action would produce.
 */
export const INPATIENT_CONTROLLERS: Type<unknown>[] = [
  BedsController,
  NursingController,
  IpBillingController,
  TheatreController,
  CriticalCareController,
  DischargeController,
];

/**
 * `NumberingService` because IP-001 burns the gapless `IP_NO` series, IP-006 the
 * `OT_CASE` one and IP-017 the `MORTUARY` register.
 */
export const INPATIENT_PROVIDERS: Provider[] = [
  NumberingService,
  BedsService,
  NursingService,
  IpBillingService,
  TheatreService,
  CriticalCareService,
  DischargeService,
];

@Module({
  imports: [forwardRef(() => AppModule)],
  controllers: INPATIENT_CONTROLLERS,
  providers: INPATIENT_PROVIDERS,
  exports: [
    BedsService,
    NursingService,
    IpBillingService,
    TheatreService,
    CriticalCareService,
    DischargeService,
  ],
})
export class InpatientModule {}
