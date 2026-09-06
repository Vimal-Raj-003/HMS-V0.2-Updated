import { Module, forwardRef, type Provider, type Type } from '@nestjs/common';
import { AppModule } from '../../app.module.js';
import { FractureController } from './fracture/fracture.controller.js';
import { FractureService } from './fracture/fracture.service.js';

/**
 * Phase 6 — the bone, after the emergency.
 *
 * TR-002 is the registry every fracture lands in whichever door it came
 * through, and OP-009 is the clinic that follows it up. They share a module
 * because a fracture registered in the ER is followed up in the ortho clinic,
 * and the follow-up schedule is anchored on the injury the ER recorded.
 */
export const ORTHO_CONTROLLERS: Type<unknown>[] = [FractureController];
export const ORTHO_PROVIDERS: Provider[] = [FractureService];

@Module({
  imports: [forwardRef(() => AppModule)],
  controllers: ORTHO_CONTROLLERS,
  providers: ORTHO_PROVIDERS,
  exports: [FractureService],
})
export class OrthoModule {}
