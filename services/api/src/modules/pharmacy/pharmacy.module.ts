import { Module, forwardRef, type Provider, type Type } from '@nestjs/common';
import { AppModule } from '../../app.module.js';
import { NumberingService } from '../../core/numbering/numbering.service.js';
import { ItemsService } from '../inventory/items.service.js';
import { StockLedgerService } from '../inventory/stock-ledger.service.js';
import { UomService } from '../inventory/uom.service.js';
import { CdssService } from '../opd/prescribing/cdss.service.js';
import { PharmacyCoSignService } from './cosign.service.js';
import { DispenseService } from './dispense.service.js';
import { NarcoticsService } from './narcotics.service.js';
import { PharmacyOpsService } from './pharmacy-ops.service.js';
import {
  PharmacyDispenseController,
  PharmacyNarcoticsController,
  PharmacyOpsController,
  PharmacyQueueController,
  PharmacySubstitutionController,
} from './pharmacy.controller.js';
import { RxQueueService } from './queue.service.js';

/**
 * OP-003 / EN-029 — the pharmacy counter, prescription queue to day close.
 *
 * **Wiring.** `PHARMACY_CONTROLLERS` and `PHARMACY_PROVIDERS` are exported
 * separately so they can be spread straight into `AppModule`'s own arrays — the
 * way every module in this application is wired, and the reason there is one
 * connection pool rather than one per feature. `PharmacyModule` exists for the
 * alternative shape (`imports: [forwardRef(() => PharmacyModule)]`) and is the
 * same list, so neither needs an edit here.
 *
 * **Four of the providers are borrowed rather than owned**, and each is listed
 * for a specific reason:
 *
 *  * `StockLedgerService` and `UomService` (`modules/inventory`) — dispensing is
 *    a stock movement, and NC-006 §6 names exactly this shape: an internal
 *    service API used by OP-003 inside its own transaction. There is no second
 *    path into `inventory.stock_ledger`, and this module must not become one.
 *  * `ItemsService` — for `resolveScan`, which turns one GS1 DataMatrix into an
 *    item, a pack size, a batch and an expiry. Duplicating that parser at the
 *    counter is how the counter's copy drifts from the store's.
 *  * `CdssService` (`modules/opd/prescribing`) — EN-029, re-run at dispensing.
 *    The same engine, the same rule versions and the same safety floor the
 *    prescriber saw: a second implementation of the allergy check is a second
 *    thing that can be wrong.
 *  * `NumberingService` — `DISP`, `PHRET` and the gapless `NARC_REG` serial.
 *
 * Every one of them is stateless and takes the caller's transaction, so when
 * these arrays are spread into `AppModule` the duplicate providers collapse to
 * one instance and nothing changes; when this module is imported standalone,
 * they resolve from `AppModule`'s exports. `PharmacyCoSignService` needs only
 * `DatabaseService` and `PolicyService`, both of which `AppModule` exports,
 * which is what lets the second-person path work in either shape.
 */
export const PHARMACY_CONTROLLERS: Type<unknown>[] = [
  PharmacyQueueController,
  PharmacyDispenseController,
  PharmacySubstitutionController,
  PharmacyNarcoticsController,
  PharmacyOpsController,
];

export const PHARMACY_PROVIDERS: Provider[] = [
  NumberingService,
  UomService,
  StockLedgerService,
  ItemsService,
  CdssService,
  PharmacyCoSignService,
  RxQueueService,
  DispenseService,
  NarcoticsService,
  PharmacyOpsService,
];

@Module({
  imports: [forwardRef(() => AppModule)],
  controllers: PHARMACY_CONTROLLERS,
  providers: PHARMACY_PROVIDERS,
  exports: [DispenseService, RxQueueService, NarcoticsService, PharmacyOpsService],
})
export class PharmacyModule {}
