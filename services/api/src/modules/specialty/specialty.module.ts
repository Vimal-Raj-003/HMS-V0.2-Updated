import { Module, forwardRef, type Provider, type Type } from '@nestjs/common';
import { AppModule } from '../../app.module.js';
import { NumberingService } from '../../core/numbering/numbering.service.js';
import { ConsoleComponentRegistryService } from './console-registry.service.js';
import { CardiologyService } from './consoles/cardiology.service.js';
import { ConsolesController } from './consoles/consoles.controller.js';
import { DentalService } from './consoles/dental.service.js';
import { DermatologyService } from './consoles/dermatology.service.js';
import { EntService } from './consoles/ent.service.js';
import { PulmonologyService } from './consoles/pulmonology.service.js';
import { PainController } from './pain/pain.controller.js';
import { HealthCheckService } from './programme/healthcheck.service.js';
import { ImmunisationService } from './programme/immunisation.service.js';
import { AntenatalController } from './antenatal/antenatal.controller.js';
import { AntenatalService } from './antenatal/antenatal.service.js';
import { AyushController } from './ayush/ayush.controller.js';
import { AyushService } from './ayush/ayush.service.js';
import { HandoffsController } from './handoffs/handoffs.controller.js';
import { HandoffsService } from './handoffs/handoffs.service.js';
import { TransplantController } from './transplant/transplant.controller.js';
import { TransplantService } from './transplant/transplant.service.js';
import { LifespanController } from './lifespan/lifespan.controller.js';
import { LifespanService } from './lifespan/lifespan.service.js';
import { PsychiatryController } from './psychiatry/psychiatry.controller.js';
import { PsychiatryService } from './psychiatry/psychiatry.service.js';
import { OncologyController } from './oncology/oncology.controller.js';
import { OncologyService } from './oncology/oncology.service.js';
import { LabourController } from './labour/labour.controller.js';
import { LabourService } from './labour/labour.service.js';
import { DialysisController } from './dialysis/dialysis.controller.js';
import { DialysisService } from './dialysis/dialysis.service.js';
import { ProgrammeController } from './programme/programme.controller.js';
import { PainService } from './pain/pain.service.js';
import { NutritionService } from './therapy/nutrition.service.js';
import { SpeechService } from './therapy/speech.service.js';
import { TherapyController } from './therapy/therapy.controller.js';
import { TherapyService } from './therapy/therapy.service.js';
import { WoundService } from './therapy/wound.service.js';
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
export const SPECIALTY_CONTROLLERS: Type<unknown>[] = [
  SpecialtyController,
  OphthalmologyController,
  ConsolesController,
  TherapyController,
  PainController,
  ProgrammeController,
  DialysisController,
  AntenatalController,
  LabourController,
  OncologyController,
  PsychiatryController,
  LifespanController,
  TransplantController,
  HandoffsController,
  AyushController,
];

export const SPECIALTY_PROVIDERS: Provider[] = [
  NumberingService,
  SpecialtyService,
  ConsoleComponentRegistryService,
  OphthalmologyService,

  // OP-029, OP-030, OP-028, OP-026, OP-027. Six controllers would have been
  // five upload paths; one controller over five services is the framework's
  // shape, and each service knows only its own specialty's arithmetic.
  CardiologyService,
  PulmonologyService,
  EntService,
  DentalService,
  DermatologyService,

  // OP-015, OP-017, OP-011, OP-035. One spine service and three disciplines,
  // because the episode, the goal, the session and the bill are the same rows
  // in all four — and a fourth copy of "a course of sessions" would be four
  // places to fix the day somebody notices sessions billed twice.
  TherapyService,
  WoundService,
  NutritionService,
  SpeechService,

  // OP-016. On its own, because its rules are governance rather than clinical
  // arithmetic: the morphine equivalent, the second reviewer, the treatment
  // agreement and the annual steroid ceiling.
  PainService,

  // OP-013, OP-014. Both run people through a plan rather than a consultation,
  // and in both the characteristic mistake is the right thing in the wrong
  // order — a dose three days early, a sugar drawn before the breakfast.
  ImmunisationService,
  HealthCheckService,
  DialysisService,
  AntenatalService,
  LabourService,
  OncologyService,
  PsychiatryService,
  LifespanService,
  TransplantService,

  // OP-018, OP-021, IP-020. Three modules with one failure between them: the
  // hand-off happens, and then nobody watches for what should come back.
  HandoffsService,

  // OP-037. Five systems India regulates as medicine, and the boundary on all
  // five is a council registration the database reads rather than a role.
  AyushService,
];

@Module({
  imports: [forwardRef(() => AppModule)],
  controllers: SPECIALTY_CONTROLLERS,
  providers: SPECIALTY_PROVIDERS,
  exports: [
    SpecialtyService,
    OphthalmologyService,
    CardiologyService,
    PulmonologyService,
    EntService,
    DentalService,
    DermatologyService,
    TherapyService,
    WoundService,
    NutritionService,
    SpeechService,
    PainService,
    ImmunisationService,
    HealthCheckService,
  ],
})
export class SpecialtyModule {}
