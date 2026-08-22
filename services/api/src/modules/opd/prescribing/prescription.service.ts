import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type ProblemFieldError } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { CdssService, type EvaluationOutcome, type ResolvedLine, type StoredAlert } from './cdss.service.js';
import { prescribingEvent } from './prescribing.events.js';
import type {
  AmendPrescriptionRequest,
  CancelPrescriptionRequest,
  CosignPrescriptionRequest,
  CreatePrescriptionRequest,
  EvaluateRequest,
  PrescriptionLineRequest,
  SignPrescriptionRequest,
} from './prescribing.schemas.js';
import type {
  AlertView,
  EvaluationView,
  PrescriptionItemView,
  PrescriptionView,
} from './prescribing.types.js';

/**
 * OP-002 §3.3 — the e-prescription.
 *
 * The shape of this service is set by four rules that are not negotiable, and
 * each one explains why a method here is longer than its CRUD equivalent.
 *
 * **Nothing is written until the safety check has run and been answered.**
 * `create`, `sign` and `amend` all evaluate first. A hard stop refuses the
 * request; a soft stop refuses it unless the request carried a coded reason for
 * that exact family. "The client did not send one" is not a reason.
 *
 * **The evaluation commits before the refusal.** Evaluation runs in its own
 * transaction so the `cdss_alert_events` rows — the evidence that the system
 * interrupted — survive the 422 that reports them. Writing them in the same
 * transaction as the refusal would roll them back with it, and a hard stop
 * nobody can prove happened is not a control.
 *
 * **A signed prescription is immutable.** There is no route that edits one.
 * `amend` writes a *new* revision that supersedes it, with a reason, exactly as
 * a clinical note is amended; the superseded row keeps its number, its items and
 * its signature. `cancel` moves the status and records why.
 *
 * **A resident's prescription is not dispensable until a consultant signs it.**
 * `rx.sign` is a permission a resident does not hold (`docs/05` row 14), so a
 * resident creates the draft with `requestCosign` and it emits `rx.held` rather
 * than `rx.created`; `cosign` is what releases it to the pharmacy.
 */
@Injectable()
export class PrescriptionService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(CdssService) private readonly cdss: CdssService,
  ) {}

  // ── evaluate only (EN-029 §6 `POST /cdss/evaluate`) ───────────────────────

  /**
   * Runs the rules over a draft bundle without persisting a prescription.
   *
   * This is the call the consultation screen makes as the doctor types, so the
   * red card appears before the Sign button is ever enabled. It still writes the
   * alert rows: an alert that was shown and not recorded is an alert that cannot
   * be audited, and EN-029 §3.2.8 requires every fire to be written.
   */
  async evaluate(body: EvaluateRequest): Promise<EvaluationView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const patient = await this.cdss.loadPatientFacts(tx, body.patientId, body.encounterId ?? null);
      const lines = await this.cdss.resolveLines(tx, body.items, patient);
      const outcome = await this.cdss.evaluateAndRecord(tx, {
        patient,
        patientId: body.patientId,
        encounterId: body.encounterId ?? null,
        branchId: getContext().branchId,
        lines,
        trigger: 'order_entry',
        persisted: false,
      });
      return toEvaluationView(outcome);
    });
  }

  /**
   * OP-002 §6 `POST /prescriptions/{id}/cdss-check` — re-run the rules over a
   * stored draft.
   *
   * This one **reports** rather than refuses: it is the "why is Sign disabled?"
   * call, so it returns the blocking alerts instead of throwing them. The
   * refusal lives on `sign`, which is the step that would put the drug in front
   * of the patient.
   */
  async recheck(id: string): Promise<EvaluationView> {
    const header = await this.load(id);
    const stored = await this.itemsAsRequests(id);
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const patient = await this.cdss.loadPatientFacts(tx, header.patient_id, header.encounter_id, id);
      const lines = await this.cdss.resolveLines(tx, stored.requests, patient, stored.itemIds);
      const outcome = await this.cdss.evaluateAndRecord(tx, {
        patient,
        patientId: header.patient_id,
        encounterId: header.encounter_id,
        branchId: header.branch_id,
        lines,
        trigger: 'verify',
        persisted: true,
      });
      return toEvaluationView(outcome);
    });
  }

  // ── create ────────────────────────────────────────────────────────────────

  async create(body: CreatePrescriptionRequest): Promise<PrescriptionView> {
    const ctx = getContext();
    const branchId = body.branchId ?? ctx.branchId;
    if (branchId === null) {
      throw AppError.conflict(
        'This session is not acting in a branch, and a prescription belongs to one. Choose a branch and try again.',
      );
    }

    const prepared = await this.prepare(body.patientId, body.encounterId ?? null, branchId, body.items);

    const id = newId();
    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const provisional = body.requestCosign;
      await tx.query(
        `INSERT INTO clinical.prescriptions (
           id, hospital_id, branch_id, encounter_id, patient_id, visit_id,
           doctor_user_id, status, revision,
           is_provisional, cosign_required,
           pharmacy_store_id, cdss_degraded, cdss_degraded_families, emergency_mode,
           notes, created_by, updated_by, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8::clinical."PrescriptionStatus", 1,
           $9, $9,
           $10, $11, $12::text[], false,
           $13, $14, $14, now()
         )`,
        [
          id,
          ctx.hospitalId,
          branchId,
          body.encounterId ?? null,
          body.patientId,
          body.visitId ?? null,
          ctx.userId,
          provisional ? 'awaiting_cosign' : 'draft',
          provisional,
          body.pharmacyStoreId ?? null,
          prepared.outcome.degraded,
          prepared.outcome.degradedFamilies,
          body.notes ?? null,
          ctx.userId,
        ],
      );

      await this.insertItems(tx, id, prepared.lines, prepared.outcome);

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'clinical.prescriptions',
        rowId: id,
        businessKey: null,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: body.encounterId ?? null,
        before: null,
        after: {
          status: provisional ? 'awaiting_cosign' : 'draft',
          item_count: prepared.lines.length,
          cdss_alerts: prepared.outcome.alerts.length,
          cdss_degraded: prepared.outcome.degraded,
        },
      });

      if (provisional) {
        await this.outbox.publish(
          tx,
          prescribingEvent('rx.held', id, {
            prescriptionId: id,
            patientId: body.patientId,
            reason: 'awaiting_cosign',
            detail: 'A consultant countersignature is required before the pharmacy may dispense.',
            heldAt: new Date().toISOString(),
          }),
        );
      }
    });

    return this.get(id);
  }

  // ── sign ──────────────────────────────────────────────────────────────────

  /**
   * Signs the prescription and releases it to the pharmacy.
   *
   * The CDSS runs **again** here, against the context as it stands now. The
   * draft may have been written twenty minutes ago; an allergy recorded in the
   * meantime, or a drug added on another prescription, changes the answer, and
   * the signature is the moment the prescriber becomes accountable for it.
   */
  async sign(id: string, body: SignPrescriptionRequest): Promise<PrescriptionView> {
    const header = await this.load(id);
    if (header.status === 'signed' || header.status === 'dispensed') {
      throw new AppError(
        ProblemType.ALREADY_DECIDED,
        'This prescription is already signed. Amend it to change anything on it.',
      );
    }
    if (header.status === 'cancelled' || header.status === 'amended') {
      throw AppError.conflict('This prescription is no longer active.');
    }
    if (header.is_provisional) {
      throw AppError.conflict(
        'This prescription is waiting for a consultant countersignature; it is released by co-signing, not by signing again.',
      );
    }

    const stored = await this.itemsAsRequests(id);
    const prepared = await this.prepare(
      header.patient_id,
      header.encounter_id,
      header.branch_id,
      stored.requests,
      stored.itemIds,
      id,
    );

    const ctx = getContext();
    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const allocation = await this.numbering.allocate(tx, {
        key: 'RX',
        branchId: header.branch_id,
        refType: 'clinical.prescriptions',
        refId: id,
      });
      const registration = await this.registrationOf(tx, ctx.userId);

      // Re-stamp the lines with what the re-evaluation just found, so the
      // pharmacist sees the alerts that stood at signing, not at drafting. The
      // rows are updated, never replaced: DELETE is revoked on
      // `clinical.prescription_items` (migration §D), which is the point — a
      // clinical row is corrected by a new value, not by removal and re-insert.
      await this.refreshItemAlerts(tx, id, prepared.lines, prepared.outcome);

      await tx.query(
        `UPDATE clinical.prescriptions
            SET status = 'signed', rx_no = $2, signed_at = now(), signed_by = $3,
                sign_method = $4::clinical."SignMethod", sign_channel = 'online',
                signer_registration_no = $5,
                pharmacy_store_id = COALESCE($6, pharmacy_store_id),
                cdss_degraded = $7, cdss_degraded_families = $8::text[],
                updated_by = $3, updated_at = now(), version = version + 1
          WHERE id = $1`,
        [
          id,
          allocation.formatted,
          ctx.userId,
          body.signMethod,
          registration,
          body.pharmacyStoreId ?? null,
          prepared.outcome.degraded,
          prepared.outcome.degradedFamilies,
        ],
      );

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'clinical.prescriptions',
        rowId: id,
        businessKey: allocation.formatted,
        dataClass: 'phi',
        patientId: header.patient_id,
        encounterId: header.encounter_id,
        before: { status: header.status },
        after: {
          status: 'signed',
          rx_no: allocation.formatted,
          sign_method: body.signMethod,
          cdss_degraded: prepared.outcome.degraded,
        },
      });

      await this.publishCreated(tx, id, header, allocation.formatted, prepared);
    });

    return this.get(id);
  }

  // ── co-sign ───────────────────────────────────────────────────────────────

  /** OP-002 AC-5 — the consultant's signature is what releases a resident's Rx. */
  async cosign(id: string, body: CosignPrescriptionRequest): Promise<PrescriptionView> {
    const header = await this.load(id);
    if (header.status !== 'awaiting_cosign') {
      throw AppError.conflict('Only a prescription awaiting a countersignature can be co-signed.');
    }
    const ctx = getContext();
    if (header.doctor_user_id === ctx.userId) {
      throw new AppError(
        ProblemType.SEGREGATION_OF_DUTIES,
        'A prescription cannot be countersigned by the person who wrote it.',
      );
    }

    const stored = await this.itemsAsRequests(id);
    const prepared = await this.prepare(
      header.patient_id,
      header.encounter_id,
      header.branch_id,
      stored.requests,
      stored.itemIds,
      id,
    );

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const allocation = await this.numbering.allocate(tx, {
        key: 'RX',
        branchId: header.branch_id,
        refType: 'clinical.prescriptions',
        refId: id,
      });
      const registration = await this.registrationOf(tx, ctx.userId);

      await this.refreshItemAlerts(tx, id, prepared.lines, prepared.outcome);

      await tx.query(
        `UPDATE clinical.prescriptions
            SET status = 'signed', rx_no = $2, signed_at = now(), signed_by = $3,
                sign_method = $4::clinical."SignMethod", signer_registration_no = $5,
                is_provisional = false, cosigned_by = $3, cosigned_at = now(),
                cdss_degraded = $6, cdss_degraded_families = $7::text[],
                updated_by = $3, updated_at = now(), version = version + 1
          WHERE id = $1`,
        [
          id,
          allocation.formatted,
          ctx.userId,
          body.signMethod,
          registration,
          prepared.outcome.degraded,
          prepared.outcome.degradedFamilies,
        ],
      );

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'clinical.prescriptions',
        rowId: id,
        businessKey: allocation.formatted,
        dataClass: 'phi',
        patientId: header.patient_id,
        encounterId: header.encounter_id,
        before: { status: 'awaiting_cosign', is_provisional: true },
        after: { status: 'signed', cosigned_by: ctx.userId, rx_no: allocation.formatted },
      });

      await this.outbox.publish(
        tx,
        prescribingEvent('rx.cosigned', id, {
          prescriptionId: id,
          patientId: header.patient_id,
          originalSignerUserId: header.doctor_user_id,
          cosignedBy: ctx.userId ?? '',
          cosignedAt: new Date().toISOString(),
        }),
      );
      await this.publishCreated(tx, id, header, allocation.formatted, prepared);
    });

    return this.get(id);
  }

  // ── amend ─────────────────────────────────────────────────────────────────

  /**
   * A signed prescription is never edited. This writes the next revision and
   * points the two at each other; the pharmacy re-reads, because the previous
   * revision is no longer dispensable.
   */
  async amend(id: string, body: AmendPrescriptionRequest): Promise<PrescriptionView> {
    const header = await this.load(id);
    if (header.status !== 'signed') {
      throw AppError.conflict('Only a signed prescription can be amended.');
    }

    // The prescription being superseded is excluded from the patient's active
    // medication list: an amendment duplicating its own previous revision is not
    // a clinical finding.
    const prepared = await this.prepare(
      header.patient_id,
      header.encounter_id,
      header.branch_id,
      body.items,
      [],
      id,
    );

    const ctx = getContext();
    const newRxId = newId();
    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const allocation = await this.numbering.allocate(tx, {
        key: 'RX',
        branchId: header.branch_id,
        refType: 'clinical.prescriptions',
        refId: newRxId,
      });
      const registration = await this.registrationOf(tx, ctx.userId);

      await tx.query(
        `INSERT INTO clinical.prescriptions (
           id, hospital_id, branch_id, encounter_id, patient_id, visit_id,
           doctor_user_id, rx_no, status, revision, supersedes_id, amendment_reason,
           signed_at, signed_by, sign_method, signer_registration_no,
           pharmacy_store_id, cdss_degraded, cdss_degraded_families,
           notes, created_by, updated_by, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, 'signed', $9, $10, $11,
           now(), $7, 'system', $12,
           $13, $14, $15::text[],
           $16, $7, $7, now()
         )`,
        [
          newRxId,
          ctx.hospitalId,
          header.branch_id,
          header.encounter_id,
          header.patient_id,
          header.visit_id,
          ctx.userId,
          allocation.formatted,
          header.revision + 1,
          id,
          body.reason,
          registration,
          header.pharmacy_store_id,
          prepared.outcome.degraded,
          prepared.outcome.degradedFamilies,
          body.notes ?? null,
        ],
      );
      await this.insertItems(tx, newRxId, prepared.lines, prepared.outcome);

      await tx.query(
        `UPDATE clinical.prescriptions
            SET status = 'amended', superseded_by_id = $2, updated_by = $3,
                updated_at = now(), version = version + 1
          WHERE id = $1`,
        [id, newRxId, ctx.userId],
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.prescriptions',
        rowId: id,
        businessKey: header.rx_no,
        dataClass: 'phi',
        patientId: header.patient_id,
        encounterId: header.encounter_id,
        before: { status: 'signed', revision: header.revision },
        after: { status: 'amended', superseded_by_id: newRxId, revision: header.revision + 1 },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        prescribingEvent('rx.amended', newRxId, {
          prescriptionId: newRxId,
          supersedesId: id,
          revision: header.revision + 1,
          patientId: header.patient_id,
          reason: body.reason,
          amendedBy: ctx.userId ?? '',
          amendedAt: new Date().toISOString(),
        }),
      );
    });

    return this.get(newRxId);
  }

  // ── cancel ────────────────────────────────────────────────────────────────

  async cancel(id: string, body: CancelPrescriptionRequest): Promise<PrescriptionView> {
    const header = await this.load(id);
    if (header.status === 'cancelled') {
      throw new AppError(ProblemType.ALREADY_DECIDED, 'This prescription is already cancelled.');
    }
    if (header.status === 'dispensed' || header.status === 'partially_dispensed') {
      throw AppError.conflict(
        'This prescription has been dispensed. Record the change as a new prescription rather than cancelling it.',
      );
    }

    const ctx = getContext();
    await this.db.withTenant(currentTenantContext(), async (tx) => {
      await tx.query(
        `UPDATE clinical.prescriptions
            SET status = 'cancelled', updated_by = $2, updated_at = now(), version = version + 1
          WHERE id = $1`,
        [id, ctx.userId],
      );
      await tx.query(
        `UPDATE clinical.prescription_items
            SET status = 'cancelled', updated_by = $2, updated_at = now()
          WHERE prescription_id = $1 AND status = 'active'`,
        [id, ctx.userId],
      );

      await this.audit.write(tx, {
        // EN-024 §5 lists cancellation of a clinical record among the four
        // reason-mandatory actions; `delete` is that action in the catalogue,
        // and nothing is actually removed (DELETE is revoked on the table).
        action: 'delete',
        entity: 'clinical.prescriptions',
        rowId: id,
        businessKey: header.rx_no,
        dataClass: 'phi',
        patientId: header.patient_id,
        encounterId: header.encounter_id,
        before: { status: header.status },
        after: { status: 'cancelled' },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        prescribingEvent('rx.cancelled', id, {
          prescriptionId: id,
          patientId: header.patient_id,
          reason: body.reason,
          cancelledBy: ctx.userId ?? '',
          cancelledAt: new Date().toISOString(),
        }),
      );
    });

    return this.get(id);
  }

  // ── read ──────────────────────────────────────────────────────────────────

  async get(id: string): Promise<PrescriptionView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<PrescriptionRow>(HEADER_SQL, [id]);
      if (header === undefined) throw AppError.notFound('The prescription');
      const items = await tx.rows<ItemRow>(
        `SELECT id, line_no, drug_key, generic_name, brand_name, strength_text,
                dose_qty::text AS dose_qty, dose_unit, dose_basis::text AS dose_basis,
                weight_used_kg::text AS weight_used_kg, computed_dose_qty::text AS computed_dose_qty,
                frequency_code, timing, duration_value, duration_unit, quantity::text AS quantity,
                is_prn, schedule_class::text AS schedule_class, hard_stop_fired,
                status::text AS status, cdss_alerts
           FROM clinical.prescription_items
          WHERE prescription_id = $1
          ORDER BY line_no`,
        [id],
      );
      return toPrescriptionView(header, items);
    });
  }

  // ── the shared preparation step ───────────────────────────────────────────

  /**
   * Resolve → evaluate → refuse, in that order, in its own transaction.
   *
   * Everything that can stop a prescription happens here, and it happens the
   * same way for `create`, `sign` and `amend`. That is deliberate: three copies
   * of this sequence would be three chances for one of them to lose a check.
   */
  private async prepare(
    patientId: string,
    encounterId: string | null,
    branchId: string,
    items: readonly PrescriptionLineRequest[],
    existingItemIds: readonly (string | undefined)[] = [],
    excludePrescriptionId: string | null = null,
  ): Promise<{ readonly lines: readonly ResolvedLine[]; readonly outcome: EvaluationOutcome }> {
    const { lines, outcome } = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const patient = await this.cdss.loadPatientFacts(tx, patientId, encounterId, excludePrescriptionId);
      const resolved = await this.cdss.resolveLines(tx, items, patient, existingItemIds);
      const result = await this.cdss.evaluateAndRecord(tx, {
        patient,
        patientId,
        encounterId,
        branchId,
        lines: resolved,
        trigger: 'order_entry',
        persisted: true,
      });
      return { lines: resolved, outcome: result };
    });

    // The controlled-drug authority is asserted outside the transaction, because
    // the policy engine reads roles on its own connection and holding an open
    // transaction across that round trip is the stall `patient.service.ts`
    // documents. A 403 here precedes the 422 below on purpose: a prescriber who
    // may not write a narcotic at all should not be told which rule fired.
    await this.cdss.assertControlledAuthority(lines);

    if (outcome.blocking.length > 0) throw hardStopError(outcome.blocking);
    if (outcome.unresolved.length > 0) throw needsReasonError(outcome.unresolved);

    return { lines, outcome };
  }

  private async insertItems(
    tx: TransactionClient,
    prescriptionId: string,
    lines: readonly ResolvedLine[],
    outcome: EvaluationOutcome,
  ): Promise<void> {
    const ctx = getContext();
    for (const line of lines) {
      const alerts = outcome.alerts.filter((a) => a.lineNo === line.candidate.lineNo);
      const overrides = line.request.overrides;
      const views: AlertView[] = alerts.map((alert) => ({
        alertEventId: alert.alertEventId,
        firedAt: alert.firedAt,
        lineNo: alert.lineNo,
        family: alert.family,
        severity: alert.severity,
        interruption: alert.interruption,
        safetyFloorKey: alert.floorKey,
        title: alert.title,
        detail: alert.detail,
        suggestedAction: alert.suggestedAction,
        subjectCode: alert.subjectCode,
        overrideReasonCode: overrides.find((o) => o.family === alert.family)?.reasonCode ?? null,
        cleared: alert.cleared,
      }));

      await tx.query(
        `INSERT INTO clinical.prescription_items (
           id, hospital_id, prescription_id, line_no,
           drug_key, brand_key, generic_name, brand_name, strength_text,
           dose_qty, dose_unit, dose_basis, weight_used_kg, bsa_used_m2, computed_dose_qty,
           frequency_code, timing, duration_value, duration_unit, quantity, quantity_unit, refills,
           is_prn, prn_reason, instructions_text, do_not_substitute, external_only,
           cdss_alerts, hard_stop_fired, status, created_by, updated_by, updated_at
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7, $8, $9,
           $10, $11, $12::clinical."DoseBasis", $13, $14, $15,
           $16, $17, $18, $19, $20, $21, $22,
           $23, $24, $25, $26, $27,
           $28::jsonb, $29, 'active', $30, $30, now()
         )`,
        [
          line.prescriptionItemId,
          ctx.hospitalId,
          prescriptionId,
          line.candidate.lineNo,
          line.drugKey,
          line.brandKey,
          line.candidate.drug.genericName,
          line.brandName,
          line.strengthText,
          line.candidate.doseQty,
          line.candidate.doseUnit,
          line.candidate.doseBasis,
          line.weightUsedKg,
          line.bsaUsedM2,
          line.computedDoseQty,
          line.request.frequencyCode ?? null,
          line.request.timing ?? null,
          line.request.durationValue ?? null,
          line.request.durationUnit ?? null,
          line.request.quantity ?? null,
          line.request.quantityUnit ?? null,
          line.request.refills,
          line.request.isPrn,
          line.request.prnReason ?? null,
          line.request.instructionsText ?? null,
          line.request.doNotSubstitute,
          line.request.externalOnly,
          JSON.stringify(views),
          alerts.some((a) => a.interruption === 'hard_stop'),
          ctx.userId,
        ],
      );
    }
  }

  /**
   * Updates the stored lines with the alerts the sign-time re-evaluation found.
   *
   * Matched on `line_no`, because the lines came from these very rows: the
   * re-evaluation is of the same prescription, not a new one.
   */
  private async refreshItemAlerts(
    tx: TransactionClient,
    prescriptionId: string,
    lines: readonly ResolvedLine[],
    outcome: EvaluationOutcome,
  ): Promise<void> {
    const ctx = getContext();
    for (const line of lines) {
      const alerts = outcome.alerts.filter((a) => a.lineNo === line.candidate.lineNo);
      const overrides = line.request.overrides;
      const views: AlertView[] = alerts.map((alert) => ({
        alertEventId: alert.alertEventId,
        firedAt: alert.firedAt,
        lineNo: alert.lineNo,
        family: alert.family,
        severity: alert.severity,
        interruption: alert.interruption,
        safetyFloorKey: alert.floorKey,
        title: alert.title,
        detail: alert.detail,
        suggestedAction: alert.suggestedAction,
        subjectCode: alert.subjectCode,
        overrideReasonCode: overrides.find((o) => o.family === alert.family)?.reasonCode ?? null,
        cleared: alert.cleared,
      }));

      await tx.query(
        `UPDATE clinical.prescription_items
            SET cdss_alerts = $3::jsonb, hard_stop_fired = $4, updated_by = $5, updated_at = now()
          WHERE prescription_id = $1 AND line_no = $2`,
        [
          prescriptionId,
          line.candidate.lineNo,
          JSON.stringify(views),
          alerts.some((a) => a.interruption === 'hard_stop'),
          ctx.userId,
        ],
      );
    }
  }

  /**
   * Rebuilds the request lines from the stored ones, carrying forward the coded
   * reasons already recorded against them.
   *
   * Without that last part, signing a draft whose soft stops were answered at
   * drafting time would refuse for want of reasons that had, in fact, been
   * given — and the pressure to "fix" that by not re-evaluating at signing is
   * exactly how the sign-time check gets lost.
   */
  private async itemsAsRequests(prescriptionId: string): Promise<{
    readonly requests: readonly PrescriptionLineRequest[];
    readonly itemIds: readonly string[];
  }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const rows = await tx.rows<ItemRow>(
        `SELECT id, line_no, drug_key, brand_key, generic_name, brand_name, strength_text,
                dose_qty::text AS dose_qty, dose_unit, dose_basis::text AS dose_basis,
                weight_used_kg::text AS weight_used_kg, computed_dose_qty::text AS computed_dose_qty,
                frequency_code, timing, duration_value, duration_unit, quantity::text AS quantity,
                quantity_unit, refills, is_prn, prn_reason, instructions_text, do_not_substitute,
                external_only, schedule_class::text AS schedule_class, hard_stop_fired,
                status::text AS status, cdss_alerts
           FROM clinical.prescription_items
          WHERE prescription_id = $1 AND status <> 'cancelled'
          ORDER BY line_no`,
        [prescriptionId],
      );

      const requests = rows.map((row) => {
        const answered = (row.cdss_alerts ?? [])
          .filter((a): a is AlertView => a.overrideReasonCode !== null)
          .map((a) => ({ family: a.family, reasonCode: a.overrideReasonCode ?? '' }));
        return {
          ...(row.drug_key === null ? {} : { drugKey: row.drug_key }),
          ...(row.brand_key === null || row.brand_key === undefined ? {} : { brandKey: row.brand_key }),
          genericName: row.generic_name,
          ...(row.dose_qty === null ? {} : { doseQty: Number(row.dose_qty) }),
          ...(row.dose_unit === null ? {} : { doseUnit: row.dose_unit }),
          doseBasis: row.dose_basis as PrescriptionLineRequest['doseBasis'],
          ...(row.frequency_code === null ? {} : { frequencyCode: row.frequency_code }),
          ...(row.timing === null ? {} : { timing: row.timing as PrescriptionLineRequest['timing'] }),
          ...(row.duration_value === null ? {} : { durationValue: row.duration_value }),
          ...(row.duration_unit === null
            ? {}
            : { durationUnit: row.duration_unit as PrescriptionLineRequest['durationUnit'] }),
          ...(row.quantity === null ? {} : { quantity: Number(row.quantity) }),
          ...(row.quantity_unit === null || row.quantity_unit === undefined
            ? {}
            : { quantityUnit: row.quantity_unit }),
          refills: row.refills ?? 0,
          isPrn: row.is_prn,
          ...(row.prn_reason === null || row.prn_reason === undefined ? {} : { prnReason: row.prn_reason }),
          ...(row.instructions_text === null || row.instructions_text === undefined
            ? {}
            : { instructionsText: row.instructions_text }),
          doNotSubstitute: row.do_not_substitute ?? false,
          externalOnly: row.external_only ?? false,
          overrides: answered,
        } satisfies PrescriptionLineRequest;
      });
      return { requests, itemIds: rows.map((row) => row.id) };
    });
  }

  private async load(id: string): Promise<PrescriptionRow> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<PrescriptionRow>(HEADER_SQL, [id]);
      // A prescription in another hospital is filtered by RLS and reads as
      // missing — never as forbidden (docs/09 §3.1 case 2).
      if (row === undefined) throw AppError.notFound('The prescription');
      return row;
    });
  }

  private async registrationOf(tx: TransactionClient, userId: string | null): Promise<string | null> {
    if (userId === null) return null;
    const row = await tx.maybeOne<{ registration_number: string | null }>(
      `SELECT registration_number FROM mdm.mdm_practitioners
        WHERE user_id = $1 AND status = 'active'
          AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
        LIMIT 1`,
      [userId],
    );
    return row?.registration_number ?? null;
  }

  private async publishCreated(
    tx: TransactionClient,
    id: string,
    header: PrescriptionRow,
    rxNo: string,
    prepared: { readonly lines: readonly ResolvedLine[]; readonly outcome: EvaluationOutcome },
  ): Promise<void> {
    await this.outbox.publish(
      tx,
      prescribingEvent('rx.created', id, {
        prescriptionId: id,
        rxNo,
        patientId: header.patient_id,
        encounterId: header.encounter_id,
        doctorUserId: header.doctor_user_id,
        pharmacyStoreId: header.pharmacy_store_id,
        itemCount: prepared.lines.length,
        scheduleClasses: [
          ...new Set(prepared.lines.map((l) => l.candidate.drug.schedule).filter((s) => s !== 'otc')),
        ],
        cdssDegraded: prepared.outcome.degraded,
        emergencyMode: false,
        signedAt: new Date().toISOString(),
      }),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const HEADER_SQL = `
  SELECT id, hospital_id, branch_id, rx_no, patient_id, encounter_id, visit_id, doctor_user_id,
         status::text AS status, revision, supersedes_id, superseded_by_id, amendment_reason,
         is_provisional, cosign_required, cosigned_by, pharmacy_store_id,
         signed_at::text AS signed_at, signed_by, signer_registration_no,
         cdss_degraded, cdss_degraded_families, emergency_mode
    FROM clinical.prescriptions
   WHERE id = $1`;

interface PrescriptionRow {
  readonly id: string;
  readonly hospital_id: string;
  readonly branch_id: string;
  readonly rx_no: string | null;
  readonly patient_id: string;
  readonly encounter_id: string | null;
  readonly visit_id: string | null;
  readonly doctor_user_id: string;
  readonly status: string;
  readonly revision: number;
  readonly supersedes_id: string | null;
  readonly superseded_by_id: string | null;
  readonly amendment_reason: string | null;
  readonly is_provisional: boolean;
  readonly cosign_required: boolean;
  readonly cosigned_by: string | null;
  readonly pharmacy_store_id: string | null;
  readonly signed_at: string | null;
  readonly signed_by: string | null;
  readonly signer_registration_no: string | null;
  readonly cdss_degraded: boolean;
  readonly cdss_degraded_families: string[];
  readonly emergency_mode: boolean;
}

interface ItemRow {
  readonly id: string;
  readonly line_no: number;
  readonly drug_key: string | null;
  readonly brand_key?: string | null;
  readonly generic_name: string;
  readonly brand_name: string | null;
  readonly strength_text: string | null;
  readonly dose_qty: string | null;
  readonly dose_unit: string | null;
  readonly dose_basis: string;
  readonly weight_used_kg: string | null;
  readonly computed_dose_qty: string | null;
  readonly frequency_code: string | null;
  readonly timing: string | null;
  readonly duration_value: number | null;
  readonly duration_unit: string | null;
  readonly quantity: string | null;
  readonly quantity_unit?: string | null;
  readonly refills?: number;
  readonly is_prn: boolean;
  readonly prn_reason?: string | null;
  readonly instructions_text?: string | null;
  readonly do_not_substitute?: boolean;
  readonly external_only?: boolean;
  readonly schedule_class: string | null;
  readonly hard_stop_fired: boolean;
  readonly status: string;
  readonly cdss_alerts: AlertView[] | null;
}

function toPrescriptionView(header: PrescriptionRow, items: readonly ItemRow[]): PrescriptionView {
  const lines: PrescriptionItemView[] = items.map((row) => ({
    id: row.id,
    line_no: row.line_no,
    drug_key: row.drug_key,
    generic_name: row.generic_name,
    brand_name: row.brand_name,
    strength_text: row.strength_text,
    dose_qty: row.dose_qty === null ? null : Number(row.dose_qty),
    dose_unit: row.dose_unit,
    dose_basis: row.dose_basis,
    weight_used_kg: row.weight_used_kg === null ? null : Number(row.weight_used_kg),
    computed_dose_qty: row.computed_dose_qty === null ? null : Number(row.computed_dose_qty),
    frequency_code: row.frequency_code,
    timing: row.timing,
    duration_value: row.duration_value,
    duration_unit: row.duration_unit,
    quantity: row.quantity === null ? null : Number(row.quantity),
    is_prn: row.is_prn,
    schedule_class: row.schedule_class,
    hard_stop_fired: row.hard_stop_fired,
    status: row.status,
    cdss_alerts: row.cdss_alerts ?? [],
  }));

  return {
    id: header.id,
    rx_no: header.rx_no,
    patient_id: header.patient_id,
    encounter_id: header.encounter_id,
    status: header.status,
    revision: header.revision,
    supersedes_id: header.supersedes_id,
    superseded_by_id: header.superseded_by_id,
    amendment_reason: header.amendment_reason,
    is_provisional: header.is_provisional,
    cosign_required: header.cosign_required,
    cosigned_by: header.cosigned_by,
    signed_at: header.signed_at,
    signed_by: header.signed_by,
    signer_registration_no: header.signer_registration_no,
    cdss_degraded: header.cdss_degraded,
    cdss_degraded_families: header.cdss_degraded_families,
    emergency_mode: header.emergency_mode,
    items: lines,
  };
}

export function toAlertView(alert: StoredAlert, overrideReasonCode: string | null = null): AlertView {
  return {
    alertEventId: alert.alertEventId,
    firedAt: alert.firedAt,
    lineNo: alert.lineNo,
    family: alert.family,
    severity: alert.severity,
    interruption: alert.interruption,
    safetyFloorKey: alert.floorKey,
    title: alert.title,
    detail: alert.detail,
    suggestedAction: alert.suggestedAction,
    subjectCode: alert.subjectCode,
    overrideReasonCode,
    cleared: alert.cleared,
  };
}

export function toEvaluationView(outcome: EvaluationOutcome): EvaluationView {
  return {
    alerts: outcome.alerts.map((a) => toAlertView(a)),
    blocking: outcome.blocking.map((a) => toAlertView(a)),
    needsCodedReason: outcome.unresolved.map((a) => toAlertView(a)),
    degraded: outcome.degraded,
    degradedFamilies: outcome.degradedFamilies,
    snapshotDigest: outcome.snapshotDigest,
    latencyMs: outcome.latencyMs,
    ruleLatencyMs: outcome.ruleLatencyMs,
  };
}

/**
 * The refusal a hard stop produces.
 *
 * `clinicalImpact` and `nextAction` are populated because `docs/06` §1.1
 * heuristic 9 requires an error to say what it means clinically and what to do —
 * and because the thing to do here is specific: change the order, or get a
 * consultant to countersign the alert. The alert ids travel in `errors[].code`
 * so the client can post the countersignature against the exact event.
 */
function hardStopError(alerts: readonly StoredAlert[]): AppError {
  const errors: ProblemFieldError[] = alerts.map((alert) => ({
    path: `items/${alert.lineNo - 1}`,
    code: alert.alertEventId,
    message: `${alert.title} — ${alert.detail}`,
  }));
  return new AppError(ProblemType.CLINICAL_HARD_STOP, 'This prescription was stopped for patient safety.', {
    errors,
    clinicalImpact: alerts.map((a) => a.title).join('; '),
    nextAction:
      'Change the prescription, or have a consultant countersign the alert (POST /cdss/alerts/{id}/respond).',
  });
}

/** The refusal a soft stop produces when no coded reason accompanied it. */
function needsReasonError(alerts: readonly StoredAlert[]): AppError {
  const errors: ProblemFieldError[] = alerts.map((alert) => ({
    path: `items/${alert.lineNo - 1}/overrides`,
    code: alert.family,
    message: `${alert.title}. Choose a coded override reason for "${alert.family}" to proceed.`,
  }));
  return new AppError(
    ProblemType.BUSINESS_RULE_VIOLATED,
    'One or more safety alerts need a coded reason before this prescription can be saved.',
    {
      errors,
      clinicalImpact: alerts.map((a) => a.title).join('; '),
      nextAction: 'Pick a reason from the coded list. Free text on its own is not accepted.',
    },
  );
}
