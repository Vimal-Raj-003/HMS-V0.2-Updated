/**
 * The diagnostics feature's HTTP plumbing.
 *
 * It is deliberately the *same* transport the clinical screens use rather than a
 * second copy. Two reasons, and neither is tidiness:
 *
 *  1. `ProblemCard` does an `instanceof ApiProblem` check. A second `ApiProblem`
 *     class — which a duplicated `http.ts` would produce — renders every
 *     laboratory refusal as the generic "This did not load", with no reference
 *     id and no `nextAction`. On a PC-PNDT refusal or a QC lockout that is the
 *     difference between an instruction and a shrug.
 *  2. Every write in this feature is `@Idempotent()` on the API side and the
 *     interceptor **fails closed**: a POST with no `Idempotency-Key` is refused
 *     with 400 rather than executed. A retried accessioning must not produce two
 *     specimens, and a retried critical-value call-back must not appear twice in
 *     a NABL register.
 *
 * `packages/*` and `services/*` are outside this change's remit, so the header
 * still cannot be added to `@/lib/api`'s `apiFetch`; when it grows an
 * `idempotencyKey` option, `features/clinical/api/http.ts` becomes a one-line
 * delegation and this file follows it.
 */
export {
  newIdempotencyKey,
  queryString,
  request,
  type ClinicalRequest as DiagnosticsRequest,
} from '@/features/clinical/api/http';
