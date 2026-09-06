/**
 * The orthopaedic feature's HTTP plumbing.
 *
 * The same transport every other feature uses. `ProblemCard` does an
 * `instanceof ApiProblem` check, so a second transport would render a
 * wrong-site refusal as the generic "This did not load" — which is the one
 * message this module must never show for that error.
 */
export {
  newIdempotencyKey,
  queryString,
  request,
  type ClinicalRequest as OrthoRequest,
} from '@/features/clinical/api/http';
