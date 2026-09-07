import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from '../consoles/consoles.events.js';
import {
  ConsoleSupport,
  asBool,
  asJson,
  asNumber,
  asNumberOrNull,
  asText,
  asTextOrNull,
} from '../consoles/consoles.support.js';
import type {
  CloseWoundRequest,
  DressingRequest,
  OverrideWoundRequest,
  WoundAssessmentRequest,
  WoundPhotoRequest,
  WoundQuery,
  WoundRequest,
} from './therapy.schemas.js';
import type { WoundAssessmentRow, WoundDetail, WoundPhotoRow, WoundRow } from './therapy.types.js';

/**
 * OP-017 — the wound care clinic.
 *
 * ── Nothing here multiplies a length by a width ────────────────────────────
 *
 * The area, the reduction against baseline and the trajectory are all trigger
 * output. What this service adds is `needsReview` and `weeksOpen`, which are
 * read off the stored trajectory rather than recomputed — a second opinion
 * about whether a wound is stalled is a clinic where the list and the chart
 * disagree about which patients to call back.
 *
 * ── Closing an open wound is a different verb ──────────────────────────────
 *
 * `close` handles a wound that has genuinely closed, and the database checks
 * the last measurement. `overrideClose` handles the legitimate exception — a
 * patient who healed elsewhere, or was last seen by somebody with no ruler —
 * and it is a separate route behind a `high` key with a reason. Making it one
 * call with a flag would mean the flag is set by whoever wants the wound off
 * their list.
 */
@Injectable()
export class WoundService extends ConsoleSupport {
  async openWound(body: WoundRequest): Promise<WoundRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.wounds
           (id, hospital_id, branch_id, patient_id, episode_id, wound_no, location_snomed,
            location_text, side, aetiology, onset_date, cause, classification,
            hospital_acquired, incident_id, opened_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,
                 coalesce((SELECT max(wound_no) FROM specialty.wounds
                            WHERE hospital_id = $2 AND patient_id = $4), 0) + 1,
                 $6,$7,$8::clinical."Laterality",$9::specialty."WoundAetiology",
                 $10::date,$11,$12::jsonb,$13,$14,$15, now(), now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.episodeId ?? null,
          body.locationSnomed ?? null,
          body.locationText,
          body.side,
          body.aetiology,
          body.onsetDate ?? null,
          body.cause ?? null,
          JSON.stringify(body.classification),
          body.hospitalAcquired,
          body.incidentId ?? null,
          this.actorId(),
        ],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'wound',
        rowId: id,
        businessKey: body.patientId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        before: null,
        after: {
          aetiology: body.aetiology,
          site: body.locationText,
          hospitalAcquired: body.hospitalAcquired,
        },
      });

      return this.woundWithin(tx, id);
    });
  }

  async assess(woundId: string, body: WoundAssessmentRequest): Promise<WoundDetail> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.wound_assessments
           (id, hospital_id, wound_id, patient_id, assessed_at, assessed_by, context,
            length_cm, width_cm, depth_cm, undermining, tunnelling, tissue_pct,
            exudate, infection_signs, periwound, pain_nrs, odour, probe_to_bone,
            exposed_structures, scores, culture_order_id, notes, created_at, updated_at)
         VALUES ($1,$2,$3,
                 (SELECT patient_id FROM specialty.wounds WHERE id = $3),
                 coalesce($4::timestamptz, now()),$5,$6,$7,$8,$9,
                 $10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,
                 $16,$17,$18,$19::text[],$20::jsonb,$21,$22, now(), now())
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          woundId,
          body.assessedAt ?? null,
          this.actorId(),
          body.context,
          body.lengthCm ?? null,
          body.widthCm ?? null,
          body.depthCm ?? null,
          JSON.stringify(body.undermining),
          JSON.stringify(body.tunnelling),
          JSON.stringify(body.tissuePct),
          JSON.stringify(body.exudate),
          JSON.stringify(body.infectionSigns),
          JSON.stringify(body.periwound),
          body.painNrs ?? null,
          body.odour,
          body.probeToBone,
          body.exposedStructures,
          JSON.stringify(body.scores),
          body.cultureOrderId ?? null,
          body.notes ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The assessment was not recorded.');

      const trajectory = asTextOrNull(row['trajectory']);
      const detail = await this.detailWithin(tx, woundId);

      // A stalled wound is a review by whoever runs the clinic, not a note the
      // same nurse will write again next week.
      if (trajectory === 'stalled' || trajectory === 'deteriorating') {
        await tx.query(
          `UPDATE specialty.wounds SET status = $3::specialty."WoundStatus", updated_at = now()
            WHERE id = $1 AND hospital_id = $2 AND status IN ('open','healing','stalled','deteriorating')`,
          [woundId, this.hospitalId(), trajectory === 'stalled' ? 'stalled' : 'deteriorating'],
        );

        await this.outbox.publish(
          tx,
          consoleEvent('wound.stalled', woundId, {
            woundId,
            patientId: detail.wound.patientId,
            aetiology: detail.wound.aetiology,
            areaCm2: String(asNumberOrNull(row['area_cm2']) ?? 0),
            areaReductionPct: String(asNumberOrNull(row['area_reduction_pct']) ?? 0),
            weeksOpen: detail.wound.weeksOpen ?? 0,
          }),
        );
      }

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'wound_assessment',
        rowId: asText(row['id']),
        businessKey: woundId,
        dataClass: 'phi',
        patientId: detail.wound.patientId,
        encounterId: null,
        before: null,
        // The audit records what the database concluded, not what the nurse
        // expected it to.
        after: {
          areaCm2: asNumberOrNull(row['area_cm2']),
          reductionPct: asNumberOrNull(row['area_reduction_pct']),
          trajectory,
        },
      });

      return this.detailWithin(tx, woundId);
    });
  }

  async addPhoto(woundId: string, body: WoundPhotoRequest): Promise<WoundPhotoRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.wound_photos
           (id, hospital_id, wound_id, assessment_id, patient_id, s3_key, thumb_key,
            taken_at, taken_by, device, stage, has_scale_marker, calibration, consent_id, created_at)
         VALUES ($1,$2,$3,$4,
                 (SELECT patient_id FROM specialty.wounds WHERE id = $3),
                 $5,$6, now(), $7,$8,$9,$10,$11::jsonb,$12, now())
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          woundId,
          body.assessmentId ?? null,
          body.s3Key,
          body.thumbKey ?? null,
          this.actorId(),
          body.device ?? null,
          body.stage,
          body.hasScaleMarker,
          JSON.stringify(body.calibration),
          body.consentId ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The photograph was not recorded.');
      return this.toPhoto(row);
    });
  }

  async recordDressing(woundId: string, body: DressingRequest): Promise<WoundDetail> {
    return this.guard(async (tx) => {
      await tx.query(
        `INSERT INTO specialty.wound_dressing_events
           (id, hospital_id, branch_id, wound_id, patient_id, session_id, performed_at,
            performed_by, location, consumables, consumption_id, npwt_canister_changed,
            pain_pre, pain_post, notes, next_due_at, charge_intent_id, created_at)
         VALUES ($1,$2,$3,$4,
                 (SELECT patient_id FROM specialty.wounds WHERE id = $4),
                 $5, now(), $6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14::timestamptz,$15, now())`,
        [
          newId(),
          this.hospitalId(),
          this.branchId(),
          woundId,
          body.sessionId ?? null,
          this.actorId(),
          body.location,
          JSON.stringify(body.consumables),
          body.consumptionId ?? null,
          body.npwtCanisterChanged,
          body.painPre ?? null,
          body.painPost ?? null,
          body.notes ?? null,
          body.nextDueAt ?? null,
          body.chargeIntentId ?? null,
        ],
      );
      return this.detailWithin(tx, woundId);
    });
  }

  async close(woundId: string, body: CloseWoundRequest): Promise<WoundRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.wounds
            SET status = $3::specialty."WoundStatus", updated_at = now()
          WHERE hospital_id = $1 AND id = $2
            AND status NOT IN ('healed','amputated','deceased','lost_to_followup')
          RETURNING patient_id`,
        [this.hospitalId(), woundId, body.status],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That wound does not exist, or it is already closed.');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'wound',
        rowId: woundId,
        businessKey: asText(row['patient_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: null,
        before: null,
        after: { status: body.status },
      });

      return this.woundWithin(tx, woundId);
    });
  }

  /**
   * Close a wound the last measurement says is open.
   *
   * The legitimate case is real — a patient who healed at home, or was last
   * seen by a community nurse with no ruler — but it is not the clinic's to
   * assume. So the override writes the closing measurement itself, as a zero
   * assessment attributed to whoever used the key, and the reason travels with
   * it. Nothing here bypasses the rule: it satisfies it, on the record.
   */
  async overrideClose(woundId: string, body: OverrideWoundRequest): Promise<WoundRow> {
    return this.guard(async (tx) => {
      const { rows: existing } = await tx.query<Record<string, unknown>>(
        `SELECT patient_id, status FROM specialty.wounds WHERE hospital_id = $1 AND id = $2`,
        [this.hospitalId(), woundId],
      );
      const wound = existing[0];
      if (wound === undefined) throw AppError.notFound('That wound does not exist.');

      await tx.query(
        `INSERT INTO specialty.wound_assessments
           (id, hospital_id, wound_id, patient_id, assessed_at, assessed_by, context,
            length_cm, width_cm, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4, now(), $5, 'opd', 0, 0, $6, now(), now())`,
        [
          newId(),
          this.hospitalId(),
          woundId,
          asText(wound['patient_id']),
          this.actorId(),
          `Closed without a measured assessment: ${body.reason}`,
        ],
      );

      await tx.query(
        `UPDATE specialty.wounds SET status = 'healed', updated_at = now()
          WHERE hospital_id = $1 AND id = $2`,
        [this.hospitalId(), woundId],
      );

      await this.audit.write(tx, {
        action: 'override',
        entity: 'wound',
        rowId: woundId,
        businessKey: asText(wound['patient_id']),
        dataClass: 'phi',
        patientId: asText(wound['patient_id']),
        encounterId: null,
        reasonText: body.reason,
        before: { status: asText(wound['status']) },
        after: { status: 'healed', closingAssessment: 'recorded by override' },
      });

      return this.woundWithin(tx, woundId);
    });
  }

  async list(query: WoundQuery): Promise<readonly WoundRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.selectWound()}
          WHERE w.hospital_id = $1
            AND ($2::uuid IS NULL OR w.patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE
                 OR w.status NOT IN ('healed','amputated','deceased','lost_to_followup'))
            AND ($4::boolean IS NOT TRUE OR w.status IN ('stalled','deteriorating'))
          ORDER BY w.status IN ('stalled','deteriorating') DESC, w.created_at DESC
          LIMIT $5`,
        [this.hospitalId(), query.patientId ?? null, query.openOnly, query.needsReview, query.limit],
      );
      return rows.map((r) => this.toWound(r));
    });
  }

  async detail(woundId: string): Promise<WoundDetail> {
    return this.guard((tx) => this.detailWithin(tx, woundId));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shaping
  // ═══════════════════════════════════════════════════════════════════════════

  private selectWound(): string {
    // The latest measurement, joined once, so a list of forty wounds is one
    // query rather than forty-one. The tie-break matches the trigger's, so the
    // list and the healed check agree on which row is "the last assessment".
    return `SELECT w.*, a.area_cm2 AS latest_area, a.area_reduction_pct AS latest_reduction,
                   a.trajectory AS latest_trajectory, a.assessed_at AS last_assessed_at
              FROM specialty.wounds w
              LEFT JOIN LATERAL (
                SELECT area_cm2, area_reduction_pct, trajectory, assessed_at
                  FROM specialty.wound_assessments wa
                 WHERE wa.wound_id = w.id
                 ORDER BY wa.assessed_at DESC, wa.created_at DESC, wa.id DESC
                 LIMIT 1
              ) a ON true`;
  }

  private async woundWithin(tx: TransactionClient, id: string): Promise<WoundRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `${this.selectWound()} WHERE w.hospital_id = $1 AND w.id = $2`,
      [this.hospitalId(), id],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That wound does not exist.');
    return this.toWound(row);
  }

  private async detailWithin(tx: TransactionClient, woundId: string): Promise<WoundDetail> {
    const [assessments, photos] = await Promise.all([
      tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.wound_assessments WHERE wound_id = $1
          ORDER BY assessed_at DESC, created_at DESC LIMIT 100`,
        [woundId],
      ),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.wound_photos WHERE wound_id = $1 ORDER BY taken_at DESC LIMIT 100`,
        [woundId],
      ),
    ]);

    return {
      wound: await this.woundWithin(tx, woundId),
      assessments: assessments.rows.map((r) => this.toAssessment(r)),
      photos: photos.rows.map((r) => this.toPhoto(r)),
    };
  }

  private toWound(row: Record<string, unknown>): WoundRow {
    const trajectory = asTextOrNull(row['latest_trajectory']);
    const onset = asTextOrNull(row['onset_date']) ?? asText(row['created_at']);
    const weeks = onset === '' ? null : Math.floor((Date.now() - Date.parse(onset)) / (7 * 24 * 3600 * 1000));

    return {
      id: asText(row['id']),
      patientId: asText(row['patient_id']),
      episodeId: asTextOrNull(row['episode_id']),
      woundNo: asNumber(row['wound_no']),
      locationText: asText(row['location_text']),
      side: asText(row['side']),
      aetiology: asText(row['aetiology']),
      onsetDate: asTextOrNull(row['onset_date']),
      classification: asJson(row['classification']),
      status: asText(row['status']),
      hospitalAcquired: asBool(row['hospital_acquired']),
      healedAt: asTextOrNull(row['healed_at']),
      healingDays: asNumberOrNull(row['healing_days']),
      latestAreaCm2: asNumberOrNull(row['latest_area']),
      latestReductionPct: asNumberOrNull(row['latest_reduction']),
      latestTrajectory: trajectory,
      lastAssessedAt: asTextOrNull(row['last_assessed_at']),
      weeksOpen: weeks === null || Number.isNaN(weeks) ? null : weeks,
      needsReview: trajectory === 'stalled' || trajectory === 'deteriorating',
    };
  }

  private toAssessment(row: Record<string, unknown>): WoundAssessmentRow {
    return {
      id: asText(row['id']),
      woundId: asText(row['wound_id']),
      assessedAt: asText(row['assessed_at']),
      assessedBy: asText(row['assessed_by']),
      lengthCm: asNumberOrNull(row['length_cm']),
      widthCm: asNumberOrNull(row['width_cm']),
      depthCm: asNumberOrNull(row['depth_cm']),
      areaCm2: asNumberOrNull(row['area_cm2']),
      areaReductionPct: asNumberOrNull(row['area_reduction_pct']),
      trajectory: asTextOrNull(row['trajectory']),
      tissuePct: asJson(row['tissue_pct']),
      exudate: asJson(row['exudate']),
      painNrs: asNumberOrNull(row['pain_nrs']),
      probeToBone: asBool(row['probe_to_bone']),
      notes: asTextOrNull(row['notes']),
    };
  }

  private toPhoto(row: Record<string, unknown>): WoundPhotoRow {
    const scale = asBool(row['has_scale_marker']);
    return {
      id: asText(row['id']),
      woundId: asText(row['wound_id']),
      assessmentId: asTextOrNull(row['assessment_id']),
      s3Key: asText(row['s3_key']),
      thumbKey: asTextOrNull(row['thumb_key']),
      takenAt: asText(row['taken_at']),
      stage: asText(row['stage']),
      hasScaleMarker: scale,
      measurable: scale,
    };
  }
}
