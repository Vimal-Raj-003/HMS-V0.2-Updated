/**
 * Store-and-forward: the second half of exit gate 7.
 *
 * The ingress has already made the analyzer's acknowledgement independent of
 * the laboratory. This is what carries the buffered frames the rest of the way,
 * and its three rules are the whole design:
 *
 *  1. **Oldest first, one at a time.** A preliminary result and its correction
 *     must be applied in the order the analyzer produced them.
 *  2. **A transient failure stops the queue.** When the laboratory cannot be
 *     reached, the message stays `buffered`, nothing after it is attempted, and
 *     a downtime row opens. Skipping ahead would reorder the queue; discarding
 *     would lose it.
 *  3. **A terminal failure moves aside.** An unknown barcode, an unmapped code
 *     or an identity mismatch becomes an `lab_if_error_queue` row and the queue
 *     *keeps moving* — because one unaccessioned tube must not stop a
 *     haematology line for the rest of the shift, and because that row, paired
 *     with the retained frame, is what makes the result replayable later.
 *
 * ── No transaction is held across the sink call ─────────────────────────────
 *
 * The same reasoning as `dispatch/dispatcher.ts`: holding a Postgres connection
 * open for the whole timeout of a service that is not answering is how one dead
 * dependency exhausts the pool and takes the OPD screen down with it. So the
 * batch is read in one transaction, the sink is called with none, and the
 * outcome is recorded in another.
 */
import type { IntegrationDatabase, TenantContext } from '../db/database.js';
import type { AdapterLogger, Clock } from '../adapter/types.js';
import type { AnalyzerResultBatch } from './canonical.js';
import { LabInstrumentDowntimeLog } from './downtime-log.js';
import { DriverParseError, type AnalyzerDriver } from './driver.js';
import { LabIfErrorQueue } from './error-queue.js';
import { InstrumentCodeIndex, mapObservations } from './mapping.js';
import { LabIfMessageStore, type LabIfMessageRow, type LabIfMessageHandle } from './message-store.js';
import type { InstrumentStore } from './instrument-store.js';
import type {
  AnalyzerInstrument,
  LabIfErrorType,
  LabResultDelivery,
  LabResultOutcome,
  LabResultSink,
} from './types.js';

export interface AnalyzerForwarderDeps {
  readonly db: IntegrationDatabase;
  readonly sink: LabResultSink;
  readonly instruments: InstrumentStore;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly logger: AdapterLogger;
  readonly messages?: LabIfMessageStore;
  readonly errors?: LabIfErrorQueue;
  readonly downtime?: LabInstrumentDowntimeLog;
}

export interface DrainReport {
  readonly attempted: number;
  readonly applied: number;
  /** Moved to the unmatched/error queue. Retained, replayable, not lost. */
  readonly queued: number;
  /** Still buffered because the laboratory was unreachable. */
  readonly deferred: number;
  /** True when the queue stopped early to preserve order. */
  readonly stopped: boolean;
  readonly downtimeId?: string;
  readonly remaining: number;
}

/** Which error-queue row an outcome produces. `unavailable` produces none. */
function errorTypeFor(outcome: LabResultOutcome | undefined): LabIfErrorType | undefined {
  if (outcome === undefined) return undefined;
  switch (outcome.status) {
    case 'unmatched_sample':
      return 'unmatched_sample';
    case 'rejected_sample':
      return 'rejected_sample';
    case 'patient_mismatch':
      return 'patient_mismatch';
    case 'result_after_final':
      return 'result_after_final';
    case 'instrument_not_live':
      return 'instrument_not_live';
    case 'applied':
    case 'duplicate':
    case 'unavailable':
      return undefined;
    default:
      return undefined;
  }
}

interface BatchResolution {
  /** `undefined` when nothing in the batch was mapped, so the sink was never called. */
  readonly outcome: LabResultOutcome | undefined;
  readonly batch: AnalyzerResultBatch;
  readonly unmappedCodes: readonly string[];
}

export class AnalyzerForwarder {
  private readonly messages: LabIfMessageStore;
  private readonly errors: LabIfErrorQueue;
  private readonly downtime: LabInstrumentDowntimeLog;
  /** The open downtime per instrument, so the ingress can count against it. */
  private readonly outages = new Map<string, string>();

  constructor(private readonly deps: AnalyzerForwarderDeps) {
    this.messages = deps.messages ?? new LabIfMessageStore();
    this.errors = deps.errors ?? new LabIfErrorQueue();
    this.downtime = deps.downtime ?? new LabInstrumentDowntimeLog();
  }

  /** The open downtime for an instrument, if the laboratory is currently unreachable. */
  currentOutage(instrumentId: string): string | undefined {
    return this.outages.get(instrumentId);
  }

  async drain(
    ctx: TenantContext,
    instrument: AnalyzerInstrument,
    driver: AnalyzerDriver,
    options: { readonly limit?: number } = {},
  ): Promise<DrainReport> {
    const limit = options.limit ?? 100;
    const rows = await this.deps.db.withTenant(ctx, (tx) =>
      this.messages.claimBuffered(tx, instrument.id, limit),
    );
    const maps = await this.deps.instruments.testMaps(ctx, instrument.id);
    const index = new InstrumentCodeIndex(maps);

    let applied = 0;
    let queued = 0;
    let deferred = 0;
    let stopped = false;

    for (const row of rows) {
      const result = await this.forwardOne(ctx, instrument, driver, index, row);
      if (result === 'deferred') {
        deferred += 1;
        stopped = true;
        break;
      }
      if (result === 'queued') queued += 1;
      else applied += 1;
    }

    const remaining = await this.deps.db.withTenant(ctx, (tx) =>
      this.messages.countBuffered(tx, instrument.id),
    );

    // Recovery: the laboratory answered and nothing is left waiting, so the
    // outage is over and its arithmetic can be closed.
    if (!stopped && remaining === 0) await this.closeOutage(ctx, instrument);

    const downtimeId = this.outages.get(instrument.id);
    return {
      attempted: rows.length,
      applied,
      queued,
      deferred,
      stopped,
      remaining,
      ...(downtimeId === undefined ? {} : { downtimeId }),
    };
  }

  private async forwardOne(
    ctx: TenantContext,
    instrument: AnalyzerInstrument,
    driver: AnalyzerDriver,
    index: InstrumentCodeIndex,
    row: LabIfMessageRow,
  ): Promise<'applied' | 'queued' | 'deferred'> {
    const handle: LabIfMessageHandle = { id: row.id, receivedAt: row.received_at_text };
    const now = this.deps.clock.now();

    if (row.raw === null) {
      await this.terminal(ctx, instrument, handle, {
        errorCode: 'raw_purged',
        errorText: 'the raw frame is past its retention window and can no longer be interpreted',
        type: 'parse_error',
        sampleIdRaw: row.sample_id_raw,
        at: now,
      });
      return 'queued';
    }

    let batches: readonly AnalyzerResultBatch[];
    try {
      const inbound = driver.read(row.raw, instrument);
      if (inbound.kind !== 'results') {
        await this.deps.db.withTenant(ctx, (tx) =>
          this.messages.settle(tx, handle, { status: 'parsed', at: now }),
        );
        return 'applied';
      }
      batches = inbound.batches;
    } catch (error) {
      const code = error instanceof DriverParseError ? error.code : 'parse_error';
      await this.terminal(ctx, instrument, handle, {
        errorCode: code,
        errorText: error instanceof Error ? error.message : 'the retained frame no longer parses',
        type: 'parse_error',
        sampleIdRaw: row.sample_id_raw,
        at: now,
      });
      return 'queued';
    }

    const resolutions: BatchResolution[] = [];
    for (const batch of batches) {
      const { mapped, unmapped } = mapObservations(batch.observations, index);
      const delivery: LabResultDelivery = {
        hospitalId: instrument.hospitalId,
        branchId: instrument.branchId,
        instrumentId: instrument.id,
        instrumentCode: instrument.code,
        protocol: batch.protocol,
        messageId: row.id,
        receivedAt: new Date(row.received_at_text),
        batch,
        observations: mapped,
        unmapped,
      };

      // Nothing recognisable in the whole batch: there is no value to apply, so
      // it goes straight to the queue as `unmapped_code`. An admin maps it and
      // replays, which `EN-004 §14.5` requires to apply without duplication.
      if (mapped.length === 0 && unmapped.length > 0) {
        resolutions.push({
          outcome: undefined,
          batch,
          unmappedCodes: unmapped.map((entry) => entry.observation.instrumentCode),
        });
        continue;
      }

      const outcome = batch.isControl
        ? await this.deliverControl(delivery)
        : await this.deps.sink.deliver(delivery);

      resolutions.push({
        outcome,
        batch,
        unmappedCodes: unmapped.map((entry) => entry.observation.instrumentCode),
      });

      if (outcome.status === 'unavailable') break;
    }

    const unavailable = resolutions.find((entry) => entry.outcome?.status === 'unavailable');
    if (unavailable !== undefined) {
      const reason =
        unavailable.outcome?.status === 'unavailable' ? unavailable.outcome.reason : 'unavailable';
      await this.openOutage(ctx, instrument, reason);
      await this.deps.db.withTenant(ctx, (tx) => this.messages.deferred(tx, handle, reason));
      this.deps.logger.warn(
        { instrumentId: instrument.id, messageId: row.id },
        'laboratory unreachable: the analyzer message stays buffered and the queue holds its order',
      );
      return 'deferred';
    }

    const problems = resolutions.filter((entry) => errorTypeFor(entry.outcome) !== undefined);
    const unmappedOnly = resolutions.filter(
      (entry) => entry.unmappedCodes.length > 0 && errorTypeFor(entry.outcome) === undefined,
    );

    if (problems.length === 0 && unmappedOnly.length === 0) {
      const sampleId = resolutions
        .map((entry) =>
          entry.outcome?.status === 'applied' || entry.outcome?.status === 'duplicate'
            ? entry.outcome.sampleId
            : null,
        )
        .find((id): id is string => id !== null);
      await this.deps.db.withTenant(ctx, (tx) =>
        this.messages.settle(tx, handle, {
          status: 'applied',
          sampleId: sampleId ?? null,
          at: now,
        }),
      );
      await this.resolveOpenQueueItems(ctx, instrument, row, now);
      return 'applied';
    }

    await this.deps.db.withTenant(ctx, async (tx) => {
      const first = problems[0] ?? unmappedOnly[0];
      const type = first === undefined ? 'unmapped_code' : (errorTypeFor(first.outcome) ?? 'unmapped_code');
      await this.messages.fail(tx, handle, {
        status: 'error',
        errorCode: type,
        errorText: describe(problems, unmappedOnly),
        at: now,
      });

      for (const entry of problems) {
        const errorType = errorTypeFor(entry.outcome);
        if (errorType === undefined) continue;
        const existing = await this.errors.openForSpecimen(tx, instrument.id, entry.batch.specimenIdRaw);
        if (existing !== undefined && existing.type === errorType) continue;
        const outcome = entry.outcome;
        const suggestion =
          outcome !== undefined && outcome.status === 'unmatched_sample' ? outcome.suggestion : undefined;
        await this.errors.record(tx, {
          id: this.deps.newId(),
          hospitalId: instrument.hospitalId,
          branchId: instrument.branchId,
          instrumentId: instrument.id,
          messageId: row.id,
          messageReceivedAt: row.received_at_text,
          type: errorType,
          sampleIdRaw: entry.batch.specimenIdRaw,
          ...(suggestion === undefined
            ? {}
            : { suggestedSampleId: suggestion.sampleId, suggestionBasis: suggestion.basis }),
          at: now,
        });
      }

      for (const entry of unmappedOnly) {
        for (const code of new Set(entry.unmappedCodes)) {
          await this.errors.record(tx, {
            id: this.deps.newId(),
            hospitalId: instrument.hospitalId,
            branchId: instrument.branchId,
            instrumentId: instrument.id,
            messageId: row.id,
            messageReceivedAt: row.received_at_text,
            type: 'unmapped_code',
            sampleIdRaw: entry.batch.specimenIdRaw,
            instrumentCodeRaw: code,
            at: now,
          });
        }
      }
    });

    this.deps.logger.info(
      { instrumentId: instrument.id, messageId: row.id },
      'analyzer message queued for review: it named something this laboratory does not know',
    );
    return 'queued';
  }

  private async deliverControl(delivery: LabResultDelivery): Promise<LabResultOutcome> {
    const deliverControl = this.deps.sink.deliverControl?.bind(this.deps.sink);
    if (deliverControl === undefined) {
      return { status: 'unmatched_sample' };
    }
    const outcome = await deliverControl(delivery);
    switch (outcome.status) {
      case 'applied':
        return { status: 'applied', sampleId: delivery.batch.specimenIdRaw, resultCount: outcome.runCount };
      case 'unavailable':
        return { status: 'unavailable', reason: outcome.reason };
      case 'unassigned':
        return { status: 'unmatched_sample' };
      default:
        return { status: 'unmatched_sample' };
    }
  }

  /**
   * `EN-004 §14.3`: an unmatched result "auto-resolves when the sample is
   * accessioned within 24 h".
   *
   * This is the only automatic closure, and it is not a guess: the same barcode
   * resolved in OP-004 because the specimen now exists, which is a real
   * identity match performed by the module that owns identity. Nothing here
   * ever writes `resolved_sample_id` — the CHECK constraint would refuse it
   * without a person, and it should.
   */
  private async resolveOpenQueueItems(
    ctx: TenantContext,
    instrument: AnalyzerInstrument,
    row: LabIfMessageRow,
    at: Date,
  ): Promise<void> {
    if (row.sample_id_raw === null) return;
    await this.deps.db.withTenant(ctx, async (tx) => {
      const open = await this.errors.openForSpecimen(tx, instrument.id, row.sample_id_raw ?? '');
      if (open === undefined || open.type !== 'unmatched_sample') return;
      await this.errors.autoResolve(tx, open.id, at);
    });
  }

  private async terminal(
    ctx: TenantContext,
    instrument: AnalyzerInstrument,
    handle: LabIfMessageHandle,
    input: {
      readonly errorCode: string;
      readonly errorText: string;
      readonly type: LabIfErrorType;
      readonly sampleIdRaw: string | null;
      readonly at: Date;
    },
  ): Promise<void> {
    await this.deps.db.withTenant(ctx, async (tx) => {
      await this.messages.fail(tx, handle, {
        status: 'error',
        errorCode: input.errorCode,
        errorText: input.errorText,
        at: input.at,
      });
      await this.errors.record(tx, {
        id: this.deps.newId(),
        hospitalId: instrument.hospitalId,
        branchId: instrument.branchId,
        instrumentId: instrument.id,
        messageId: handle.id,
        messageReceivedAt: handle.receivedAt,
        type: input.type,
        sampleIdRaw: input.sampleIdRaw,
        at: input.at,
      });
    });
  }

  private async openOutage(
    ctx: TenantContext,
    instrument: AnalyzerInstrument,
    reason: string,
  ): Promise<void> {
    if (this.outages.has(instrument.id)) return;
    const now = this.deps.clock.now();
    const row = await this.deps.db.withTenant(ctx, async (tx) => {
      const opened = await this.downtime.open(tx, {
        id: this.deps.newId(),
        hospitalId: instrument.hospitalId,
        branchId: instrument.branchId,
        instrumentId: instrument.id,
        type: 'comm',
        reason: `laboratory unreachable: ${reason}`,
        at: now,
      });
      // Everything already waiting counts as buffered by this outage, so the
      // closing arithmetic covers the whole queue rather than only what arrived
      // after the failure was noticed.
      const depth = await this.messages.countBuffered(tx, instrument.id);
      if (depth > opened.bufferedCount) {
        await this.downtime.recordBuffered(tx, opened.id, depth - opened.bufferedCount, now);
      }
      return opened;
    });
    this.outages.set(instrument.id, row.id);
    await this.deps.instruments.setBuffering(ctx, instrument.id, true, now);
  }

  private async closeOutage(ctx: TenantContext, instrument: AnalyzerInstrument): Promise<void> {
    const id = this.outages.get(instrument.id);
    if (id === undefined) return;
    const now = this.deps.clock.now();
    // Nothing is buffered, so nothing was lost, and the CHECK constraint
    // `lab_instrument_downtime_replay_accounts` makes that statement checkable.
    const closed = await this.deps.db.withTenant(ctx, (tx) =>
      this.downtime.close(tx, id, { at: now, lostCount: 0 }),
    );
    this.outages.delete(instrument.id);
    await this.deps.instruments.setBuffering(ctx, instrument.id, false, now);
    this.deps.logger.info(
      {
        instrumentId: instrument.id,
        buffered: closed?.bufferedCount ?? 0,
        replayed: closed?.replayedCount ?? 0,
      },
      'analyzer downtime closed: every buffered frame was replayed',
    );
  }
}

function describe(problems: readonly BatchResolution[], unmapped: readonly BatchResolution[]): string {
  const parts: string[] = [];
  for (const entry of problems) parts.push(entry.outcome?.status ?? 'unmapped');
  for (const entry of unmapped) {
    parts.push(`unmapped_code(${[...new Set(entry.unmappedCodes)].join(',')})`);
  }
  return parts.length === 0 ? 'unresolved' : parts.join('; ');
}
