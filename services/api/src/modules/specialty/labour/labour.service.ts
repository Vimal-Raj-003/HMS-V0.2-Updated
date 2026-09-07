import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from '../consoles/consoles.events.js';
import {
  ConsoleSupport,
  asBoolOrNull,
  asJson,
  asNumber,
  asNumberOrNull,
  asStringArray,
  asText,
  asTextOrNull,
} from '../consoles/consoles.support.js';
import type {
  BirthReportRequest,
  BirthReportSubmitRequest,
  DecisionRequest,
  DeliveryRequest,
  EpisodeQuery,
  EpisodeRequest,
  EpisodeUpdateRequest,
  ExamRequest,
  IdentityCheckRequest,
  NewbornQuery,
  NewbornUpdateRequest,
  PartographRequest,
  PphCloseRequest,
  PphStepRequest,
} from './labour.schemas.js';
import type {
  BirthReportRow,
  DeliveryRow,
  IdentityCheckRow,
  LabourEpisodeDetail,
  LabourEpisodeRow,
  NewbornRow,
  PartographAlertRow,
  PartographEntryRow,
  PphActivationRow,
} from './labour.types.js';

/** How long tranexamic acid still helps after a birth. */
const TXA_WINDOW_MIN = 180;

/**
 * IP-011 — the labour room and the newborn.
 *
 * ── This is the only service in the build that creates a person ────────────
 *
 * A delivery does not record a baby; it produces one, with their own hospital
 * number allocated from the same series every other patient's comes from. The
 * name is temporary — "Baby of <mother>" — and the number is not: when the
 * family registers a name a week later, the number they have already been given
 * on a wristband, a discharge summary and a vaccination card stays theirs.
 *
 * ── Nothing here draws a line, times a window, or decides a match ──────────
 *
 * The alert and action lines, the third-stage delay, the tranexamic acid window
 * and whether two wristbands match are all trigger outputs. What this service
 * adds is the same arithmetic read forwards — `chartBlocked`, `hoursBehind`,
 * `secondStageMinutesLeft`, `txaMinutesLeft` — because the room is loud, nobody
 * is reading, and a refusal that arrives as a red banner ten minutes early is
 * worth more than one that arrives as an error.
 */
@Injectable()
export class LabourService extends ConsoleSupport {
  constructor(
    @Inject(DatabaseService) db: DatabaseService,
    @Inject(OutboxService) outbox: OutboxService,
    @Inject(AuditService) audit: AuditService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
  ) {
    super(db, outbox, audit);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The labour
  // ═══════════════════════════════════════════════════════════════════════════

  async admit(body: EpisodeRequest): Promise<LabourEpisodeRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.labour_episodes
           (id, hospital_id, branch_id, admission_id, patient_id, pregnancy_id, edd_at_admission,
            gpal, risk_flags, blood_group, rh_negative, onset_at, membrane_status,
            membrane_rupture_at, liquor, presentation, parity, partograph_standard, epidural,
            companion_present, consents, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::jsonb,$9::text[],$10,$11,$12::timestamptz,$13,
                 $14::timestamptz,$15,$16,$17,$18::specialty."PartographStandard",$19,$20,
                 $21::jsonb,$22,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.admissionId,
          body.patientId,
          body.pregnancyId ?? null,
          body.eddAtAdmission ?? null,
          JSON.stringify(body.gpal),
          body.riskFlags,
          body.bloodGroup ?? null,
          body.rhNegative ?? null,
          body.onsetAt ?? null,
          body.membraneStatus ?? null,
          body.membraneRuptureAt ?? null,
          body.liquor ?? null,
          body.presentation ?? null,
          body.parity,
          body.partographStandard,
          body.epidural,
          body.companionPresent,
          JSON.stringify(body.consents),
          this.actorId(),
        ],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'labour_episode',
        rowId: id,
        businessKey: body.admissionId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        before: null,
        after: { parity: body.parity, riskFlags: body.riskFlags },
      });

      return this.episodeWithin(tx, id);
    });
  }

  async updateEpisode(id: string, body: EpisodeUpdateRequest): Promise<LabourEpisodeRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.labour_episodes
            SET active_phase_from  = coalesce($2::timestamptz, active_phase_from),
                second_stage_from  = coalesce($3::timestamptz, second_stage_from),
                epidural           = coalesce($4, epidural),
                membrane_status    = coalesce($5, membrane_status),
                membrane_rupture_at= coalesce($6::timestamptz, membrane_rupture_at),
                liquor             = coalesce($7, liquor),
                presentation       = coalesce($8, presentation),
                companion_present  = coalesce($9, companion_present),
                outcome            = coalesce($10::specialty."LabourOutcome", outcome),
                completed_at       = CASE WHEN $10::text IS NULL THEN completed_at
                                          ELSE coalesce(completed_at, now()) END,
                updated_at         = now()
          WHERE id = $1 AND hospital_id = $11`,
        [
          id,
          body.activePhaseFrom ?? null,
          body.secondStageFrom ?? null,
          body.epidural ?? null,
          body.membraneStatus ?? null,
          body.membraneRuptureAt ?? null,
          body.liquor ?? null,
          body.presentation ?? null,
          body.companionPresent ?? null,
          body.outcome ?? null,
          this.hospitalId(),
        ],
      );
      return this.episodeWithin(tx, id);
    });
  }

  async listEpisodes(query: EpisodeQuery): Promise<readonly LabourEpisodeRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${EPISODE_SELECT}
          WHERE e.hospital_id = $1
            AND ($2::uuid IS NULL OR e.patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE OR e.completed_at IS NULL)
            AND ($4::boolean IS NOT TRUE OR blk.raised_at IS NOT NULL)
          ORDER BY e.created_at DESC
          LIMIT $5`,
        [this.hospitalId(), query.patientId ?? null, query.openOnly, query.blockedOnly, query.limit],
      );
      return rows.map((r) => this.toEpisode(r));
    });
  }

  async episodeDetail(id: string): Promise<LabourEpisodeDetail> {
    return this.guard(async (tx) => {
      const episode = await this.episodeWithin(tx, id);
      const [entries, alerts, deliveries, newborns] = await Promise.all([
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.partograph_entries WHERE episode_id = $1
            ORDER BY recorded_at, created_at LIMIT 500`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM specialty.partograph_alerts WHERE episode_id = $1 ORDER BY raised_at DESC`,
          [id],
        ),
        tx.query<Record<string, unknown>>(`${DELIVERY_SELECT} WHERE d.episode_id = $1 ORDER BY d.baby_seq`, [
          id,
        ]),
        tx.query<Record<string, unknown>>(
          `${NEWBORN_SELECT}
            WHERE n.delivery_id IN (SELECT d.id FROM specialty.deliveries d WHERE d.episode_id = $1)
            ORDER BY n.birth_at`,
          [id],
        ),
      ]);
      return {
        episode,
        entries: entries.rows.map((r) => this.toEntry(r)),
        alerts: alerts.rows.map((r) => this.toAlert(r)),
        deliveries: deliveries.rows.map((r) => this.toDelivery(r)),
        newborns: newborns.rows.map((r) => this.toNewborn(r)),
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The chart
  // ═══════════════════════════════════════════════════════════════════════════

  async plot(episodeId: string, body: PartographRequest): Promise<LabourEpisodeDetail> {
    return this.guard(async (tx) => {
      // Observations are taken together, so they are written together — and if
      // one of them crosses the action line, the ones after it in the same
      // batch are refused with the rest of the transaction. That is the correct
      // behaviour: the batch is one moment on one chart.
      for (const entry of body.entries) {
        await tx.query(
          `INSERT INTO specialty.partograph_entries
             (id, hospital_id, episode_id, recorded_at, param, value, source, recorded_by, created_at)
           VALUES ($1,$2,$3,coalesce($4::timestamptz, now()),$5,$6::jsonb,$7,$8,now())`,
          [
            newId(),
            this.hospitalId(),
            episodeId,
            entry.recordedAt ?? null,
            entry.param,
            JSON.stringify(entry.value),
            entry.source,
            this.actorId(),
          ],
        );
      }

      await this.announceNewAlerts(tx, episodeId);
      return this.episodeDetailWithin(tx, episodeId);
    });
  }

  /** What releases the chart. */
  async decide(alertId: string, body: DecisionRequest): Promise<PartographAlertRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.partograph_alerts
            SET acknowledged_by = $2, acknowledged_at = now(),
                decision = $3, decision_note = $4
          WHERE id = $1 AND hospital_id = $5
          RETURNING *`,
        [alertId, this.actorId(), body.decision, body.decisionNote ?? null, this.hospitalId()],
      );
      const alert = this.toAlert(this.one(rows));

      await this.audit.write(tx, {
        action: 'approve',
        entity: 'partograph_alert',
        rowId: alertId,
        businessKey: alert.episodeId,
        dataClass: 'phi',
        patientId: null,
        encounterId: null,
        ...(body.decisionNote === undefined ? {} : { reasonText: body.decisionNote }),
        before: null,
        after: { kind: alert.kind, decision: body.decision },
      });

      return alert;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The birth
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Records the delivery and creates the baby, in one transaction.
   *
   * The two are not separable. A delivery saved without a newborn is a baby who
   * exists in a room and not in a system, and the gap between the two saves is
   * exactly where a wristband goes on unrecorded.
   */
  async recordDelivery(episodeId: string, body: DeliveryRequest): Promise<LabourEpisodeDetail> {
    return this.guard(async (tx) => {
      const { rows: ep } = await tx.query<Record<string, unknown>>(
        `SELECT patient_id, branch_id FROM specialty.labour_episodes WHERE id = $1 AND hospital_id = $2`,
        [episodeId, this.hospitalId()],
      );
      const episode = this.one(ep);
      const motherPatientId = asText(episode.patient_id);

      const deliveryId = newId();
      await tx.query(
        `INSERT INTO specialty.deliveries
           (id, hospital_id, episode_id, baby_seq, mode, delivered_at, place, attendants,
            indication, ot_case_id, decision_to_delivery_min, episiotomy, tear_degree,
            uterotonic_drug, uterotonic_at, placenta, third_stage, ebl_ml, ebl_method,
            complications, notes, created_by, created_at, updated_at)
         SELECT $1, $2, $3,
                coalesce((SELECT max(d.baby_seq) FROM specialty.deliveries d
                           WHERE d.episode_id = $3::uuid), 0) + 1,
                $4::specialty."DeliveryMode", $5::timestamptz, $6, $7::jsonb, $8, $9, $10, $11, $12,
                $13, $14::timestamptz, $15::jsonb, $16::jsonb, $17, $18, $19::jsonb, $20, $21,
                now(), now()`,
        [
          deliveryId,
          this.hospitalId(),
          episodeId,
          body.mode,
          body.deliveredAt,
          body.place ?? null,
          JSON.stringify(body.attendants),
          body.indication ?? null,
          body.otCaseId ?? null,
          body.decisionToDeliveryMin ?? null,
          body.episiotomy,
          body.tearDegree ?? null,
          body.uterotonicDrug ?? null,
          body.uterotonicAt ?? null,
          JSON.stringify(body.placenta),
          JSON.stringify(body.thirdStage),
          body.eblMl ?? null,
          body.eblMethod ?? null,
          JSON.stringify(body.complications),
          body.notes ?? null,
          this.actorId(),
        ],
      );

      const newbornId = await this.createNewborn(tx, {
        deliveryId,
        motherPatientId,
        branchId: asText(episode.branch_id),
        birthAt: body.deliveredAt,
        newborn: body.newborn,
      });

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'delivery',
        rowId: deliveryId,
        businessKey: episodeId,
        dataClass: 'phi',
        patientId: motherPatientId,
        encounterId: null,
        before: null,
        after: { mode: body.mode, eblMl: body.eblMl ?? null, newbornId },
      });

      await this.announceActivations(tx, deliveryId, motherPatientId);
      return this.episodeDetailWithin(tx, episodeId);
    });
  }

  /**
   * The baby becomes a patient here.
   *
   * The hospital number comes from the same `UHID` series every other patient's
   * does, because a baby with a different kind of number is a baby whose record
   * has to be special-cased in twenty places for the rest of their life.
   */
  private async createNewborn(
    tx: TransactionClient,
    input: {
      readonly deliveryId: string;
      readonly motherPatientId: string;
      readonly branchId: string;
      readonly birthAt: string;
      readonly newborn: DeliveryRequest['newborn'];
    },
  ): Promise<string> {
    const babyPatientId = newId();
    const alloc = await this.numbering.allocate(tx, {
      key: 'UHID',
      branchId: input.branchId,
      refType: 'newborn_patient',
      refId: babyPatientId,
    });

    const { rows: mother } = await tx.query<Record<string, unknown>>(
      `SELECT full_name, mobile, mobile_local FROM patient.patients WHERE id = $1`,
      [input.motherPatientId],
    );
    const motherName = asTextOrNull(mother[0]?.full_name) ?? 'mother';
    const tempName = `Baby of ${motherName}`;

    await tx.query(
      `INSERT INTO patient.patients
         (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, full_name, gender,
          dob, mobile, mobile_local, dedupe_fingerprint, status, updated_at)
       VALUES ($1,$2,$3,$4,$4,$5,$5,$6::patient."PatientGender",$7::date,$8,$9,$4,'active',now())`,
      [
        babyPatientId,
        this.hospitalId(),
        input.branchId,
        alloc.formatted,
        tempName,
        // The patient master's vocabulary is male/female/other/unknown, and the
        // newborn record keeps the finer fact. Mapping `ambiguous` to `other`
        // rather than `unknown` matters: "we do not know" and "it is not one of
        // the two" are different, and the second is a paediatric referral.
        input.newborn.sex === 'ambiguous'
          ? 'other'
          : input.newborn.sex === 'unknown'
            ? 'unknown'
            : input.newborn.sex,
        new Date(input.birthAt).toISOString().slice(0, 10),
        asTextOrNull(mother[0]?.mobile),
        asTextOrNull(mother[0]?.mobile_local),
      ],
    );

    const newbornId = newId();
    // The pair code goes on two bands and is checked at every handover. It is
    // derived from the baby's own number so that a band read aloud identifies
    // exactly one record.
    const pairCode = `${alloc.formatted}`.slice(-12);

    await tx.query(
      `INSERT INTO specialty.newborns
         (id, hospital_id, branch_id, patient_id, mother_patient_id, mother_admission_id,
          delivery_id, birth_at, sex, status, birth_weight_g, length_cm, hc_cm, ga_weeks,
          apgar_1, apgar_5, apgar_10, apgar_components, resuscitation, cord_clamp_delayed,
          wristband_pair_code, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10::specialty."NewbornStatus",
               $11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20,$21,$22,now(),now())`,
      [
        newbornId,
        this.hospitalId(),
        input.branchId,
        babyPatientId,
        input.motherPatientId,
        input.newborn.motherAdmissionId ?? null,
        input.deliveryId,
        input.birthAt,
        input.newborn.sex,
        input.newborn.status,
        input.newborn.birthWeightG ?? null,
        input.newborn.lengthCm ?? null,
        input.newborn.hcCm ?? null,
        input.newborn.gaWeeks ?? null,
        input.newborn.apgar1 ?? null,
        input.newborn.apgar5 ?? null,
        input.newborn.apgar10 ?? null,
        JSON.stringify(input.newborn.apgarComponents),
        JSON.stringify(input.newborn.resuscitation),
        input.newborn.cordClampDelayed,
        pairCode,
        this.actorId(),
      ],
    );

    // The birth report's clock starts here, not when somebody remembers.
    await tx.query(
      `INSERT INTO specialty.birth_reports
         (id, hospital_id, newborn_id, form1, due_by, created_at, updated_at)
       VALUES ($1,$2,$3,'{}'::jsonb,current_date,now(),now())
       ON CONFLICT (newborn_id) DO NOTHING`,
      [newId(), this.hospitalId(), newbornId],
    );

    await this.audit.write(tx, {
      action: 'insert',
      entity: 'newborn',
      rowId: newbornId,
      businessKey: alloc.formatted,
      dataClass: 'phi',
      patientId: babyPatientId,
      encounterId: null,
      before: null,
      after: { motherPatientId: input.motherPatientId, uhid: alloc.formatted, pairCode },
    });

    await this.outbox.publish(
      tx,
      consoleEvent('lr.newborn.registered', newbornId, {
        newbornId,
        patientId: babyPatientId,
        motherPatientId: input.motherPatientId,
        deliveryId: input.deliveryId,
        birthAt: input.birthAt,
        sex: input.newborn.sex,
        status: input.newborn.status,
        birthWeightG: input.newborn.birthWeightG ?? null,
        wristbandPairCode: pairCode,
      }),
    );

    const { rows: report } = await tx.query<Record<string, unknown>>(
      `SELECT id, due_by FROM specialty.birth_reports WHERE newborn_id = $1`,
      [newbornId],
    );
    const reportRow = report[0];
    if (reportRow !== undefined) {
      await this.outbox.publish(
        tx,
        consoleEvent('lr.birth.reportable', asText(reportRow.id), {
          reportId: asText(reportRow.id),
          newbornId,
          birthAt: input.birthAt,
          dueBy: asText(reportRow.due_by),
        }),
      );
    }

    return newbornId;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The haemorrhage
  // ═══════════════════════════════════════════════════════════════════════════

  async addPphStep(activationId: string, body: PphStepRequest): Promise<PphActivationRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.pph_activations
            SET steps = steps || jsonb_build_array(
                  jsonb_build_object('step', $2::text,
                                     'at', coalesce($3::timestamptz, now()),
                                     'by', $4::uuid)
                  || CASE WHEN $5::text IS NULL THEN '{}'::jsonb
                          ELSE jsonb_build_object('note', $5::text) END),
                updated_at = now()
          WHERE id = $1 AND hospital_id = $6`,
        [activationId, body.step, body.at ?? null, this.actorId(), body.note ?? null, this.hospitalId()],
      );
      return this.activationWithin(tx, activationId);
    });
  }

  async closePph(activationId: string, body: PphCloseRequest): Promise<PphActivationRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.pph_activations
            SET deactivated_at = now(), outcome = $2, updated_at = now()
          WHERE id = $1 AND hospital_id = $3`,
        [activationId, body.outcome, this.hospitalId()],
      );
      return this.activationWithin(tx, activationId);
    });
  }

  async listActivations(): Promise<readonly PphActivationRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${ACTIVATION_SELECT} WHERE a.hospital_id = $1 ORDER BY a.activated_at DESC LIMIT 100`,
        [this.hospitalId()],
      );
      return rows.map((r) => this.toActivation(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The baby
  // ═══════════════════════════════════════════════════════════════════════════

  async updateNewborn(id: string, body: NewbornUpdateRequest): Promise<NewbornRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.newborns
            SET birth_weight_g = coalesce($2, birth_weight_g),
                length_cm      = coalesce($3, length_cm),
                hc_cm          = coalesce($4, hc_cm),
                apgar_10       = coalesce($5, apgar_10),
                resuscitation  = coalesce($6::jsonb, resuscitation),
                vitamin_k_at   = coalesce($7::timestamptz, vitamin_k_at),
                first_feed_at  = coalesce($8::timestamptz, first_feed_at),
                skin_to_skin_min = coalesce($9, skin_to_skin_min),
                nicu_admitted  = coalesce($10, nicu_admitted),
                admission_id   = coalesce($11::uuid, admission_id),
                updated_at     = now()
          WHERE id = $1 AND hospital_id = $12`,
        [
          id,
          body.birthWeightG ?? null,
          body.lengthCm ?? null,
          body.hcCm ?? null,
          body.apgar10 ?? null,
          body.resuscitation === undefined ? null : JSON.stringify(body.resuscitation),
          body.vitaminKAt ?? null,
          body.firstFeedAt ?? null,
          body.skinToSkinMin ?? null,
          body.nicuAdmitted ?? null,
          body.admissionId ?? null,
          this.hospitalId(),
        ],
      );
      return this.newbornWithin(tx, id);
    });
  }

  async listNewborns(query: NewbornQuery): Promise<readonly NewbornRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${NEWBORN_SELECT}
          WHERE n.hospital_id = $1
            AND ($2::uuid IS NULL OR n.mother_patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE
                 OR (br.submitted_at IS NULL AND n.status <> 'stillbirth_macerated'))
          ORDER BY n.birth_at DESC
          LIMIT $4`,
        [this.hospitalId(), query.motherPatientId ?? null, query.reportDueOnly, query.limit],
      );
      return rows.map((r) => this.toNewborn(r));
    });
  }

  async recordExam(newbornId: string, body: ExamRequest): Promise<NewbornRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `INSERT INTO specialty.newborn_exams
           (id, hospital_id, newborn_id, kind, examined_at, examined_by, findings, anomalies,
            cchd_screen, hip, red_reflex, weight_g, created_at, updated_at)
         VALUES ($1,$2,$3,$4,now(),$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,now(),now())`,
        [
          newId(),
          this.hospitalId(),
          newbornId,
          body.kind,
          this.actorId(),
          JSON.stringify(body.findings),
          JSON.stringify(body.anomalies),
          JSON.stringify(body.cchdScreen),
          body.hip ?? null,
          body.redReflex ?? null,
          body.weightG ?? null,
        ],
      );
      return this.newbornWithin(tx, newbornId);
    });
  }

  /**
   * A handover scan.
   *
   * `matched` is the database's: it compares what the scanner read against the
   * code on the record. Sending it would let a tired hand at three in the
   * morning tick a box instead of holding a wrist.
   */
  async checkIdentity(newbornId: string, body: IdentityCheckRequest): Promise<IdentityCheckRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.newborn_identity_checks
           (id, hospital_id, newborn_id, checked_at, mother_band_scan, baby_band_scan, matched,
            context, checked_by, created_at)
         VALUES ($1,$2,$3,now(),$4,$5,false,$6,$7,now())
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          newbornId,
          body.motherBandScan,
          body.babyBandScan,
          body.context,
          this.actorId(),
        ],
      );
      const check = this.toCheck(this.one(rows));

      if (!check.matched) {
        // The other explanation for two bands that disagree is that two babies
        // have been exchanged, so this leaves the console at once.
        await this.audit.write(tx, {
          action: 'override',
          entity: 'newborn_identity_check',
          rowId: check.id,
          businessKey: newbornId,
          dataClass: 'phi',
          patientId: null,
          encounterId: null,
          reasonText: `Wristband mismatch during ${body.context}`,
          before: null,
          after: { motherBandScan: body.motherBandScan, babyBandScan: body.babyBandScan },
        });

        await this.outbox.publish(
          tx,
          consoleEvent('lr.identity.mismatch', check.id, {
            checkId: check.id,
            newbornId,
            motherBandScan: body.motherBandScan,
            babyBandScan: body.babyBandScan,
            context: body.context,
            checkedAt: check.checkedAt,
          }),
        );
      }

      return check;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Form 1
  // ═══════════════════════════════════════════════════════════════════════════

  async draftBirthReport(newbornId: string, body: BirthReportRequest): Promise<BirthReportRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.birth_reports
           (id, hospital_id, newborn_id, form1, due_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4::jsonb,current_date,now(),now())
         ON CONFLICT (newborn_id) DO UPDATE SET form1 = EXCLUDED.form1, updated_at = now()
         RETURNING *`,
        [newId(), this.hospitalId(), newbornId, JSON.stringify(body.form1)],
      );
      return this.toReport(this.one(rows));
    });
  }

  async verifyBirthReport(newbornId: string): Promise<BirthReportRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.birth_reports
            SET verified_by = $2, verified_at = now(), updated_at = now()
          WHERE newborn_id = $1 AND hospital_id = $3
          RETURNING *`,
        [newbornId, this.actorId(), this.hospitalId()],
      );
      return this.toReport(this.one(rows));
    });
  }

  async submitBirthReport(newbornId: string, body: BirthReportSubmitRequest): Promise<BirthReportRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.birth_reports
            SET submitted_at = now(), crs_reg_no = coalesce($2, crs_reg_no), updated_at = now()
          WHERE newborn_id = $1 AND hospital_id = $3
          RETURNING *`,
        [newbornId, body.crsRegNo ?? null, this.hospitalId()],
      );
      const report = this.toReport(this.one(rows));

      await this.audit.write(tx, {
        action: 'export',
        entity: 'birth_report',
        rowId: report.id,
        businessKey: newbornId,
        dataClass: 'phi',
        patientId: null,
        encounterId: null,
        before: null,
        after: { crsRegNo: report.crsRegNo, dueBy: report.dueBy },
      });

      return report;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shaping
  // ═══════════════════════════════════════════════════════════════════════════

  private one(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That labour record was not found.');
    return row;
  }

  private async episodeWithin(tx: TransactionClient, id: string): Promise<LabourEpisodeRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${EPISODE_SELECT} WHERE e.id = $1`, [id]);
    return this.toEpisode(this.one(rows));
  }

  private async episodeDetailWithin(tx: TransactionClient, id: string): Promise<LabourEpisodeDetail> {
    const episode = await this.episodeWithin(tx, id);
    const [entries, alerts, deliveries, newborns] = await Promise.all([
      tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.partograph_entries WHERE episode_id = $1
          ORDER BY recorded_at, created_at LIMIT 500`,
        [id],
      ),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.partograph_alerts WHERE episode_id = $1 ORDER BY raised_at DESC`,
        [id],
      ),
      tx.query<Record<string, unknown>>(`${DELIVERY_SELECT} WHERE d.episode_id = $1 ORDER BY d.baby_seq`, [
        id,
      ]),
      tx.query<Record<string, unknown>>(
        `${NEWBORN_SELECT}
          WHERE n.delivery_id IN (SELECT d.id FROM specialty.deliveries d WHERE d.episode_id = $1)
          ORDER BY n.birth_at`,
        [id],
      ),
    ]);
    return {
      episode,
      entries: entries.rows.map((r) => this.toEntry(r)),
      alerts: alerts.rows.map((r) => this.toAlert(r)),
      deliveries: deliveries.rows.map((r) => this.toDelivery(r)),
      newborns: newborns.rows.map((r) => this.toNewborn(r)),
    };
  }

  private async newbornWithin(tx: TransactionClient, id: string): Promise<NewbornRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${NEWBORN_SELECT} WHERE n.id = $1`, [id]);
    return this.toNewborn(this.one(rows));
  }

  private async activationWithin(tx: TransactionClient, id: string): Promise<PphActivationRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${ACTIVATION_SELECT} WHERE a.id = $1`, [id]);
    return this.toActivation(this.one(rows));
  }

  /** Alerts the chart just raised, sent to whoever is not in the room. */
  private async announceNewAlerts(tx: TransactionClient, episodeId: string): Promise<void> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT a.*, e.patient_id
         FROM specialty.partograph_alerts a
         JOIN specialty.labour_episodes e ON e.id = a.episode_id
        WHERE a.episode_id = $1 AND a.acknowledged_at IS NULL
          AND a.created_at > now() - interval '5 seconds'
        ORDER BY a.raised_at`,
      [episodeId],
    );
    for (const raw of rows) {
      const alert = this.toAlert(raw);
      const patientId = asText(raw.patient_id);
      if (alert.kind === 'action_line') {
        await this.outbox.publish(
          tx,
          consoleEvent('lr.partograph.action_line', alert.id, {
            alertId: alert.id,
            episodeId,
            patientId,
            dilatationCm: asNumber(alert.details.dilatationCm),
            expectedCm: asText(alert.details.expectedCm),
            hoursBehind: asText(alert.details.hoursBehind),
            raisedAt: alert.raisedAt,
          }),
        );
      } else if (alert.kind === 'fhr_abnormal') {
        await this.outbox.publish(
          tx,
          consoleEvent('lr.fhr.abnormal', alert.id, {
            alertId: alert.id,
            episodeId,
            patientId,
            fhr: asNumber(alert.details.fhr),
            raisedAt: alert.raisedAt,
          }),
        );
      }
    }
  }

  /** A haemorrhage protocol the recorded blood loss just activated. */
  private async announceActivations(
    tx: TransactionClient,
    deliveryId: string,
    patientId: string,
  ): Promise<void> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM specialty.pph_activations
        WHERE delivery_id = $1 AND created_at > now() - interval '5 seconds'`,
      [deliveryId],
    );
    for (const raw of rows) {
      await this.outbox.publish(
        tx,
        consoleEvent('lr.pph.activated', asText(raw.id), {
          activationId: asText(raw.id),
          deliveryId,
          patientId,
          trigger: asText(raw.trigger),
          eblMl: asNumberOrNull(raw.ebl_at_trigger),
          activatedAt: asText(raw.activated_at),
        }),
      );
    }
  }

  private toEpisode(r: Record<string, unknown>): LabourEpisodeRow {
    const expectedCm = asNumberOrNull(r.expected_cm);
    const latestCm = asNumberOrNull(r.latest_cm);
    const blockedSince = asTextOrNull(r.blocked_since);
    const secondStageFrom = asTextOrNull(r.second_stage_from);
    const parity = asNumber(r.parity);
    const epidural = r.epidural === true;

    // The second-stage clock, the same figures the trigger uses.
    const limitMin =
      secondStageFrom === null ? null : parity === 0 ? (epidural ? 180 : 120) : epidural ? 120 : 60;
    const minutesLeft =
      secondStageFrom === null || limitMin === null
        ? null
        : limitMin - Math.floor((Date.now() - new Date(secondStageFrom).getTime()) / 60_000);

    return {
      id: asText(r.id),
      admissionId: asText(r.admission_id),
      patientId: asText(r.patient_id),
      pregnancyId: asTextOrNull(r.pregnancy_id),
      eddAtAdmission: asTextOrNull(r.edd_at_admission),
      gpal: asJson(r.gpal),
      riskFlags: asStringArray(r.risk_flags),
      bloodGroup: asTextOrNull(r.blood_group),
      rhNegative: asBoolOrNull(r.rh_negative),
      onsetAt: asTextOrNull(r.onset_at),
      membraneStatus: asTextOrNull(r.membrane_status),
      membraneRuptureAt: asTextOrNull(r.membrane_rupture_at),
      liquor: asTextOrNull(r.liquor),
      presentation: asTextOrNull(r.presentation),
      parity,
      partographStandard: asText(r.partograph_standard),
      activePhaseFrom: asTextOrNull(r.active_phase_from),
      secondStageFrom,
      epidural,
      companionPresent: r.companion_present === true,
      outcome: asTextOrNull(r.outcome),
      completedAt: asTextOrNull(r.completed_at),
      expectedCm,
      latestCm,
      hoursBehind:
        expectedCm === null || latestCm === null
          ? null
          : Math.max(Math.round((expectedCm - latestCm) * 100) / 100, 0),
      chartBlocked: blockedSince !== null,
      blockedSince,
      secondStageMinutesLeft: minutesLeft,
      secondStageLimitMin: limitMin,
      openAlerts: asNumber(r.open_alerts),
      babies: asNumber(r.babies),
    };
  }

  private toEntry(r: Record<string, unknown>): PartographEntryRow {
    return {
      id: asText(r.id),
      episodeId: asText(r.episode_id),
      recordedAt: asText(r.recorded_at),
      param: asText(r.param),
      value: asJson(r.value),
      dilatationCm: asNumberOrNull(r.dilatation_cm),
      fhr: asNumberOrNull(r.fhr),
      source: asText(r.source),
      recordedBy: asText(r.recorded_by),
    };
  }

  private toAlert(r: Record<string, unknown>): PartographAlertRow {
    return {
      id: asText(r.id),
      episodeId: asText(r.episode_id),
      raisedAt: asText(r.raised_at),
      kind: asText(r.kind),
      details: asJson(r.details),
      blocking: r.blocking === true,
      acknowledgedBy: asTextOrNull(r.acknowledged_by),
      acknowledgedAt: asTextOrNull(r.acknowledged_at),
      decision: asTextOrNull(r.decision),
      decisionNote: asTextOrNull(r.decision_note),
    };
  }

  private toDelivery(r: Record<string, unknown>): DeliveryRow {
    const delay = asNumberOrNull(r.uterotonic_delay_sec);
    return {
      id: asText(r.id),
      episodeId: asText(r.episode_id),
      babySeq: asNumber(r.baby_seq),
      mode: asText(r.mode),
      deliveredAt: asText(r.delivered_at),
      place: asTextOrNull(r.place),
      indication: asTextOrNull(r.indication),
      episiotomy: r.episiotomy === true,
      tearDegree: asTextOrNull(r.tear_degree),
      uterotonicDrug: asTextOrNull(r.uterotonic_drug),
      uterotonicAt: asTextOrNull(r.uterotonic_at),
      uterotonicDelaySec: delay,
      uterotonicWithin1Min: delay === null ? null : delay <= 60,
      eblMl: asNumberOrNull(r.ebl_ml),
      eblMethod: asTextOrNull(r.ebl_method),
      pphThresholdMl: asNumber(r.pph_threshold_ml),
      complications: Array.isArray(r.complications) ? (r.complications as Record<string, unknown>[]) : [],
      signedAt: asTextOrNull(r.signed_at),
    };
  }

  private toActivation(r: Record<string, unknown>): PphActivationRow {
    const birthAt = asTextOrNull(r.delivered_at);
    const txaAt = asTextOrNull(r.txa_at);
    // How long is left of the three hours in which it still helps. Past it,
    // giving it is not a delay — it is a different decision.
    const minutesLeft =
      birthAt === null || txaAt !== null
        ? null
        : Math.max(TXA_WINDOW_MIN - Math.floor((Date.now() - new Date(birthAt).getTime()) / 60_000), 0);
    return {
      id: asText(r.id),
      deliveryId: asText(r.delivery_id),
      activatedAt: asText(r.activated_at),
      trigger: asText(r.trigger),
      eblAtTrigger: asNumberOrNull(r.ebl_at_trigger),
      steps: Array.isArray(r.steps) ? (r.steps as Record<string, unknown>[]) : [],
      txaAt,
      txaWithin3h: asBoolOrNull(r.txa_within_3h),
      txaMinutesLeft: minutesLeft,
      outcome: asTextOrNull(r.outcome),
      deactivatedAt: asTextOrNull(r.deactivated_at),
    };
  }

  private toNewborn(r: Record<string, unknown>): NewbornRow {
    const lastMatched = asBoolOrNull(r.last_check_matched);
    const dueBy = asTextOrNull(r.report_due_by);
    const submitted = asTextOrNull(r.report_submitted_at) !== null;

    // §B.5, read forwards. A baby does not move on an unmatched pair, and the
    // board says so before anybody picks them up.
    const blockedBy: string[] = [];
    if (lastMatched === null) blockedBy.push('no identity check has been done');
    else if (!lastMatched) blockedBy.push('the last wristband scan did not match');

    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      motherPatientId: asText(r.mother_patient_id),
      deliveryId: asText(r.delivery_id),
      birthAt: asText(r.birth_at),
      sex: asText(r.sex),
      status: asText(r.status),
      birthWeightG: asNumberOrNull(r.birth_weight_g),
      gaWeeks: asNumberOrNull(r.ga_weeks),
      apgar1: asNumberOrNull(r.apgar_1),
      apgar5: asNumberOrNull(r.apgar_5),
      apgar10: asNumberOrNull(r.apgar_10),
      resuscitation: asJson(r.resuscitation),
      vitaminKAt: asTextOrNull(r.vitamin_k_at),
      firstFeedAt: asTextOrNull(r.first_feed_at),
      wristbandPairCode: asText(r.wristband_pair_code),
      nicuAdmitted: r.nicu_admitted === true,
      tempName: r.temp_name === true,
      lastCheckMatched: lastMatched,
      lastCheckAt: asTextOrNull(r.last_check_at),
      blockedBy,
      reportDueBy: dueBy,
      reportDaysLeft:
        dueBy === null ? null : Math.ceil((new Date(dueBy).getTime() - Date.now()) / 86_400_000),
      reportSubmitted: submitted,
    };
  }

  private toCheck(r: Record<string, unknown>): IdentityCheckRow {
    return {
      id: asText(r.id),
      newbornId: asText(r.newborn_id),
      checkedAt: asText(r.checked_at),
      motherBandScan: asText(r.mother_band_scan),
      babyBandScan: asText(r.baby_band_scan),
      matched: r.matched === true,
      context: asText(r.context),
      checkedBy: asText(r.checked_by),
    };
  }

  private toReport(r: Record<string, unknown>): BirthReportRow {
    const dueBy = asText(r.due_by);
    return {
      id: asText(r.id),
      newbornId: asText(r.newborn_id),
      form1: asJson(r.form1),
      dueBy,
      daysLeft: Math.ceil((new Date(dueBy).getTime() - Date.now()) / 86_400_000),
      verifiedAt: asTextOrNull(r.verified_at),
      submittedAt: asTextOrNull(r.submitted_at),
      crsRegNo: asTextOrNull(r.crs_reg_no),
    };
  }
}

const EPISODE_SELECT = `
  SELECT e.*,
         specialty.expected_dilatation_cm(e.active_phase_from, now(), e.partograph_standard) AS expected_cm,
         (SELECT p.dilatation_cm FROM specialty.partograph_entries p
           WHERE p.episode_id = e.id AND p.param = 'dilatation'
           ORDER BY p.recorded_at DESC, p.created_at DESC LIMIT 1) AS latest_cm,
         blk.raised_at AS blocked_since,
         (SELECT count(*) FROM specialty.partograph_alerts a
           WHERE a.episode_id = e.id AND a.acknowledged_at IS NULL) AS open_alerts,
         (SELECT count(*) FROM specialty.deliveries d WHERE d.episode_id = e.id) AS babies
    FROM specialty.labour_episodes e
    LEFT JOIN LATERAL (
      SELECT a.raised_at FROM specialty.partograph_alerts a
       WHERE a.episode_id = e.id AND a.blocking AND a.decision IS NULL
       ORDER BY a.raised_at LIMIT 1
    ) blk ON true`;

const DELIVERY_SELECT = `
  SELECT d.*, specialty.pph_threshold_ml(d.mode) AS pph_threshold_ml
    FROM specialty.deliveries d`;

const ACTIVATION_SELECT = `
  SELECT a.*, d.delivered_at
    FROM specialty.pph_activations a
    JOIN specialty.deliveries d ON d.id = a.delivery_id`;

const NEWBORN_SELECT = `
  SELECT n.*,
         chk.matched AS last_check_matched,
         chk.checked_at AS last_check_at,
         br.due_by AS report_due_by,
         br.submitted_at AS report_submitted_at
    FROM specialty.newborns n
    LEFT JOIN LATERAL (
      SELECT c.matched, c.checked_at FROM specialty.newborn_identity_checks c
       WHERE c.newborn_id = n.id
       ORDER BY c.checked_at DESC, c.created_at DESC LIMIT 1
    ) chk ON true
    LEFT JOIN specialty.birth_reports br ON br.newborn_id = n.id`;
