/**
 * Phase 8's HTTP plumbing.
 *
 * The same transport every other feature uses, for the same reason: `ProblemCard`
 * does an `instanceof ApiProblem` check, and a second transport would render a
 * refused review as the generic "This did not load".
 */
export {
  newIdempotencyKey,
  queryString,
  request,
  type ClinicalRequest as SpecialtyRequest,
} from '@/features/clinical/api/http';
