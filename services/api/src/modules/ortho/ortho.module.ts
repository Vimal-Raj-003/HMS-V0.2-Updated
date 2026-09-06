import { Module, forwardRef, type Provider, type Type } from '@nestjs/common';
import { AppModule } from '../../app.module.js';
import { FractureController } from './fracture/fracture.controller.js';
import { FractureService } from './fracture/fracture.service.js';
import { ImplantController } from './implant/implant.controller.js';
import { ImplantService } from './implant/implant.service.js';

/**
 * Phase 6 — the bone, after the emergency.
 *
 * TR-002 is the registry every fracture lands in whichever door it came
 * through, and OP-009 is the clinic that follows it up. They share a module
 * because a fracture registered in the ER is followed up in the ortho clinic,
 * and the follow-up schedule is anchored on the injury the ER recorded.
 *
 * TR-003 and TR-005 join them for the same reason: the metal and the plaster
 * both go into the fracture the registry holds, and the laterality of a cast is
 * checked against that fracture rather than against a form.
 */
export const ORTHO_CONTROLLERS: Type<unknown>[] = [FractureController, ImplantController];
export const ORTHO_PROVIDERS: Provider[] = [FractureService, ImplantService];

@Module({
  imports: [forwardRef(() => AppModule)],
  controllers: ORTHO_CONTROLLERS,
  providers: ORTHO_PROVIDERS,
  exports: [FractureService, ImplantService],
})
export class OrthoModule {}
