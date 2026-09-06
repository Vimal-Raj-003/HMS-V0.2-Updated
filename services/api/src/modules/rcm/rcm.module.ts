import { Module, forwardRef, type Provider, type Type } from '@nestjs/common';
import { AppModule } from '../../app.module.js';
import { NumberingService } from '../../core/numbering/numbering.service.js';
import { BillingController } from './billing/billing.controller.js';
import { BillingService } from './billing/billing.service.js';
import { EstimatesController } from './estimates/estimates.controller.js';
import { EstimatesService } from './estimates/estimates.service.js';
import { InsuranceController } from './insurance/insurance.controller.js';
import { InsuranceService } from './insurance/insurance.service.js';
import { LeakageController } from './leakage/leakage.controller.js';
import { LeakageService } from './leakage/leakage.service.js';
import { PackagesController } from './packages/packages.controller.js';
import { PackagesService } from './packages/packages.service.js';
import { PayoutsController } from './payouts/payouts.controller.js';
import { PayoutsService } from './payouts/payouts.service.js';
import { PaymentsController } from './payments/payments.controller.js';
import { PaymentsService } from './payments/payments.service.js';
import { SchemesController } from './schemes/schemes.controller.js';
import { SchemesService } from './schemes/schemes.service.js';
import { TariffController } from './tariff/tariff.controller.js';
import { TariffService } from './tariff/tariff.service.js';

/**
 * Phase 5 — revenue cycle.
 *
 * RC-003 (tariff) is the first and, today, the only member. `phase-05` fixes the
 * build order — RC-003 → OP-005 → EN-010 → OP-023 → EN-002/RC-002 → RC-007 →
 * RC-008 → RC-006 → NC-034 — and the reason RC-003 leads is that every one of
 * those calls `resolveRate`. A billing module written first would have to invent
 * a price column, and a hospital with two prices for one service does not find
 * out until an auditor asks which is right.
 *
 * `TariffService` is exported because OP-005 will resolve rates through it
 * inside its own transaction, the same shape `StockLedgerService` has in
 * `InventoryModule`: one writer, one resolver, no second path.
 */
export const RCM_CONTROLLERS: Type<unknown>[] = [
  TariffController,
  BillingController,
  PaymentsController,
  PackagesController,
  InsuranceController,
  SchemesController,
  EstimatesController,
  LeakageController,
  PayoutsController,
];

/**
 * `NumberingService` is listed because OP-005 burns `BILL_OP` and `CREDIT_NOTE`,
 * RC-007 burns `SCHEME_CASE` and `SCHEME_CLAIM`, RC-008 burns `ESTIMATE`, and NC-034 burns `PAYOUT`.
 * `AppModule` already provides it, so spread into it the duplicate collapses to
 * one provider — the same treatment `INVENTORY_PROVIDERS` gets.
 */
export const RCM_PROVIDERS: Provider[] = [
  NumberingService,
  TariffService,
  BillingService,
  PaymentsService,
  PackagesService,
  InsuranceService,
  SchemesService,
  EstimatesService,
  LeakageService,
  PayoutsService,
];

@Module({
  imports: [forwardRef(() => AppModule)],
  controllers: RCM_CONTROLLERS,
  providers: RCM_PROVIDERS,
  exports: [
    TariffService,
    BillingService,
    PaymentsService,
    PackagesService,
    InsuranceService,
    // RC-007 is exported because every collection point has to ask it whether
    // this patient may tender cash before it opens a drawer.
    SchemesService,
    EstimatesService,
    // RC-006 is exported because the discharge path in Phase 7 has to run the
    // missed-charge check before it lets a patient leave.
    LeakageService,
    PayoutsService,
  ],
})
export class RcmModule {}
