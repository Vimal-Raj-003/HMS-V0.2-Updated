/**
 * The inventory feature's HTTP plumbing.
 *
 * The same transport the clinical, diagnostics and pharmacy screens use, and for
 * the same two reasons: `ProblemCard` does an `instanceof ApiProblem` check, so
 * a second class would render every store refusal as the generic "This did not
 * load"; and every POST under `/inventory` is `@Idempotent()` with an
 * interceptor that fails closed. A retried issue is a second issue — the ward
 * gets twice the stock and the store's shelf is short by the same — and a retry
 * is exactly what a tablet on a ward's Wi-Fi does when the lift doors close.
 */
export {
  newIdempotencyKey,
  queryString,
  request,
  type ClinicalRequest as InventoryRequest,
} from '@/features/clinical/api/http';
