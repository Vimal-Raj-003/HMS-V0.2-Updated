import type { Redis } from 'ioredis';
import { PrintPermanentError } from './types.js';
import type { PrintPayloadEnvelope, PrintPayloadSource } from './print-dispatcher.js';
import type { PrintJobRecord } from './print-job-repository.js';

/**
 * Where a mounted print worker gets a job's render payload.
 *
 * `EN-005` §5 forbids storing the document in `core.print_jobs` ("job payload
 * never contains raw PHI beyond what the document shows"), and the EN-039
 * render-job cache that will own this properly does not exist in Phase 0. So
 * the producer writes the envelope to a short-lived Redis key next to the
 * BullMQ job, and this reads it back.
 *
 * Two deliberate choices:
 *
 * **The key is tenant-scoped** (`docs/07` §4: "cache keys are always
 * tenant-prefixed"), and the lookup uses the *job's* hospital id from the
 * database row rather than anything the queue message carried, so a forged job
 * reference cannot address another tenant's payload.
 *
 * **A missing payload is permanent, not transient.** Retrying a print job whose
 * payload has expired would re-render nothing thirty times over ten minutes and
 * then fail anyway; failing at once puts a real error in front of the person
 * waiting at the counter.
 */
export function printPayloadKey(hospitalId: string, jobId: string): string {
  return `h:${hospitalId}:print:payload:${jobId}`;
}

export class RedisPayloadSource implements PrintPayloadSource {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async load(job: PrintJobRecord): Promise<PrintPayloadEnvelope> {
    const raw = await this.#redis.get(printPayloadKey(job.hospitalId, job.id));
    if (raw === null) {
      throw new PrintPermanentError(
        `No render payload is available for print job ${job.id}. It either expired or was never written by the producer (EN-039 render cache).`,
      );
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('payload' in parsed) || !('context' in parsed)) {
      throw new PrintPermanentError(
        `The render payload for print job ${job.id} is not a { payload, context } envelope.`,
      );
    }
    return parsed as PrintPayloadEnvelope;
  }
}
