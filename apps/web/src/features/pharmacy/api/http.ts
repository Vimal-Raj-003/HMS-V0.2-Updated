/**
 * The pharmacy feature's HTTP plumbing.
 *
 * Deliberately the *same* transport the clinical and diagnostics screens use
 * rather than a third copy, for two reasons that are not tidiness:
 *
 *  1. `ProblemCard` does an `instanceof ApiProblem` check. A second `ApiProblem`
 *     class — which a duplicated `http.ts` would produce — renders every counter
 *     refusal as the generic "This did not load", with no reference id and no
 *     `nextAction`. On a `clinical-hard-stop` or a `second-person-required` that
 *     is the difference between an instruction and a shrug.
 *  2. Every write in this feature is `@Idempotent()` on the API side and the
 *     interceptor **fails closed**: a POST with no `Idempotency-Key` is refused
 *     with 400 rather than executed. A retried `complete` would dispense twice —
 *     the patient gets one bag and the shelf loses two — and a retry is exactly
 *     what a counter tablet does when the Wi-Fi drops between the till and the
 *     label printer.
 *
 * `packages/*` and `services/*` are outside this change's remit, so the header
 * still cannot be added to `@/lib/api`'s `apiFetch`; when it grows an
 * `idempotencyKey` option this file becomes a one-line delegation.
 */
export {
  newIdempotencyKey,
  queryString,
  request,
  type ClinicalRequest as PharmacyRequest,
} from '@/features/clinical/api/http';
