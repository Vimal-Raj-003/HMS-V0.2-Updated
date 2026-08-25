import { Module, forwardRef, type Provider, type Type } from '@nestjs/common';
import { AppModule } from '../../app.module.js';
import { NumberingService } from '../../core/numbering/numbering.service.js';
import { AdjustmentsService } from './adjustments.service.js';
import {
  ConsignmentController,
  ConsumptionController,
  CostCentresController,
} from './consignment.controller.js';
import { ConsignmentService } from './consignment.service.js';
import { ConsumptionService } from './consumption.service.js';
import { GrnService } from './grn.service.js';
import { IndentsService } from './indents.service.js';
import { InventoryItemsController, InventoryStoresController } from './items.controller.js';
import { ItemsService } from './items.service.js';
import { InventoryMovementsController } from './movements.controller.js';
import { PurchaseController } from './purchase.controller.js';
import { PurchaseService } from './purchase.service.js';
import { InventoryStockController } from './stock.controller.js';
import { StockLedgerService } from './stock-ledger.service.js';
import { StockService } from './stock.service.js';
import { StoresService } from './stores.service.js';
import { TransfersService } from './transfers.service.js';
import { UomService } from './uom.service.js';
import { VendorsController } from './vendors.controller.js';
import { VendorsService } from './vendors.service.js';

/**
 * NC-005 / NC-006 / NC-007 / NC-008 / NC-021 — the supply chain, item master to
 * vendor payment.
 *
 * **Wiring.** `INVENTORY_CONTROLLERS` and `INVENTORY_PROVIDERS` are exported
 * separately so they can be spread straight into `AppModule`'s own arrays — the
 * way every module in this application is wired, and the reason there is one
 * connection pool rather than one per feature. `InventoryModule` exists for the
 * alternative shape (`imports: [forwardRef(() => InventoryModule)]`) and is the
 * same list, so neither needs an edit here.
 *
 * `NumberingService` is listed because this phase burns eleven series — `ITEM`,
 * `VEND`, `INDENT`, `ISSUE`, `TRANSFER`, `ADJ`, `COUNT`, `IND`, `RFQ`, `PO`,
 * `GRN`, `PRN`, `VINV`, `CONS`, `CSN_IN`. `AppModule` already provides it, so
 * when these arrays are spread into it the duplicate collapses to one provider —
 * the same treatment `LAB_PROVIDERS` gets today. It is stateless and allocates
 * inside the caller's transaction, so a second instance would not be a
 * shared-state hazard either way.
 *
 * **`StockLedgerService` is exported deliberately.** `modules/pharmacy` writes
 * dispensing movements through it, and NC-006 §6 names exactly that shape —
 * "internal service API (not public): `postMovement(tx, movement[])` used by
 * NC-005/OP-003/NC-007/NC-008 inside their transactions". It is the single
 * writer of `inventory.stock_ledger`; a second path into that table is the one
 * change this phase must not accept.
 */
export const INVENTORY_CONTROLLERS: Type<unknown>[] = [
  InventoryItemsController,
  InventoryStoresController,
  InventoryStockController,
  InventoryMovementsController,
  PurchaseController,
  VendorsController,
  ConsignmentController,
  ConsumptionController,
  CostCentresController,
];

export const INVENTORY_PROVIDERS: Provider[] = [
  NumberingService,
  UomService,
  StockLedgerService,
  ItemsService,
  StoresService,
  StockService,
  IndentsService,
  TransfersService,
  AdjustmentsService,
  VendorsService,
  PurchaseService,
  GrnService,
  ConsignmentService,
  ConsumptionService,
];

@Module({
  imports: [forwardRef(() => AppModule)],
  controllers: INVENTORY_CONTROLLERS,
  providers: INVENTORY_PROVIDERS,
  exports: [StockLedgerService, UomService, ItemsService, StoresService, StockService],
})
export class InventoryModule {}
