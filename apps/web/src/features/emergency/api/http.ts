/**
 * The emergency feature's HTTP plumbing.
 *
 * The same transport every other feature uses, for the same two reasons:
 * `ProblemCard` does an `instanceof ApiProblem` check, so a second class would
 * render an ER refusal as the generic "This did not load"; and every POST under
 * `/er` is `@Idempotent()` with an interceptor that fails closed — a tablet in a
 * resus bay that retries on a dropped connection must not create two visits.
 */
export {
  newIdempotencyKey,
  queryString,
  request,
  type ClinicalRequest as EmergencyRequest,
} from '@/features/clinical/api/http';
