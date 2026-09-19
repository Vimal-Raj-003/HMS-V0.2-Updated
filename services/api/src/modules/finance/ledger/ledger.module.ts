import type { Provider, Type } from '@nestjs/common';
import { BudgetController } from '../budget/budget.controller.js';
import { BudgetService } from '../budget/budget.service.js';
import { CorporateController } from '../corporate/corporate.controller.js';
import { CorporateService } from '../corporate/corporate.service.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerService } from './ledger.service.js';

/**
 * NC-009 §3.1 — the general ledger.
 *
 * Arrays spread into `AppModule`, like every other module here: a `@Module`
 * with its own injector would build a second `pg.Pool` against the same
 * database and need a `forwardRef` back through `app.module.ts` to reach the
 * shared guards.
 */
export const LEDGER_CONTROLLERS: readonly Type<unknown>[] = [
  LedgerController,
  CorporateController,
  BudgetController,
];
export const LEDGER_PROVIDERS: readonly Provider[] = [LedgerService, CorporateService, BudgetService];
