import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from '../consoles/consoles.events.js';
import {
  ConsoleSupport,
  asNumber,
  asNumberOrNull,
  asText,
  asTextOrNull,
} from '../consoles/consoles.support.js';
import type {
  ArtCycleRequest,
  ArtQuery,
  ArtUpdateRequest,
  BrainstemRequest,
  DonationConsentRequest,
  DonationRequest,
  DonorRequest,
  RecipientRequest,
  SecondExamRequest,
  TransplantQuery,
} from './transplant.schemas.js';
import type { ArtCycleRow, BrainstemRow, DonationRow, DonorRow, RecipientRow } from './transplant.types.js';

/** The Act's interval between the two brain-stem examinations. */
const BRAINSTEM_INTERVAL_MIN = 360;

/**
 * IP-019 and OP-024 — transplant and assisted reproduction.
 *
 * ── Nothing here decides an authority ──────────────────────────────────────
 *
 * Whether a donation has one, whether a panel is lawful, whether a donor has
 * already donated: all three are the database's, and all three are the point of
 * the statutes.
 *
 * ── What it does is say so early ───────────────────────────────────────────
 *
 * `blockedBy` and `minutesUntilSecondExam` matter more here than almost
 * anywhere, because an Authorisation Committee meets on a schedule and a workup
 * begun before it has met is weeks of somebody's dialysis wasted.
 */
@Injectable()
export class TransplantService extends ConsoleSupport {
  // ── The register ──────────────────────────────────────────────────────────

  async listRecipient(body: RecipientRequest): Promise<RecipientRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.transplant_recipients
           (id, hospital_id, branch_id, patient_id, organ, indication, blood_group, hla_typing,
            notto_id, listed_at, urgency, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::date,$11,$12,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.organ,
          body.indication,
          body.bloodGroup,
          JSON.stringify(body.hlaTyping),
          body.nottoId ?? null,
          body.listedAt,
          body.urgency,
          this.actorId(),
        ],
      );
      return this.recipientWithin(tx, id);
    });
  }

  async listRecipients(query: TransplantQuery): Promise<readonly RecipientRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${RECIPIENT_SELECT}
          WHERE r.hospital_id = $1
            AND ($2::text IS NULL OR r.organ = $2::text)
          ORDER BY r.urgency DESC, r.listed_at
          LIMIT $3`,
        [this.hospitalId(), query.organ ?? null, query.limit],
      );
      return rows.map((x) => this.toRecipient(x));
    });
  }

  /**
   * A donation, and the authority for it. The database decides whether there is
   * one; this records which route was taken.
   */
  async recordDonation(body: DonationRequest): Promise<DonationRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.organ_donations
           (id, hospital_id, branch_id, recipient_id, donor_patient_id, organ, donor_type,
            relationship, relationship_evidence, committee_ref, committee_decided_at,
            brainstem_death_id, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::specialty."DonorType",
                 $8::specialty."NearRelative",$9::jsonb,$10,$11::timestamptz,$12,$13,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.recipientId,
          body.donorPatientId ?? null,
          body.organ,
          body.donorType,
          body.relationship ?? null,
          JSON.stringify(body.relationshipEvidence),
          body.committeeRef ?? null,
          body.committeeDecidedAt ?? null,
          body.brainstemDeathId ?? null,
          this.actorId(),
        ],
      );
      const donation = await this.donationWithin(tx, id);

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'organ_donation',
        rowId: id,
        businessKey: body.organ,
        dataClass: 'phi',
        patientId: body.donorPatientId ?? null,
        encounterId: null,
        reasonText: body.reason,
        before: null,
        after: {
          donorType: body.donorType,
          relationship: body.relationship ?? null,
          committeeRef: body.committeeRef ?? null,
        },
      });

      // The Committee is not a hospital body, it meets on a schedule, and the
      // workup should not start before it has.
      if (body.donorType === 'living_other') {
        await this.outbox.publish(
          tx,
          consoleEvent('transplant.committee.required', id, {
            donationId: id,
            recipientId: body.recipientId,
            organ: body.organ,
            donorType: body.donorType,
          }),
        );
      }

      return donation;
    });
  }

  async updateDonation(id: string, body: DonationConsentRequest): Promise<DonationRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.organ_donations
            SET donor_consent_id     = coalesce($2::uuid, donor_consent_id),
                recipient_consent_id = coalesce($3::uuid, recipient_consent_id),
                crossmatch           = coalesce($4::jsonb, crossmatch),
                status               = coalesce($5::specialty."TransplantStatus", status),
                performed_at         = coalesce($6::timestamptz, performed_at),
                ot_case_id           = coalesce($7::uuid, ot_case_id),
                updated_at           = now()
          WHERE id = $1 AND hospital_id = $8`,
        [
          id,
          body.donorConsentId ?? null,
          body.recipientConsentId ?? null,
          body.crossmatch === undefined ? null : JSON.stringify(body.crossmatch),
          body.status ?? null,
          body.performedAt ?? null,
          body.otCaseId ?? null,
          this.hospitalId(),
        ],
      );
      return this.donationWithin(tx, id);
    });
  }

  async listDonations(query: TransplantQuery): Promise<readonly DonationRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${DONATION_SELECT}
          WHERE d.hospital_id = $1
            AND ($2::text IS NULL OR d.organ = $2::text)
            AND ($3::boolean IS NOT TRUE
                 OR (d.donor_type = 'living_other' AND d.committee_ref IS NULL))
          ORDER BY d.created_at DESC
          LIMIT $4`,
        [this.hospitalId(), query.organ ?? null, query.awaitingCommitteeOnly, query.limit],
      );
      return rows.map((x) => this.toDonation(x));
    });
  }

  // ── Brain-stem death ──────────────────────────────────────────────────────

  async recordFirstExam(body: BrainstemRequest): Promise<BrainstemRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.brainstem_death_certifications
           (id, hospital_id, branch_id, patient_id, admission_id, first_exam_at, first_exam,
            rmp_in_charge_id, authority_nominee_id, neurologist_id, treating_doctor_id,
            transplant_team_ids, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::jsonb,$8,$9,$10,$11,$12::uuid[],$13,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.admissionId ?? null,
          body.firstExamAt,
          JSON.stringify(body.firstExam),
          body.rmpInChargeId,
          body.authorityNomineeId,
          body.neurologistId,
          body.treatingDoctorId,
          body.transplantTeamIds,
          this.actorId(),
        ],
      );

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'brainstem_death_certification',
        rowId: id,
        businessKey: body.patientId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: null,
        reasonText: body.reason,
        before: null,
        after: { firstExamAt: body.firstExamAt },
      });

      return this.brainstemWithin(tx, id);
    });
  }

  async recordSecondExam(id: string, body: SecondExamRequest): Promise<BrainstemRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.brainstem_death_certifications
            SET second_exam_at = $2::timestamptz, second_exam = $3::jsonb,
                certified_at = CASE WHEN $4 THEN now() ELSE certified_at END,
                form10_ref = coalesce($5, form10_ref), updated_at = now()
          WHERE id = $1 AND hospital_id = $6`,
        [
          id,
          body.secondExamAt,
          JSON.stringify(body.secondExam),
          body.certify,
          body.form10Ref ?? null,
          this.hospitalId(),
        ],
      );
      const row = await this.brainstemWithin(tx, id);

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'brainstem_death_certification',
        rowId: id,
        businessKey: row.patientId,
        dataClass: 'phi',
        patientId: row.patientId,
        encounterId: null,
        reasonText: body.reason,
        before: null,
        after: { intervalMin: row.intervalMin, certifiedAt: row.certifiedAt },
      });

      // The coordinator, the family conversation and the registry all start
      // from this moment, and the organs have hours rather than days.
      if (row.certifiedAt !== null) {
        await this.outbox.publish(
          tx,
          consoleEvent('transplant.brainstem.certified', id, {
            certificationId: id,
            patientId: row.patientId,
            firstExamAt: row.firstExamAt,
            secondExamAt: row.secondExamAt ?? '',
            intervalMin: row.intervalMin ?? 0,
            form10Ref: row.form10Ref,
          }),
        );
      }

      return row;
    });
  }

  // ── Assisted reproduction ─────────────────────────────────────────────────

  async registerDonor(body: DonorRequest): Promise<DonorRow> {
    return this.guard(async (tx) => {
      // `donation_count` is absent: the Act allows one, and a count a clinic
      // could set is a limit a clinic could walk round.
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.art_gamete_donors
           (id, hospital_id, bank_registration_no, bank_donor_ref, gamete, age_years,
            screening, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now(),now())
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          body.bankRegistrationNo,
          body.bankDonorRef,
          body.gamete,
          body.ageYears,
          JSON.stringify(body.screening),
        ],
      );
      const donor = this.toDonor(this.one(rows));

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'art_gamete_donor',
        rowId: donor.id,
        businessKey: body.bankDonorRef,
        dataClass: 'phi',
        patientId: null,
        encounterId: null,
        reasonText: body.reason,
        before: null,
        after: { bank: body.bankRegistrationNo, gamete: body.gamete },
      });

      return donor;
    });
  }

  async listDonors(query: ArtQuery): Promise<readonly DonorRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.art_gamete_donors
          WHERE hospital_id = $1
            AND ($2::boolean IS NOT TRUE OR donation_count = 0)
          ORDER BY created_at DESC LIMIT $3`,
        [this.hospitalId(), query.availableDonorsOnly, query.limit],
      );
      return rows.map((x) => this.toDonor(x));
    });
  }

  async openCycle(body: ArtCycleRequest): Promise<ArtCycleRow> {
    return this.guard(async (tx) => {
      const id = newId();
      await tx.query(
        `INSERT INTO specialty.art_cycles
           (id, hospital_id, branch_id, patient_id, partner_patient_id, clinic_registration_no,
            cycle_no, started_at, technique, donor_id, stimulation, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11::jsonb,$12,now(),now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.partnerPatientId ?? null,
          body.clinicRegistrationNo,
          body.cycleNo,
          body.startedAt,
          body.technique,
          body.donorId ?? null,
          JSON.stringify(body.stimulation),
          this.actorId(),
        ],
      );
      return this.cycleWithin(tx, id);
    });
  }

  async updateCycle(id: string, body: ArtUpdateRequest): Promise<ArtCycleRow> {
    return this.guard(async (tx) => {
      await tx.query(
        `UPDATE specialty.art_cycles
            SET laboratory          = coalesce($2::jsonb, laboratory),
                patient_consent_id  = coalesce($3::uuid, patient_consent_id),
                partner_consent_id  = coalesce($4::uuid, partner_consent_id),
                embryos_transferred = coalesce($5, embryos_transferred),
                transferred_at      = coalesce($6::timestamptz, transferred_at),
                outcome             = coalesce($7, outcome),
                outcome_at          = CASE WHEN $7::text IS NULL THEN outcome_at ELSE now() END,
                registry_ref        = coalesce($8, registry_ref),
                updated_at          = now()
          WHERE id = $1 AND hospital_id = $9`,
        [
          id,
          body.laboratory === undefined ? null : JSON.stringify(body.laboratory),
          body.patientConsentId ?? null,
          body.partnerConsentId ?? null,
          body.embryosTransferred ?? null,
          body.transferredAt ?? null,
          body.outcome ?? null,
          body.registryRef ?? null,
          this.hospitalId(),
        ],
      );
      const cycle = await this.cycleWithin(tx, id);

      // The National ART Registry is the only source of outcome data anybody
      // has, and the Act requires the return.
      if (body.outcome !== undefined) {
        await this.outbox.publish(
          tx,
          consoleEvent('art.cycle.completed', id, {
            cycleId: id,
            patientId: cycle.patientId,
            technique: cycle.technique,
            embryosTransferred: cycle.embryosTransferred,
            outcome: body.outcome,
            donorUsed: cycle.donorId !== null,
          }),
        );
      }

      return cycle;
    });
  }

  async listCycles(query: ArtQuery): Promise<readonly ArtCycleRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.art_cycles
          WHERE hospital_id = $1
            AND ($2::uuid IS NULL OR patient_id = $2::uuid)
          ORDER BY started_at DESC LIMIT $3`,
        [this.hospitalId(), query.patientId ?? null, query.limit],
      );
      return rows.map((x) => this.toCycle(x));
    });
  }

  // ── Shaping ───────────────────────────────────────────────────────────────

  private one(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That record was not found.');
    return row;
  }

  private async recipientWithin(tx: TransactionClient, id: string): Promise<RecipientRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${RECIPIENT_SELECT} WHERE r.id = $1`, [id]);
    return this.toRecipient(this.one(rows));
  }

  private async donationWithin(tx: TransactionClient, id: string): Promise<DonationRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${DONATION_SELECT} WHERE d.id = $1`, [id]);
    return this.toDonation(this.one(rows));
  }

  private async brainstemWithin(tx: TransactionClient, id: string): Promise<BrainstemRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM specialty.brainstem_death_certifications WHERE id = $1`,
      [id],
    );
    return this.toBrainstem(this.one(rows));
  }

  private async cycleWithin(tx: TransactionClient, id: string): Promise<ArtCycleRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM specialty.art_cycles WHERE id = $1`,
      [id],
    );
    return this.toCycle(this.one(rows));
  }

  private toRecipient(r: Record<string, unknown>): RecipientRow {
    const listedAt = asText(r.listed_at);
    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      organ: asText(r.organ),
      indication: asText(r.indication),
      bloodGroup: asText(r.blood_group),
      nottoId: asTextOrNull(r.notto_id),
      listedAt,
      urgency: asText(r.urgency),
      status: asText(r.status),
      waitingDays: Math.max(Math.floor((Date.now() - new Date(listedAt).getTime()) / 86_400_000), 0),
      donationsRegistered: asNumber(r.donation_count),
      hasApprovedDonation: r.has_approved === true,
    };
  }

  private toDonation(r: Record<string, unknown>): DonationRow {
    const donorType = asText(r.donor_type);
    const committeeRef = asTextOrNull(r.committee_ref);
    const needsCommittee = donorType === 'living_other';

    // The Act, read forwards. An Authorisation Committee meets on a schedule,
    // and a workup begun before it has met is weeks of dialysis wasted.
    const blockedBy: string[] = [];
    if (needsCommittee && committeeRef === null) {
      blockedBy.push('the Authorisation Committee has not decided');
    }
    if (asTextOrNull(r.recipient_consent_id) === null) blockedBy.push('the recipient has not consented');
    if (
      (donorType === 'living_near_relative' || donorType === 'living_other') &&
      asTextOrNull(r.donor_consent_id) === null
    ) {
      blockedBy.push('the donor has not consented');
    }
    if (donorType === 'deceased_brainstem' && asTextOrNull(r.brainstem_certified_at) === null) {
      blockedBy.push('the brain-stem death is not certified');
    }

    return {
      id: asText(r.id),
      recipientId: asText(r.recipient_id),
      donorPatientId: asTextOrNull(r.donor_patient_id),
      organ: asText(r.organ),
      donorType,
      relationship: asTextOrNull(r.relationship),
      committeeRef,
      committeeDecidedAt: asTextOrNull(r.committee_decided_at),
      brainstemDeathId: asTextOrNull(r.brainstem_death_id),
      status: asText(r.status),
      performedAt: asTextOrNull(r.performed_at),
      blockedBy,
      needsCommittee,
    };
  }

  private toBrainstem(r: Record<string, unknown>): BrainstemRow & { readonly patientId: string } {
    const firstExamAt = asText(r.first_exam_at);
    const secondExamAt = asTextOrNull(r.second_exam_at);
    const certifiedAt = asTextOrNull(r.certified_at);

    // Minutes until the second examination may lawfully be done. The interval
    // *is* the test: a single examination cannot distinguish brain-stem death
    // from a reversible state.
    const minutesUntil =
      secondExamAt !== null
        ? null
        : Math.max(
            BRAINSTEM_INTERVAL_MIN - Math.floor((Date.now() - new Date(firstExamAt).getTime()) / 60_000),
            0,
          );

    const blockedBy: string[] = [];
    if (secondExamAt === null) {
      blockedBy.push(
        minutesUntil === 0
          ? 'the second examination is due'
          : `the second examination may be done in ${String(minutesUntil ?? 0)} minutes`,
      );
    } else if (certifiedAt === null) {
      blockedBy.push('the certification has not been signed');
    }

    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      firstExamAt,
      secondExamAt,
      intervalMin: asNumberOrNull(r.interval_min),
      certifiedAt,
      form10Ref: asTextOrNull(r.form10_ref),
      minutesUntilSecondExam: minutesUntil,
      blockedBy,
    };
  }

  private toDonor(r: Record<string, unknown>): DonorRow {
    const count = asNumber(r.donation_count);
    return {
      id: asText(r.id),
      bankRegistrationNo: asText(r.bank_registration_no),
      bankDonorRef: asText(r.bank_donor_ref),
      gamete: asText(r.gamete),
      ageYears: asNumber(r.age_years),
      donationCount: count,
      // The Act allows one.
      available: count === 0,
    };
  }

  private toCycle(r: Record<string, unknown>): ArtCycleRow {
    const partner = asTextOrNull(r.partner_patient_id);
    const blockedBy: string[] = [];
    if (asTextOrNull(r.transferred_at) === null) {
      if (asTextOrNull(r.patient_consent_id) === null) blockedBy.push('the patient has not consented');
      if (partner !== null && asTextOrNull(r.partner_consent_id) === null) {
        blockedBy.push('the partner has not consented');
      }
    }
    return {
      id: asText(r.id),
      patientId: asText(r.patient_id),
      partnerPatientId: partner,
      clinicRegistrationNo: asText(r.clinic_registration_no),
      cycleNo: asNumber(r.cycle_no),
      startedAt: asText(r.started_at),
      technique: asText(r.technique),
      donorId: asTextOrNull(r.donor_id),
      embryosTransferred: asNumberOrNull(r.embryos_transferred),
      transferredAt: asTextOrNull(r.transferred_at),
      outcome: asTextOrNull(r.outcome),
      registryRef: asTextOrNull(r.registry_ref),
      blockedBy,
    };
  }
}

const RECIPIENT_SELECT = `
  SELECT r.*,
         (SELECT count(*) FROM specialty.organ_donations d WHERE d.recipient_id = r.id) AS donation_count,
         EXISTS (SELECT 1 FROM specialty.organ_donations d
                  WHERE d.recipient_id = r.id AND d.status IN ('approved','scheduled','transplanted')) AS has_approved
    FROM specialty.transplant_recipients r`;

const DONATION_SELECT = `
  SELECT d.*, b.certified_at AS brainstem_certified_at
    FROM specialty.organ_donations d
    LEFT JOIN specialty.brainstem_death_certifications b ON b.id = d.brainstem_death_id`;
