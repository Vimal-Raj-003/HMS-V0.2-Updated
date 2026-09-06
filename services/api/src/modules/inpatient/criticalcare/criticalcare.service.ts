import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { withCriticalCareErrors } from './criticalcare.errors.js';
import { criticalCareEvent } from './criticalcare.events.js';
import type {
  BloodIssueRequest,
  BloodRequestBody,
  BundleRequest,
  CartCheckRequest,
  CartRequest,
  CodeCloseRequest,
  CodeEventRequest,
  CodeQuery,
  CodeRequest,
  DonorRequest,
  FlowsheetRequest,
  InventoryQuery,
  ReactionRequest,
  SampleRequest,
  ScoreRequest,
  TransfuseRequest,
  TtiRequest,
  UnitRequest,
} from './criticalcare.schemas.js';
import type {
  BloodIssueRow,
  BloodRequestRow,
  BloodUnitRow,
  CodeDetail,
  CodeEventRow,
  CodeRow,
  FlowsheetRow,
} from './criticalcare.types.js';

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return '';
}
function asTextOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : asText(v);
}
function asNumber(v: unknown): number {
  return typeof v === 'number' ? v : Number(asText(v));
}
function asNumberOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : asNumber(v);
}
function asBool(v: unknown): boolean {
  return v === true || v === 't' || v === 'true';
}
function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
function seconds(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000);
}

/**
 * Phase 7E + 7F — intensive care, the code, and blood.
 *
 * ── Nothing here decides whether the bedside check happened ─────────────────
 *
 * `transfuse` sends two checkers and two scans, and the database refuses a
 * start without all four and refuses two checkers who are one person. This
 * service compares the scans against the patient and the bag so the refusal
 * says which one was wrong, and that is all it does — a second implementation
 * of a rule this consequential is a second thing that can be wrong.
 *
 * ── The code's clock is the flowsheet's ─────────────────────────────────────
 *
 * Time to first shock and time to first drug come from triggers on the
 * flowsheet rows. Nobody types a duration, because a duration somebody typed is
 * a duration somebody remembered.
 */
@Injectable()
export class CriticalCareService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
  ) {}

  private hospitalId(): string {
    const id = getContext().hospitalId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }
  private branchId(): string {
    const id = getContext().branchId;
    if (id === null || id === undefined) {
      throw AppError.conflict('This action needs a branch. Choose one and try again.');
    }
    return id;
  }
  private actorId(): string {
    const id = getContext().userId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }
  private guard<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withCriticalCareErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Intensive care
  // ═══════════════════════════════════════════════════════════════════════════

  async recordFlowsheet(body: FlowsheetRequest): Promise<FlowsheetRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.icu_flowsheet (
           id, hospital_id, branch_id, admission_id, patient_id, at_hour,
           heart_rate, systolic_bp, diastolic_bp, mean_arterial_bp, cvp_mmhg, temperature_c,
           spo2, fio2, respiratory_rate, vent_mode, peep_cm_h2o, tidal_volume_ml,
           gcs, rass, urine_output_ml, infusions, sources, recorded_by, created_at
         ) VALUES ($1,$2,$3,$4,$5, date_trunc('hour', COALESCE($6::timestamptz, now())),
                   $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23::jsonb,$24, now())
         ON CONFLICT (admission_id, at_hour) DO UPDATE SET
           heart_rate = COALESCE(EXCLUDED.heart_rate, clinical.icu_flowsheet.heart_rate),
           systolic_bp = COALESCE(EXCLUDED.systolic_bp, clinical.icu_flowsheet.systolic_bp),
           mean_arterial_bp = COALESCE(EXCLUDED.mean_arterial_bp, clinical.icu_flowsheet.mean_arterial_bp),
           spo2 = COALESCE(EXCLUDED.spo2, clinical.icu_flowsheet.spo2),
           fio2 = COALESCE(EXCLUDED.fio2, clinical.icu_flowsheet.fio2),
           vent_mode = COALESCE(EXCLUDED.vent_mode, clinical.icu_flowsheet.vent_mode),
           gcs = COALESCE(EXCLUDED.gcs, clinical.icu_flowsheet.gcs),
           rass = COALESCE(EXCLUDED.rass, clinical.icu_flowsheet.rass),
           urine_output_ml = COALESCE(EXCLUDED.urine_output_ml, clinical.icu_flowsheet.urine_output_ml),
           infusions = COALESCE(EXCLUDED.infusions, clinical.icu_flowsheet.infusions),
           sources = COALESCE(EXCLUDED.sources, clinical.icu_flowsheet.sources)
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          this.branchId(),
          body.admissionId,
          body.patientId,
          body.atHour ?? null,
          body.heartRate ?? null,
          body.systolicBp ?? null,
          body.diastolicBp ?? null,
          body.meanArterialBp ?? null,
          body.cvpMmhg ?? null,
          body.temperatureC ?? null,
          body.spo2 ?? null,
          body.fio2 ?? null,
          body.respiratoryRate ?? null,
          body.ventMode ?? null,
          body.peepCmH2o ?? null,
          body.tidalVolumeMl ?? null,
          body.gcs ?? null,
          body.rass ?? null,
          body.urineOutputMl ?? null,
          json(body.infusions),
          json(body.sources),
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The flowsheet entry was not recorded.');
      return this.toFlowsheet(row);
    });
  }

  private toFlowsheet(r: Record<string, unknown>): FlowsheetRow {
    return {
      id: asText(r['id']),
      admissionId: asText(r['admission_id']),
      atHour: asText(r['at_hour']),
      heartRate: asNumberOrNull(r['heart_rate']),
      systolicBp: asNumberOrNull(r['systolic_bp']),
      meanArterialBp: asNumberOrNull(r['mean_arterial_bp']),
      spo2: asNumberOrNull(r['spo2']),
      fio2: asNumberOrNull(r['fio2']),
      ventMode: asTextOrNull(r['vent_mode']),
      gcs: asNumberOrNull(r['gcs']),
      rass: asNumberOrNull(r['rass']),
      urineOutputMl: asNumberOrNull(r['urine_output_ml']),
      infusions: r['infusions'] ?? null,
      sources: r['sources'] ?? null,
      recordedBy: asText(r['recorded_by']),
    };
  }

  async flowsheet(admissionId: string, hours = 24): Promise<readonly FlowsheetRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.icu_flowsheet
          WHERE hospital_id = $1 AND admission_id = $2 AND at_hour > now() - make_interval(hours => $3::int)
          ORDER BY at_hour DESC`,
        [this.hospitalId(), admissionId, hours],
      );
      return rows.map((r) => this.toFlowsheet(r));
    });
  }

  async recordScore(body: ScoreRequest): Promise<{ readonly score: number }> {
    return this.guard(async (tx) => {
      const score = Object.values(body.components).reduce((n, v) => n + v, 0);
      await tx.query(
        `INSERT INTO clinical.icu_scores (
           id, hospital_id, admission_id, scale, score, components, at_hour, computed_by, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb, date_trunc('hour', now()), $7, now())`,
        [
          newId(),
          this.hospitalId(),
          body.admissionId,
          body.scale,
          score,
          json(body.components),
          this.actorId(),
        ],
      );
      return { score };
    });
  }

  /**
   * Record a bundle for a shift.
   *
   * `complete` is computed by a trigger from the elements. The literature on
   * care bundles is unambiguous: four of five is not eighty per cent of the
   * benefit, and a bundle scored partially is a bundle nobody completes.
   */
  async recordBundle(body: BundleRequest): Promise<{ readonly complete: boolean }> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.icu_bundles (
           id, hospital_id, admission_id, bundle, for_date, shift, elements, exceptions, recorded_by, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6::jsonb,$7::text[],$8,now(),now())
         ON CONFLICT (admission_id, bundle, for_date, shift) DO UPDATE SET
           elements = EXCLUDED.elements, exceptions = EXCLUDED.exceptions, updated_at = now()
         RETURNING id, complete`,
        [
          newId(),
          this.hospitalId(),
          body.admissionId,
          body.bundle,
          body.shift,
          json(body.elements),
          body.exceptions,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The bundle was not recorded.');

      if (!asBool(row['complete'])) {
        await this.outbox.publish(
          tx,
          criticalCareEvent('icu.bundle.incomplete', asText(row['id']), {
            bundleId: asText(row['id']),
            admissionId: body.admissionId,
            bundle: body.bundle,
            shift: body.shift,
            exceptions: body.exceptions,
          }),
        );
      }

      return { complete: asBool(row['complete']) };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The crash cart and the code
  // ═══════════════════════════════════════════════════════════════════════════

  async createCart(body: CartRequest): Promise<{ readonly id: string }> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.ip_crash_carts (
           id, hospital_id, branch_id, code, location, ward_id, seal_no, sealed_at, sealed_by,
           earliest_expiry_on, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7 IS NULL THEN NULL ELSE now() END,
                   CASE WHEN $7 IS NULL THEN NULL ELSE $8::uuid END, $9::date, now(), now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.code,
          body.location,
          body.wardId ?? null,
          body.sealNo ?? null,
          this.actorId(),
          body.earliestExpiryOn ?? null,
        ],
      );
      return { id };
    });
  }

  async checkCart(cartId: string, body: CartCheckRequest): Promise<{ readonly id: string }> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.ip_crash_cart_checks (
           id, hospital_id, cart_id, kind, seal_intact, seal_no_seen, findings, discrepancies,
           checked_at, checked_by, resealed_no, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::text[], now(), $9, $10, now())`,
        [
          id,
          this.hospitalId(),
          cartId,
          body.kind,
          body.sealIntact ?? null,
          body.sealNoSeen ?? null,
          json(body.findings),
          body.discrepancies,
          this.actorId(),
          body.resealedNo ?? null,
        ],
      );

      if (body.resealedNo !== undefined) {
        await tx.query(
          `UPDATE clinical.ip_crash_carts
              SET seal_no = $3, sealed_at = now(), sealed_by = $4,
                  last_full_check_at = CASE WHEN $5::text = 'full' THEN now() ELSE last_full_check_at END,
                  updated_at = now()
            WHERE id = $1 AND hospital_id = $2`,
          [cartId, this.hospitalId(), body.resealedNo, this.actorId(), body.kind],
        );
      }

      return { id };
    });
  }

  /**
   * Call a code.
   *
   * The event *is* the broadcast. The team hears it from the notification path,
   * not from a screen somebody happened to have open — which is the whole
   * reason a code is an event and not a row somebody polls for.
   */
  async callCode(body: CodeRequest): Promise<CodeDetail> {
    return this.guard(async (tx) => {
      const id = newId();
      const alloc = await this.numbering.allocate(tx, {
        key: 'CODE_BLUE',
        branchId: this.branchId(),
        refType: 'code_blue',
        refId: id,
      });

      await tx.query(
        `INSERT INTO clinical.ip_code_blues (
           id, hospital_id, branch_id, code_no, patient_id, admission_id, cart_id, ward_id,
           location, state, called_at, called_by, team_leader_id, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'called', now(), $10, $10, now(), now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          alloc.formatted,
          body.patientId ?? null,
          body.admissionId ?? null,
          body.cartId ?? null,
          body.wardId ?? null,
          body.location,
          this.actorId(),
        ],
      );

      await this.outbox.publish(
        tx,
        criticalCareEvent('code.blue.called', id, {
          codeId: id,
          codeNo: alloc.formatted,
          location: body.location,
          patientId: body.patientId ?? null,
          wardId: body.wardId ?? null,
          calledBy: this.actorId(),
        }),
      );

      return this.loadCode(tx, id);
    });
  }

  private toCode(r: Record<string, unknown>): CodeRow {
    const calledAt = asText(r['called_at']);
    return {
      id: asText(r['id']),
      codeNo: asText(r['code_no']),
      location: asText(r['location']),
      patientId: asTextOrNull(r['patient_id']),
      state: asText(r['state']),
      calledAt,
      calledBy: asText(r['called_by']),
      teamArrivedAt: asTextOrNull(r['team_arrived_at']),
      cprStartedAt: asTextOrNull(r['cpr_started_at']),
      firstShockAt: asTextOrNull(r['first_shock_at']),
      firstDrugAt: asTextOrNull(r['first_drug_at']),
      roscAt: asTextOrNull(r['rosc_at']),
      outcome: asTextOrNull(r['outcome']),
      cartRestockedAt: asTextOrNull(r['cart_restocked_at']),
      secondsToFirstShock: seconds(calledAt, asTextOrNull(r['first_shock_at'])),
      secondsToFirstDrug: seconds(calledAt, asTextOrNull(r['first_drug_at'])),
      secondsToCpr: seconds(calledAt, asTextOrNull(r['cpr_started_at'])),
      elapsedSeconds: Math.max(0, Math.round((Date.now() - new Date(calledAt).getTime()) / 1000)),
    };
  }

  private async loadCode(tx: TransactionClient, id: string): Promise<CodeDetail> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.ip_code_blues WHERE id = $1 AND hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That code is not on this hospital’s record.');

    const { rows: events } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM clinical.ip_code_blue_events WHERE code_id = $1 ORDER BY at`,
      [id],
    );
    const calledAt = asText(row['called_at']);

    return {
      ...this.toCode(row),
      debriefNote: asTextOrNull(row['debrief_note']),
      ceaseReason: asTextOrNull(row['cease_reason']),
      events: events.map((e): CodeEventRow => ({
        id: asText(e['id']),
        at: asText(e['at']),
        kind: asText(e['kind']),
        rhythm: asTextOrNull(e['rhythm']),
        joules: asNumberOrNull(e['joules']),
        drug: asTextOrNull(e['drug']),
        dose: asTextOrNull(e['dose']),
        route: asTextOrNull(e['route']),
        note: asTextOrNull(e['note']),
        recordedBy: asText(e['recorded_by']),
        secondsFromCall: seconds(calledAt, asText(e['at'])) ?? 0,
      })),
    };
  }

  async getCode(id: string): Promise<CodeDetail> {
    return this.guard((tx) => this.loadCode(tx, id));
  }

  async codes(query: CodeQuery): Promise<Page<CodeRow>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.ip_code_blues
          WHERE hospital_id = $1 AND branch_id = $2
            AND (NOT $3::boolean OR state <> 'closed')
          ORDER BY called_at DESC LIMIT $4`,
        [this.hospitalId(), this.branchId(), query.openOnly, query.limit],
      );
      return { items: rows.map((r) => this.toCode(r)), nextCursor: null, hasMore: false };
    });
  }

  async recordCodeEvent(codeId: string, body: CodeEventRequest): Promise<CodeDetail> {
    return this.guard(async (tx) => {
      await tx.query(
        `INSERT INTO clinical.ip_code_blue_events (
           id, hospital_id, code_id, at, kind, rhythm, joules, drug, dose, route, note, recorded_by, created_at
         ) VALUES ($1,$2,$3, COALESCE($4::timestamptz, now()), $5,$6,$7,$8,$9,$10,$11,$12, now())`,
        [
          newId(),
          this.hospitalId(),
          codeId,
          body.at ?? null,
          body.kind,
          body.rhythm ?? null,
          body.joules ?? null,
          body.drug ?? null,
          body.dose ?? null,
          body.route ?? null,
          body.note ?? null,
          this.actorId(),
        ],
      );
      return this.loadCode(tx, codeId);
    });
  }

  async closeCode(id: string, body: CodeCloseRequest): Promise<CodeDetail> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_code_blues
            SET state = 'closed', outcome = $3,
                cease_reason = COALESCE($4, cease_reason),
                ceased_at = CASE WHEN $3 <> 'rosc' THEN COALESCE(ceased_at, now()) ELSE ceased_at END,
                debrief_note = COALESCE($5, debrief_note),
                debrief_at = CASE WHEN $5 IS NULL THEN debrief_at ELSE now() END,
                updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND state <> 'closed'
          RETURNING code_no, called_at, cpr_started_at, first_shock_at, first_drug_at, rosc_at`,
        [id, this.hospitalId(), body.outcome, body.ceaseReason ?? null, body.debriefNote ?? null],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That code is already closed.');

      const calledAt = asText(row['called_at']);
      await this.outbox.publish(
        tx,
        criticalCareEvent('code.blue.closed', id, {
          codeId: id,
          codeNo: asText(row['code_no']),
          outcome: body.outcome,
          secondsToCpr: seconds(calledAt, asTextOrNull(row['cpr_started_at'])),
          secondsToFirstShock: seconds(calledAt, asTextOrNull(row['first_shock_at'])),
          secondsToFirstDrug: seconds(calledAt, asTextOrNull(row['first_drug_at'])),
          secondsToRosc: seconds(calledAt, asTextOrNull(row['rosc_at'])),
        }),
      );

      return this.loadCode(tx, id);
    });
  }

  /** Mark the cart restocked and re-sealed, which is what lets a code close. */
  async restockCart(codeId: string, sealNo: string): Promise<CodeDetail> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_code_blues SET cart_restocked_at = now(), updated_at = now()
          WHERE id = $1 AND hospital_id = $2 RETURNING cart_id`,
        [codeId, this.hospitalId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That code is not on this hospital’s record.');

      const cartId = asTextOrNull(row['cart_id']);
      if (cartId !== null) {
        await tx.query(
          `UPDATE clinical.ip_crash_carts
              SET seal_no = $3, sealed_at = now(), sealed_by = $4, last_full_check_at = now(), updated_at = now()
            WHERE id = $1 AND hospital_id = $2`,
          [cartId, this.hospitalId(), sealNo, this.actorId()],
        );
      }
      return this.loadCode(tx, codeId);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Blood
  // ═══════════════════════════════════════════════════════════════════════════

  async registerDonor(body: DonorRequest): Promise<{ readonly id: string }> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.bb_donors (id, hospital_id, donor_no, name, blood_group, phone, date_of_birth, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,now(),now())`,
        [
          id,
          this.hospitalId(),
          body.donorNo,
          body.name,
          body.bloodGroup ?? null,
          body.phone ?? null,
          body.dateOfBirth ?? null,
        ],
      );
      return { id };
    });
  }

  async bookUnit(body: UnitRequest): Promise<{ readonly id: string }> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO clinical.bb_units (
           id, hospital_id, branch_id, unit_no, donor_id, component, blood_group, volume_ml,
           collected_on, expires_on, state, storage_location, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6::clinical."BloodComponent",$7,$8,$9::date,$10::date,'quarantined',$11,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.unitNo,
          body.donorId ?? null,
          body.component,
          body.bloodGroup,
          body.volumeMl,
          body.collectedOn,
          body.expiresOn,
          body.storageLocation ?? null,
        ],
      );
      return { id };
    });
  }

  /** All five screens, then out of quarantine. The trigger checks the same. */
  async recordTti(unitId: string, body: TtiRequest): Promise<BloodUnitRow> {
    return this.guard(async (tx) => {
      const allClear = Object.values(body).every((v) => v === 'non_reactive');
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.bb_units
            SET tti_hiv = $3, tti_hbv = $4, tti_hcv = $5, tti_syphilis = $6, tti_malaria = $7,
                tti_cleared_at = CASE WHEN $8::boolean THEN now() ELSE NULL END,
                tti_cleared_by = CASE WHEN $8::boolean THEN $9::uuid ELSE NULL END,
                state = CASE WHEN $8::boolean AND state = 'quarantined'
                             THEN 'available'::clinical."BloodUnitState" ELSE state END,
                updated_at = now()
          WHERE id = $1 AND hospital_id = $2
          RETURNING *`,
        [
          unitId,
          this.hospitalId(),
          body.hiv,
          body.hbv,
          body.hcv,
          body.syphilis,
          body.malaria,
          allClear,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That unit is not on this hospital’s register.');
      return this.toUnit(row);
    });
  }

  private toUnit(r: Record<string, unknown>): BloodUnitRow {
    const pending: string[] = [];
    const check = (value: unknown, label: string): void => {
      if (asTextOrNull(value) !== 'non_reactive') pending.push(label);
    };
    check(r['tti_hiv'], 'HIV');
    check(r['tti_hbv'], 'HBV');
    check(r['tti_hcv'], 'HCV');
    check(r['tti_syphilis'], 'syphilis');
    check(r['tti_malaria'], 'malaria');

    const expiresOn = asText(r['expires_on']).slice(0, 10);
    return {
      id: asText(r['id']),
      unitNo: asText(r['unit_no']),
      component: asText(r['component']),
      bloodGroup: asText(r['blood_group']),
      volumeMl: asNumber(r['volume_ml']),
      collectedOn: asText(r['collected_on']).slice(0, 10),
      expiresOn,
      state: asText(r['state']),
      storageLocation: asTextOrNull(r['storage_location']),
      temperatureExcursion: asBool(r['temperature_excursion']),
      daysToExpiry: Math.round((new Date(expiresOn).getTime() - Date.now()) / 86_400_000),
      ttiPending: pending,
    };
  }

  async inventory(query: InventoryQuery): Promise<Page<BloodUnitRow>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.bb_units
          WHERE hospital_id = $1 AND branch_id = $2
            AND ($3::text IS NULL OR component::text = $3)
            AND ($4::text IS NULL OR blood_group = $4)
            AND (NOT $5::boolean OR state = 'available')
          ORDER BY expires_on, unit_no
          LIMIT $6`,
        [
          this.hospitalId(),
          this.branchId(),
          query.component ?? null,
          query.bloodGroup ?? null,
          query.availableOnly,
          query.limit,
        ],
      );
      return { items: rows.map((r) => this.toUnit(r)), nextCursor: null, hasMore: false };
    });
  }

  async requestBlood(body: BloodRequestBody): Promise<BloodRequestRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const alloc = await this.numbering.allocate(tx, {
        key: 'BLOOD_REQ',
        branchId: this.branchId(),
        refType: 'blood_request',
        refId: id,
      });

      await tx.query(
        `INSERT INTO clinical.bb_requests (
           id, hospital_id, branch_id, request_no, patient_id, admission_id, ot_case_id,
           component, units_requested, urgency, indication, requested_at, requested_by, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::clinical."BloodComponent",$9,$10,$11, now(), $12, now(), now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          alloc.formatted,
          body.patientId,
          body.admissionId ?? null,
          body.otCaseId ?? null,
          body.component,
          body.unitsRequested,
          body.urgency,
          body.indication,
          this.actorId(),
        ],
      );
      return this.loadRequest(tx, id);
    });
  }

  /**
   * Record a group sample.
   *
   * The second must be a different person from the first. Refusing here as well
   * as in the trigger means the message names the rule rather than the
   * constraint, and the person drawing the sample finds out before the bank
   * does.
   */
  async recordSample(requestId: string, body: SampleRequest): Promise<BloodRequestRow> {
    return this.guard(async (tx) => {
      if (body.which === 2) {
        const { rows: first } = await tx.query<Record<string, unknown>>(
          `SELECT sample_1_by FROM clinical.bb_requests WHERE id = $1 AND hospital_id = $2`,
          [requestId, this.hospitalId()],
        );
        if (asTextOrNull(first[0]?.['sample_1_by']) === this.actorId()) {
          throw new AppError(
            ProblemType.VALIDATION_FAILED,
            'You drew the first sample. The point of the second is that a different person drew it — one sample cannot detect itself being mislabelled.',
          );
        }
      }

      const column = body.which === 1 ? '1' : '2';
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.bb_requests
            SET group_sample_${column} = $3, sample_${column}_at = now(), sample_${column}_by = $4, updated_at = now()
          WHERE id = $1 AND hospital_id = $2
          RETURNING id`,
        [requestId, this.hospitalId(), body.bloodGroup, this.actorId()],
      );
      if (rows[0] === undefined) throw AppError.notFound('That request is not on this hospital’s record.');
      return this.loadRequest(tx, requestId);
    });
  }

  private async loadRequest(tx: TransactionClient, id: string): Promise<BloodRequestRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT r.*, (SELECT count(*) FROM clinical.bb_issues i WHERE i.request_id = r.id) AS units_issued
         FROM clinical.bb_requests r WHERE r.id = $1 AND r.hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const r = rows[0];
    if (r === undefined) throw AppError.notFound('That request is not on this hospital’s record.');

    const g1 = asTextOrNull(r['group_sample_1']);
    const g2 = asTextOrNull(r['group_sample_2']);
    const by1 = asTextOrNull(r['sample_1_by']);
    const by2 = asTextOrNull(r['sample_2_by']);

    return {
      id: asText(r['id']),
      requestNo: asText(r['request_no']),
      patientId: asText(r['patient_id']),
      component: asText(r['component']),
      unitsRequested: asNumber(r['units_requested']),
      urgency: asText(r['urgency']),
      indication: asText(r['indication']),
      state: asText(r['state']),
      groupSample1: g1,
      groupSample2: g2,
      groupCheckSatisfied: g1 !== null && g2 !== null && g1 === g2 && by1 !== null && by1 !== by2,
      requestedAt: asText(r['requested_at']),
      unitsIssued: asNumber(r['units_issued'] ?? 0),
    };
  }

  async issueBlood(body: BloodIssueRequest): Promise<BloodIssueRow> {
    return this.guard(async (tx) => {
      if (body.checkedBy === this.actorId()) {
        throw new AppError(
          ProblemType.VALIDATION_FAILED,
          'Issuing takes two people at the bank, and they are two different people.',
        );
      }

      const { rows: unit } = await tx.query<Record<string, unknown>>(
        `SELECT unit_no, state::text AS state, expires_on FROM clinical.bb_units
          WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
        [body.unitId, this.hospitalId()],
      );
      const u = unit[0];
      if (u === undefined) throw AppError.notFound('That unit is not on this hospital’s register.');
      if (new Date(asText(u['expires_on'])).getTime() < Date.now()) {
        throw AppError.conflict(
          `Unit ${asText(u['unit_no'])} expired on ${asText(u['expires_on']).slice(0, 10)}.`,
        );
      }

      const id = newId();
      const { rows: patient } = await tx.query<Record<string, unknown>>(
        `SELECT patient_id FROM clinical.bb_requests WHERE id = $1 AND hospital_id = $2`,
        [body.requestId, this.hospitalId()],
      );
      const patientId = asTextOrNull(patient[0]?.['patient_id']);
      if (patientId === null) throw AppError.notFound('That request is not on this hospital’s record.');

      await tx.query(
        `INSERT INTO clinical.bb_issues (
           id, hospital_id, branch_id, request_id, unit_id, patient_id,
           issued_at, issued_by, issue_checked_by, cooler_ref, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6, now(), $7, $8, $9, now(), now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.requestId,
          body.unitId,
          patientId,
          this.actorId(),
          body.checkedBy,
          body.coolerRef ?? null,
        ],
      );

      await tx.query(
        `UPDATE clinical.bb_units SET state = 'issued', reserved_for_patient_id = $3, updated_at = now()
          WHERE id = $1 AND hospital_id = $2`,
        [body.unitId, this.hospitalId(), patientId],
      );
      await tx.query(
        `UPDATE clinical.bb_requests SET state = 'issued', updated_at = now()
          WHERE id = $1 AND hospital_id = $2`,
        [body.requestId, this.hospitalId()],
      );

      const view = await this.loadIssue(tx, id);
      await this.outbox.publish(
        tx,
        criticalCareEvent('blood.issued', id, {
          issueId: id,
          requestId: body.requestId,
          unitNo: view.unitNo,
          component: view.component,
          bloodGroup: view.bloodGroup,
          patientId,
          issuedBy: this.actorId(),
          checkedBy: body.checkedBy,
        }),
      );
      return view;
    });
  }

  private async loadIssue(tx: TransactionClient, id: string): Promise<BloodIssueRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT i.*, u.unit_no, u.component::text AS component, u.blood_group
         FROM clinical.bb_issues i JOIN clinical.bb_units u ON u.id = i.unit_id
        WHERE i.id = $1 AND i.hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const r = rows[0];
    if (r === undefined) throw AppError.notFound('That issue is not on this hospital’s record.');

    const started = asTextOrNull(r['transfusion_started_at']);
    const c1 = asTextOrNull(r['bedside_checked_by_1']);
    const c2 = asTextOrNull(r['bedside_checked_by_2']);
    const blocked =
      started !== null
        ? null
        : c1 === null || c2 === null
          ? 'The two-person bedside check has not been done.'
          : r['bedside_wristband_scan'] === null || r['bedside_unit_scan'] === null
            ? 'The wristband and the bag have not both been scanned.'
            : null;

    return {
      id: asText(r['id']),
      requestId: asText(r['request_id']),
      unitId: asText(r['unit_id']),
      unitNo: asText(r['unit_no']),
      component: asText(r['component']),
      bloodGroup: asText(r['blood_group']),
      patientId: asText(r['patient_id']),
      issuedAt: asText(r['issued_at']),
      issuedBy: asText(r['issued_by']),
      issueCheckedBy: asText(r['issue_checked_by']),
      bedsideCheckedBy1: c1,
      bedsideCheckedBy2: c2,
      bedsideCheckedAt: asTextOrNull(r['bedside_checked_at']),
      transfusionStartedAt: started,
      transfusionEndedAt: asTextOrNull(r['transfusion_ended_at']),
      blockedBy: blocked,
    };
  }

  /**
   * Start the transfusion.
   *
   * The scans are compared against the patient and the bag so the refusal names
   * which was wrong. The database then refuses a start without both checkers,
   * both scans and a time, and refuses two checkers who are one person — so
   * this comparison being wrong is caught rather than trusted.
   */
  async transfuse(issueId: string, body: TransfuseRequest): Promise<BloodIssueRow> {
    return this.guard(async (tx) => {
      if (body.checkedBy === this.actorId()) {
        throw new AppError(
          ProblemType.VALIDATION_FAILED,
          'A second check by the same person is not a second check. The bedside check needs another nurse.',
        );
      }

      const { rows: found } = await tx.query<Record<string, unknown>>(
        `SELECT i.patient_id, i.transfusion_started_at, u.unit_no, u.blood_group
           FROM clinical.bb_issues i JOIN clinical.bb_units u ON u.id = i.unit_id
          WHERE i.id = $1 AND i.hospital_id = $2 FOR UPDATE OF i`,
        [issueId, this.hospitalId()],
      );
      const issue = found[0];
      if (issue === undefined) throw AppError.notFound('That issue is not on this hospital’s record.');
      if (issue['transfusion_started_at'] !== null) {
        throw AppError.conflict('That unit is already running.');
      }

      const patientId = asText(issue['patient_id']);
      const unitNo = asText(issue['unit_no']);

      if (!body.wristbandScan.includes(patientId)) {
        throw AppError.conflict(
          `That wristband is not this patient's. Unit ${unitNo} is cross-matched to the patient this bag was issued for — stop, and check both.`,
        );
      }
      if (!body.unitScan.includes(unitNo)) {
        throw AppError.conflict(
          `That is not unit ${unitNo}. The bag scanned reads ${body.unitScan.trim()} — do not hang it.`,
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.bb_issues
            SET bedside_checked_by_1 = $3, bedside_checked_by_2 = $4,
                bedside_wristband_scan = $5, bedside_unit_scan = $6,
                bedside_checked_at = now(), transfusion_started_at = now(), updated_at = now()
          WHERE id = $1 AND hospital_id = $2
          RETURNING issued_at`,
        [
          issueId,
          this.hospitalId(),
          this.actorId(),
          body.checkedBy,
          body.wristbandScan.trim(),
          body.unitScan.trim(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The transfusion was not started.');

      await tx.query(
        `UPDATE clinical.bb_units SET state = 'transfused', updated_at = now() WHERE id = (
           SELECT unit_id FROM clinical.bb_issues WHERE id = $1)`,
        [issueId],
      );

      await this.outbox.publish(
        tx,
        criticalCareEvent('blood.transfusion.started', issueId, {
          issueId,
          unitNo,
          patientId,
          checkedBy1: this.actorId(),
          checkedBy2: body.checkedBy,
          minutesFromIssue: Math.max(
            0,
            Math.round((Date.now() - new Date(asText(row['issued_at'])).getTime()) / 60_000),
          ),
        }),
      );

      return this.loadIssue(tx, issueId);
    });
  }

  async reportReaction(issueId: string, body: ReactionRequest): Promise<{ readonly id: string }> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.bb_reactions (
           id, hospital_id, issue_id, patient_id, kind, severity, onset_at, volume_in_ml,
           symptoms, management, bag_returned_at, reported_at, reported_by, created_at, updated_at
         )
         SELECT $1, $2, i.id, i.patient_id, $4, $5, now(), $6, $7::text[], $8,
                CASE WHEN $9::boolean THEN now() ELSE NULL END, now(), $10, now(), now()
           FROM clinical.bb_issues i WHERE i.id = $3 AND i.hospital_id = $2
         RETURNING patient_id`,
        [
          id,
          this.hospitalId(),
          issueId,
          body.kind,
          body.severity,
          body.volumeInMl ?? null,
          body.symptoms,
          body.management,
          body.bagReturned,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That issue is not on this hospital’s record.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'transfusion_reaction',
        rowId: id,
        businessKey: `${body.kind}/${body.severity}`,
        dataClass: 'phi',
        before: null,
        after: { kind: body.kind, severity: body.severity, volumeInMl: body.volumeInMl ?? null },
      });

      await this.outbox.publish(
        tx,
        criticalCareEvent('blood.reaction.reported', id, {
          reactionId: id,
          issueId,
          patientId: asText(row['patient_id']),
          kind: body.kind,
          severity: body.severity,
          volumeInMl: body.volumeInMl ?? null,
        }),
      );

      return { id };
    });
  }
}
