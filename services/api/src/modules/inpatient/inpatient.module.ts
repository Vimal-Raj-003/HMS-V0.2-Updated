import { Module, forwardRef, type Provider, type Type } from '@nestjs/common';
import { AppModule } from '../../app.module.js';
import { NumberingService } from '../../core/numbering/numbering.service.js';
import { BedsController } from './beds/beds.controller.js';
import { BedsService } from './beds/beds.service.js';

/**
 * Phase 7 — the ward.
 *
 * 7A first, because everything else in the phase hangs off an admission: the
 * nursing station lists a ward's admissions, the MAR belongs to one, the OT
 * schedules against one, and the final bill reconciles to one.
 *
 * `BedsService` is exported because IP-005 stops the room clock on the same
 * occupancy row this module closes, and the two have to be one transaction.
 */
export const INPATIENT_CONTROLLERS: Type<unknown>[] = [BedsController];

/** `NumberingService` because IP-001 burns the gapless `IP_NO` series. */
export const INPATIENT_PROVIDERS: Provider[] = [NumberingService, BedsService];

@Module({
  imports: [forwardRef(() => AppModule)],
  controllers: INPATIENT_CONTROLLERS,
  providers: INPATIENT_PROVIDERS,
  exports: [BedsService],
})
export class InpatientModule {}
