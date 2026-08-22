import { Module, forwardRef, type Provider, type Type } from '@nestjs/common';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { AppModule } from '../../../app.module.js';
import { AppointmentsController } from './appointments.controller.js';
import { AppointmentsService } from './appointments.service.js';
import { DoctorSchedulesController } from './doctor-schedules.controller.js';
import { QueueTokensService } from './queue-tokens.service.js';
import { SchedulesService } from './schedules.service.js';
import { VisitsController } from './visits.controller.js';
import { VisitsService } from './visits.service.js';

/**
 * OP-001 §3.4–§3.6 — appointments, OP visits and doctor schedules.
 *
 * The three routes tables it owns are `/appointments`, `/visits` and the
 * schedule half of `/doctors/{id}`.
 *
 * **Wiring.** The module imports `AppModule` through `forwardRef` so that it can
 * be attached either way round without a change here: as
 * `imports: [forwardRef(() => SchedulingModule)]` inside `AppModule`, or from a
 * root module that imports both. The forward reference is what makes the first
 * of those legal — `AppModule` owns `DatabaseService`, `AuditService`,
 * `OutboxService`, `CursorService` and `PolicyService`, and re-declaring them
 * here would give this module its **own** connection pool and its own policy
 * cache, which is a second set of database connections and a second answer to
 * "may this user do that".
 *
 * `SCHEDULING_CONTROLLERS` and `SCHEDULING_PROVIDERS` are exported separately so
 * that the alternative wiring — spreading them straight into `AppModule`'s own
 * arrays, as every platform module is wired today — needs no edit here either.
 *
 * `NumberingService` is provided here because nothing has provided it yet: it is
 * stateless, holds no connection of its own and allocates inside the caller's
 * transaction, so an instance per module is not a shared-state hazard. When a
 * second module needs it, it should move to `AppModule`.
 */
export const SCHEDULING_CONTROLLERS: Type<unknown>[] = [
  DoctorSchedulesController,
  AppointmentsController,
  VisitsController,
];

export const SCHEDULING_PROVIDERS: Provider[] = [
  NumberingService,
  QueueTokensService,
  SchedulesService,
  VisitsService,
  AppointmentsService,
];

@Module({
  imports: [forwardRef(() => AppModule)],
  controllers: SCHEDULING_CONTROLLERS,
  providers: SCHEDULING_PROVIDERS,
  exports: [SchedulesService, AppointmentsService, VisitsService],
})
export class SchedulingModule {}
