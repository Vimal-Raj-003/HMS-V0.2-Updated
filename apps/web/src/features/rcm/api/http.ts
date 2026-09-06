/**
 * The RCM feature's HTTP plumbing.
 *
 * The same transport every other feature uses, for the same two reasons:
 * `ProblemCard` does an `instanceof ApiProblem` check, so a second class would
 * render a tariff refusal as the generic "This did not load"; and every POST
 * under `/tariff` is `@Idempotent()` with an interceptor that fails closed.
 */
export {
  newIdempotencyKey,
  queryString,
  request,
  type ClinicalRequest as RcmRequest,
} from '@/features/clinical/api/http';
