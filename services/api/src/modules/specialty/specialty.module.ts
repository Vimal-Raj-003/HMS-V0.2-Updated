import { Module, forwardRef, type Provider, type Type } from '@nestjs/common';
import { AppModule } from '../../app.module.js';
import { NumberingService } from '../../core/numbering/numbering.service.js';
import { ConsoleComponentRegistryService } from './console-registry.service.js';
import { OphthalmologyController } from './ophthalmology/ophthalmology.controller.js';
import { OphthalmologyService } from './ophthalmology/ophthalmology.service.js';
import { SpecialtyController } from './specialty.controller.js';
import { SpecialtyService } from './specialty.service.js';

/**
 * Phase 8 — OP-025 §0, the framework thirty consoles are built on.
 *
 * Deliberately small. Everything a console shares lives here — the registry,
 * the worklist, the stage clock, the one device path — and everything a console
 * does *not* share lives in the console's own module with its own typed tables.
 * The line between the two is the whole design: `phase-08` says a console that
 * ships its own worklist, upload path or print pipeline is a defect, and the
 * only way that stays true is if this module is where those three live.
 */
export const SPECIALTY_CONTROLLERS: Type<unknown>[] = [SpecialtyController, OphthalmologyController];

export const SPECIALTY_PROVIDERS: Provider[] = [
  NumberingService,
  SpecialtyService,
  ConsoleComponentRegistryService,
  OphthalmologyService,
];

@Module({
  imports: [forwardRef(() => AppModule)],
  controllers: SPECIALTY_CONTROLLERS,
  providers: SPECIALTY_PROVIDERS,
  exports: [SpecialtyService, OphthalmologyService],
})
export class SpecialtyModule {}
