import { Module, forwardRef, type Provider, type Type } from '@nestjs/common';
import { AppModule } from '../../app.module.js';
import { NumberingService } from '../../core/numbering/numbering.service.js';
import { ErController } from './er/er.controller.js';
import { ErService } from './er/er.service.js';
import { FleetController } from './fleet/fleet.controller.js';
import { FleetService } from './fleet/fleet.service.js';
import { MlcController } from './mlc/mlc.controller.js';
import { MlcService } from './mlc/mlc.service.js';
import { PolytraumaController } from './polytrauma/polytrauma.controller.js';
import { PolytraumaService } from './polytrauma/polytrauma.service.js';
import { TraumaController } from './trauma/trauma.controller.js';
import { TraumaService } from './trauma/trauma.service.js';

/**
 * Phase 6 — the hospital's front door at 3 a.m.
 *
 * OP-006 leads because everything else in the phase hangs off an ER visit:
 * TR-001 triages one, TR-008 registers an MLC against one, TR-009 pre-alerts
 * one into existence before the ambulance arrives, and TR-007 opens a
 * coordination board over the injuries TR-001 scored.
 *
 * `ErService` is exported because TR-001 writes the denormalised ESI level onto
 * the visit inside its own transaction — the board's sort key and the triage
 * record have to be written together or they will eventually disagree.
 */
export const EMERGENCY_CONTROLLERS: Type<unknown>[] = [
  ErController,
  TraumaController,
  MlcController,
  FleetController,
  PolytraumaController,
];

/** `NumberingService` because OP-006 burns `ER_NO`/`ER_TAG`, TR-001 burns `MCI_NO`,
 * TR-008 burns the gapless `MLC` series and the `MLC_COPY` register, and
 * NC-013 burns `AMB_REQ` and `AMB_TRIP`, and TR-007 burns `POLYTRAUMA`. */
export const EMERGENCY_PROVIDERS: Provider[] = [
  NumberingService,
  ErService,
  TraumaService,
  MlcService,
  FleetService,
  PolytraumaService,
];

@Module({
  imports: [forwardRef(() => AppModule)],
  controllers: EMERGENCY_CONTROLLERS,
  providers: EMERGENCY_PROVIDERS,
  exports: [ErService, TraumaService, MlcService, FleetService, PolytraumaService],
})
export class EmergencyModule {}
