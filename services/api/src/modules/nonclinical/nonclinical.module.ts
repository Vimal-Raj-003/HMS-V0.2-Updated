import { Module, forwardRef, type Provider, type Type } from '@nestjs/common';
import { AppModule } from '../../app.module.js';
import { DietaryController } from './dietary/dietary.controller.js';
import { DietaryService } from './dietary/dietary.service.js';

/**
 * The non-clinical domain — Phase 9's home, opened early by NC-033.
 *
 * The kitchen arrives in Phase 8 rather than Phase 9 because its Phase 8 half
 * is not an ERP problem: converting a diet order into a tray, and refusing the
 * tray when the patient is allergic, cannot swallow it, or is nil by mouth, is
 * patient safety wearing an apron. The canteen till, the staff subsidy, the
 * kitchen stores and the waste log are the ERP half and wait for Phase 9,
 * where the rest of this folder will join them.
 */
export const NONCLINICAL_CONTROLLERS: Type<unknown>[] = [DietaryController];

export const NONCLINICAL_PROVIDERS: Provider[] = [DietaryService];

@Module({
  imports: [forwardRef(() => AppModule)],
  controllers: NONCLINICAL_CONTROLLERS,
  providers: NONCLINICAL_PROVIDERS,
  exports: [DietaryService],
})
export class NonClinicalModule {}
