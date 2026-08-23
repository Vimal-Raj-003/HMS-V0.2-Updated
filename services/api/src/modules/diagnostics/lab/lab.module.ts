import { Module, forwardRef, type Provider, type Type } from '@nestjs/common';
import { AppModule } from '../../../app.module.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { LabCatalogueService } from './catalogue.service.js';
import { LabCriticalValueController } from './critical.controller.js';
import { LabCriticalValueService } from './critical.service.js';
import { LabCatalogueController, LabOrdersController } from './lab.controller.js';
import { LabOrdersService } from './orders.service.js';
import { LabQcController } from './qc.controller.js';
import { LabQcService } from './qc.service.js';
import { LabReportsController } from './reports.controller.js';
import { LabReportsService } from './reports.service.js';
import { LabResultsController } from './results.controller.js';
import { LabResultsService } from './results.service.js';
import { LabSamplesController } from './samples.controller.js';
import { LabSamplesService } from './samples.service.js';

/**
 * OP-004 / EN-031 — the laboratory information system, order to report.
 *
 * **Wiring.** `LAB_CONTROLLERS` and `LAB_PROVIDERS` are exported separately so
 * they can be spread straight into `AppModule`'s own arrays — the way every
 * module in this application is wired, and the reason there is one connection
 * pool rather than one per feature. `LabModule` exists for the alternative
 * shape (`imports: [forwardRef(() => LabModule)]`) and is the same list, so
 * neither needs an edit here.
 *
 * `NumberingService` is listed because a lab order burns the `LAB_ACC` series
 * and every container burns `SAMPLE`. `AppModule` already provides it, so when
 * these arrays are spread into it the duplicate collapses to one provider — the
 * same treatment `PRESCRIBING_PROVIDERS` gets today. It is stateless and
 * allocates inside the caller's transaction, so a second instance is not a
 * shared-state hazard either way.
 */
export const LAB_CONTROLLERS: Type<unknown>[] = [
  LabCatalogueController,
  LabOrdersController,
  LabSamplesController,
  LabResultsController,
  LabCriticalValueController,
  LabQcController,
  LabReportsController,
];

export const LAB_PROVIDERS: Provider[] = [
  NumberingService,
  LabCatalogueService,
  LabOrdersService,
  LabSamplesService,
  LabResultsService,
  LabCriticalValueService,
  LabQcService,
  LabReportsService,
];

@Module({
  imports: [forwardRef(() => AppModule)],
  controllers: LAB_CONTROLLERS,
  providers: LAB_PROVIDERS,
  exports: [LabOrdersService, LabResultsService, LabCriticalValueService, LabQcService],
})
export class LabModule {}
