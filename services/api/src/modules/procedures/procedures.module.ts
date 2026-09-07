import { Module, forwardRef, type Provider, type Type } from '@nestjs/common';
import { AppModule } from '../../app.module.js';
import { NumberingService } from '../../core/numbering/numbering.service.js';
import { ProceduresController } from './procedures.controller.js';
import { ProceduresService } from './procedures.service.js';

/**
 * Phase 8 — OP-010 and OP-039, the procedure spine.
 *
 * Its own module rather than a specialty one, because it is not a specialty:
 * the eye clinic's laser, dermatology's biopsy and the pain clinic's block are
 * all procedures ordered here. A console that grew its own procedure engine
 * would be the second implementation of consent, the time-out and the Aldrete
 * floor, and one of them would eventually be wrong.
 */
export const PROCEDURE_CONTROLLERS: Type<unknown>[] = [ProceduresController];

/** `NumberingService` because OP-010 burns the `PROC` series. */
export const PROCEDURE_PROVIDERS: Provider[] = [NumberingService, ProceduresService];

@Module({
  imports: [forwardRef(() => AppModule)],
  controllers: PROCEDURE_CONTROLLERS,
  providers: PROCEDURE_PROVIDERS,
  exports: [ProceduresService],
})
export class ProceduresModule {}
