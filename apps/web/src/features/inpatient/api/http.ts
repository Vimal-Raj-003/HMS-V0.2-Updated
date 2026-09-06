/**
 * Phase 7's HTTP plumbing.
 *
 * The same transport every other feature uses. `ProblemCard` does an
 * `instanceof ApiProblem` check, so a second transport would render a lost
 * bed-allocation race as the generic "This did not load" — which is the one
 * message this module must never show for that error.
 */
export {
  newIdempotencyKey,
  queryString,
  request,
  type ClinicalRequest as InpatientRequest,
} from '@/features/clinical/api/http';
