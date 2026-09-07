import { Injectable } from '@nestjs/common';
import { ProblemType, newId } from '@vims/contracts';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from '../consoles/consoles.events.js';
import {
  ConsoleSupport,
  asBool,
  asJson,
  asNumberOrNull,
  asStringArray,
  asText,
  asTextOrNull,
} from '../consoles/consoles.support.js';
import type {
  AcknowledgeRequest,
  SlpAssessmentRequest,
  SwallowOrderRequest,
  SwallowQuery,
} from './therapy.schemas.js';
import type { SlpAssessmentRow, SwallowOrderRow } from './therapy.types.js';

/** IDDSI food levels, in the words a kitchen and a ward use. */
const FOOD_LEVELS: Readonly<Record<number, string>> = {
  3: 'liquidised',
  4: 'pureed',
  5: 'minced and moist',
  6: 'soft and bite-sized',
  7: 'regular',
};

/** IDDSI drink levels. */
const FLUID_LEVELS: Readonly<Record<number, string>> = {
  0: 'thin',
  1: 'slightly thick',
  2: 'mildly thick',
  3: 'moderately thick',
  4: 'extremely thick',
};

/**
 * OP-035 — speech, language and swallow.
 *
 * ── The order and the acknowledgement are different methods ────────────────
 *
 * `issueOrder` is the therapist's. `acknowledge` is the kitchen's and the
 * ward's, behind a key neither the therapist nor anybody who cannot change what
 * arrives on a tray holds. Making them one call with a `party` field on the
 * order body would let a therapist tick both boxes on behalf of a kitchen that
 * has never seen it — which is the failure the whole mechanism exists to catch,
 * done tidily.
 *
 * ── The summary is a sentence, not a pair of numbers ───────────────────────
 *
 * "Level 4" means pureed food *and* extremely thick fluid, and which one is
 * meant depends on a column heading the reader may not be looking at.
 * `summary` spells both out — "pureed food, mildly thick fluids" — because the
 * person about to hand somebody a glass of water is reading a banner, not a
 * table.
 */
@Injectable()
export class SpeechService extends ConsoleSupport {
  async recordAssessment(body: SlpAssessmentRequest): Promise<SlpAssessmentRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.slp_assessments
           (id, hospital_id, branch_id, patient_id, episode_id, encounter_id, domains, kind,
            tools, swallow, voice, fluency, language, articulation, severity, dx_codes,
            report_doc_id, form_response_id, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::specialty."SlpDomain"[],$8,
                 $9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,
                 $15,$16::text[],$17,$18,$19, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.episodeId,
          body.encounterId ?? null,
          body.domains,
          body.kind,
          JSON.stringify(body.tools),
          JSON.stringify(body.swallow),
          JSON.stringify(body.voice),
          JSON.stringify(body.fluency),
          JSON.stringify(body.language),
          JSON.stringify(body.articulation),
          body.severity ?? null,
          body.dxCodes,
          body.reportDocId ?? null,
          body.formResponseId ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The assessment was not recorded.');
      return this.toAssessment(row);
    });
  }

  async signAssessment(id: string): Promise<SlpAssessmentRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.slp_assessments
            SET signed_by = $3, signed_at = now(), updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND signed_at IS NULL
          RETURNING *`,
        [this.hospitalId(), id, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That assessment does not exist, or it is already signed.');
      }
      return this.toAssessment(row);
    });
  }

  /**
   * Write a swallow order.
   *
   * It starts `pending`, which is the point: the tray being plated right now
   * was decided before this existed, and it will keep being plated that way
   * until the kitchen says otherwise.
   */
  async issueOrder(body: SwallowOrderRequest): Promise<SwallowOrderRow> {
    return this.guard(async (tx) => {
      // Replacing a live order is explicit, so a second one cannot be written
      // by accident and then blocked by the index with a message about a
      // constraint.
      if (body.supersedesId !== undefined) {
        const { rows: superseded } = await tx.query<Record<string, unknown>>(
          `UPDATE specialty.slp_swallow_orders
              SET status = 'superseded', change_reason = $3, updated_at = now()
            WHERE hospital_id = $1 AND id = $2 AND status IN ('pending','active')
            RETURNING id`,
          [this.hospitalId(), body.supersedesId, body.changeReason ?? 'Replaced by a new order.'],
        );
        if (superseded[0] === undefined) {
          throw AppError.conflict('The order being replaced is not live. Refresh and try again.');
        }
      }

      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.slp_swallow_orders
           (id, hospital_id, branch_id, patient_id, episode_id, assessment_id, admission_id,
            npo, food_level, fluid_level, strategies, status, effective_from,
            ordered_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'pending', now(),$12, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.episodeId,
          body.assessmentId,
          body.admissionId ?? null,
          body.npo,
          body.foodLevel ?? null,
          body.fluidLevel ?? null,
          JSON.stringify(body.strategies),
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The swallow order was not written.');

      await this.outbox.publish(
        tx,
        consoleEvent('slp.swallow_order.issued', id, {
          orderId: id,
          patientId: body.patientId,
          admissionId: body.admissionId ?? null,
          npo: body.npo,
          foodLevel: body.foodLevel ?? null,
          fluidLevel: body.fluidLevel ?? null,
          supersedesId: body.supersedesId ?? null,
        }),
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'swallow_order',
        rowId: id,
        businessKey: body.patientId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        before: null,
        after: {
          npo: body.npo,
          foodLevel: body.foodLevel ?? null,
          fluidLevel: body.fluidLevel ?? null,
        },
      });

      return this.toOrder(row);
    });
  }

  /**
   * The kitchen or the ward says it has read the order.
   *
   * The actor is the session's, and the same person cannot acknowledge for both
   * — one person reading a piece of paper twice does not mean two departments
   * have changed what they are doing.
   */
  async acknowledge(id: string, body: AcknowledgeRequest): Promise<SwallowOrderRow> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      const { rows: existing } = await tx.query<Record<string, unknown>>(
        `SELECT ordered_by, ack_kitchen_by, ack_ward_by, status
           FROM specialty.slp_swallow_orders WHERE hospital_id = $1 AND id = $2`,
        [this.hospitalId(), id],
      );
      const order = existing[0];
      if (order === undefined) throw AppError.notFound('That swallow order does not exist.');

      if (asText(order['ordered_by']) === actor) {
        throw new AppError(
          ProblemType.VALIDATION_FAILED,
          'The person who wrote a swallow order cannot acknowledge it. The acknowledgement is the kitchen and the ward saying they have read it and will change what they send.',
        );
      }

      const other = body.party === 'kitchen' ? order['ack_ward_by'] : order['ack_kitchen_by'];
      if (asTextOrNull(other) === actor) {
        throw new AppError(
          ProblemType.VALIDATION_FAILED,
          'One person cannot acknowledge for both the kitchen and the ward. Reading it twice does not mean two departments changed what they are doing.',
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.slp_swallow_orders
            SET ack_kitchen_by = CASE WHEN $3 = 'kitchen' THEN $4 ELSE ack_kitchen_by END,
                ack_kitchen_at = CASE WHEN $3 = 'kitchen' THEN now() ELSE ack_kitchen_at END,
                ack_ward_by    = CASE WHEN $3 = 'ward'    THEN $4 ELSE ack_ward_by END,
                ack_ward_at    = CASE WHEN $3 = 'ward'    THEN now() ELSE ack_ward_at END,
                -- The order comes into force the moment the second one lands,
                -- and not a moment before.
                status = CASE
                  WHEN ($3 = 'kitchen' AND ack_ward_at IS NOT NULL)
                    OR ($3 = 'ward' AND ack_kitchen_at IS NOT NULL)
                  THEN 'active'::specialty."SwallowOrderStatus"
                  ELSE status
                END,
                updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND status = 'pending'
          RETURNING *`,
        [this.hospitalId(), id, body.party, actor],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That order is not waiting to be acknowledged.');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'swallow_order',
        rowId: id,
        businessKey: asText(row['patient_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: null,
        before: null,
        after: { acknowledgedBy: body.party, status: asText(row['status']) },
      });

      return this.toOrder(row);
    });
  }

  async listOrders(query: SwallowQuery): Promise<readonly SwallowOrderRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.slp_swallow_orders
          WHERE hospital_id = $1
            AND ($2::uuid IS NULL OR patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE
                 OR (status = 'pending'))
          ORDER BY status = 'pending' DESC, effective_from DESC
          LIMIT $4`,
        [this.hospitalId(), query.patientId ?? null, query.awaitingAckOnly, query.limit],
      );
      return rows.map((r) => this.toOrder(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shaping
  // ═══════════════════════════════════════════════════════════════════════════

  private toAssessment(row: Record<string, unknown>): SlpAssessmentRow {
    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      episodeId: asText(row['episode_id']),
      domains: asStringArray(row['domains']),
      kind: asText(row['kind']),
      swallow: asJson(row['swallow']),
      severity: asTextOrNull(row['severity']),
      dxCodes: asStringArray(row['dx_codes']),
      signedBy: asTextOrNull(row['signed_by']),
      signedAt: asTextOrNull(row['signed_at']),
      createdAt: asText(row['created_at']),
    };
  }

  private toOrder(row: Record<string, unknown>): SwallowOrderRow {
    const npo = asBool(row['npo']);
    const food = asNumberOrNull(row['food_level']);
    const fluid = asNumberOrNull(row['fluid_level']);
    const kitchenAt = asTextOrNull(row['ack_kitchen_at']);
    const wardAt = asTextOrNull(row['ack_ward_at']);
    const status = asText(row['status']);
    const live = status === 'pending' || status === 'active';

    // Spelled out, because "level 4" means two different things and the person
    // about to hand somebody a glass of water is reading a banner.
    const summary = npo
      ? 'Nil by mouth'
      : `${FOOD_LEVELS[food ?? -1] ?? `food level ${String(food)}`} food, ` +
        `${FLUID_LEVELS[fluid ?? -1] ?? `level ${String(fluid)}`} fluids`;

    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      episodeId: asText(row['episode_id']),
      assessmentId: asText(row['assessment_id']),
      admissionId: asTextOrNull(row['admission_id']),
      npo,
      foodLevel: food,
      fluidLevel: fluid,
      strategies: asJson(row['strategies']),
      status,
      effectiveFrom: asText(row['effective_from']),
      endedAt: asTextOrNull(row['ended_at']),
      orderedBy: asText(row['ordered_by']),
      ackKitchenAt: kitchenAt,
      ackWardAt: wardAt,
      changeReason: asTextOrNull(row['change_reason']),
      awaitingKitchen: live && kitchenAt === null,
      awaitingWard: live && wardAt === null,
      inForce: status === 'active',
      summary,
    };
  }
}
