import { Module, type Provider } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { IdempotencyService } from './idempotency.service.js';

/**
 * **To wire this up**, spread `IDEMPOTENCY_PROVIDERS` into `AppModule`'s
 * `providers` array, next to the three global guards:
 *
 * ```ts
 * providers: [
 *   …,
 *   { provide: APP_GUARD, useClass: PolicyGuard },
 *   ...IDEMPOTENCY_PROVIDERS,
 * ],
 * ```
 *
 * `APP_INTERCEPTOR` and not a per-controller `@UseInterceptors()`, for the same
 * reason the guards are global: a route that carries `@Idempotent()` in a module
 * whose author forgot to attach the interceptor would look protected in review
 * and take a double payment in production. Registered globally, the decorator is
 * the only thing that has to be remembered, and the interceptor is a no-op on
 * every route that does not carry it.
 *
 * `IdempotencyModule` exists for suites and for any module composed on its own;
 * it needs `DatabaseService` from the importing graph, exactly as `QueueModule`
 * and `CashModule` do.
 */
export const IDEMPOTENCY_PROVIDERS: readonly Provider[] = [
  IdempotencyService,
  { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
];

@Module({
  providers: [...IDEMPOTENCY_PROVIDERS],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
