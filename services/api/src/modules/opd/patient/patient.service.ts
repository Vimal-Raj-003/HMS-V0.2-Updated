import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page, type ProblemFieldError } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { PolicyService } from '../../../core/policy/policy.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { PatientDedupeService, type DuplicateCandidate } from './patient.dedupe.service.js';
import { patientEvent } from './patient.events.js';
import {
  abhaNumberVariants,
  blocksRegistration,
  composeFullName,
  dedupeFingerprint,
  isE164,
  normaliseAbhaAddress,
  normaliseIdentifierValue,
  normaliseMobile,
  normaliseUhid,
  resolveBirth,
} from './patient.identity.js';
import type { HistoryQuery, RegisterPatientRequest, UpdatePatientRequest } from './patient.schemas.js';
import type {
  DemographicHistoryItem,
  PatientAlertRow,
  PatientAllergyRow,
  PatientContactRow,
  PatientDetail,
  PatientIdentifierRow,
} from './patient.types.js';

/**
 * OP-001 §3.1–§3.2 — registration and the demographic record.
 *
 * Five properties here are load-bearing, and each one is why a piece of this
 * file is longer than its CRUD surface suggests.
 *
 * **The duplicate hard-stop is defeatable only deliberately.** OP-001 §5 sets
 * the threshold at 0.85 and §14 AC-2 requires the save to be refused above it.
 * Passing it needs a *second* permission (`patient.record.create_override`,
 * flagged `sensitiveGrant` and `requiresReason` in the catalogue), an explicit
 * acknowledgement of the exact records that were shown, and a reason that is
 * written onto the new patient row and into the audit register. A caller who
 * merely retries the same request gets the same refusal.
 *
 * **No query carries a `hospital_id` predicate.** Isolation is row-level
 * security acting on the scope stamped by `withTenant`. That is why a
 * cross-tenant id reads as "not found" rather than "forbidden": `docs/09` §3.1
 * case 2 forbids the API from confirming another hospital's record exists.
 *
 * **Every mutation writes exactly one audit row and its outbox event inside the
 * same transaction** as the change (`EN-024` §5, `docs/01` §3 step 8). A patient
 * cannot be registered without `patient.registered` being announced, because
 * OP-005 opens the account and EN-009 sends the UHID off the back of it.
 *
 * **Nothing is deleted.** The migration revokes DELETE on every table in the
 * `patient` schema. There is no delete route.
 *
 * **There is no Aadhaar field, in any form.** See `register`.
 */

const RESOURCE = 'opd.patients';

/**
 * The columns a `PATCH` may move, and how each is derived from the request.
 *
 * A table rather than thirty `if` statements, because the audit diff, the
 * `patient.demographic_history` row and the `SET` clause must all agree on
 * exactly which fields changed — and three hand-written lists drift.
 */
const DEMOGRAPHIC_COLUMNS = [
  'title_code',
  'first_name',
  'middle_name',
  'last_name',
  'local_name',
  'gender',
  'dob',
  'blood_group',
  'marital_status',
  'mobile',
  'alt_phone',
  'email',
  'whatsapp_opt_in',
  'preferred_language',
  'religion_code',
  'occupation_code',
  'address_line1',
  'address_line2',
  'city',
  'district',
  'state',
  'country_code',
  'pincode',
  'category',
  'payer_type',
  'payer_ref',
  'is_vip',
  'is_differently_abled',
  'is_pregnant',
] as const;

type DemographicColumn = (typeof DEMOGRAPHIC_COLUMNS)[number];

/** The subset whose change re-derives `full_name` and `dedupe_fingerprint`. */
const IDENTITY_COLUMNS: readonly DemographicColumn[] = [
  'first_name',
  'middle_name',
  'last_name',
  'gender',
  'dob',
  'mobile',
];

interface PatientRow {
  readonly id: string;
  readonly uhid: string;
  readonly version: number;
  readonly status: string;
  readonly first_name: string;
  readonly middle_name: string | null;
  readonly last_name: string | null;
  readonly gender: string;
  readonly dob_text: string | null;
  readonly mobile: string;
  readonly mobile_local: string;
}

@Injectable()
export class PatientService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(PatientDedupeService) private readonly dedupe: PatientDedupeService,
  ) {}

  // ── register ──────────────────────────────────────────────────────────────

  /**
   * OP-001 §3.1 — register a walk-in and issue a UHID.
   *
   * **On Aadhaar.** OP-001 §5 permits storing "only hash + last 4", and the
   * schema enforces that with `patients_aadhaar_last4_shape`: the last four
   * cannot exist without the hash. The hash is defined as SHA-256 over a
   * *per-hospital pepper* whose version is recorded in
   * `aadhaar_hash_key_version`, and that key does not exist yet — there is no
   * KMS binding, no rotation path, and no environment contract for it. An
   * unpeppered SHA-256 of a twelve-digit number is exhaustively invertible in
   * seconds, so computing one here would not be "storing a hash", it would be
   * storing Aadhaar with an extra step. This endpoint therefore accepts no
   * Aadhaar in any form; the e-KYC path that legitimately produces one is
   * EN-011's, through a licensed AUA/KUA, and is not in this module.
   *
   * The duplicate rule that keys on the digest is implemented and unit-tested
   * regardless, so wiring it later is a parameter, not a re-derivation.
   */
  async register(body: RegisterPatientRequest): Promise<PatientDetail> {
    const ctx = getContext();

    const branchId = body.branchId ?? ctx.branchId;
    if (branchId === null) {
      throw AppError.conflict(
        'This session is not acting in a branch, and a patient is registered at one. Choose a branch and try again.',
      );
    }

    // The second authority, asserted **before** the transaction opens: the
    // policy engine reads roles from the database, and calling it from inside an
    // open transaction would hold that transaction across a second connection's
    // round trip for no reason. It also means a caller who cannot override is
    // refused before any duplicate work is done.
    if (body.overrideDuplicate !== undefined) {
      await this.policy.assert('patient.record.create_override');
    }

    const mobile = normaliseMobile(body.mobile);
    if (!isE164(mobile.e164)) {
      throw AppError.validation([
        {
          path: 'mobile',
          code: 'invalid_mobile',
          message: 'That is not a usable phone number. Include the area/country code.',
        },
      ]);
    }

    const birth = resolveBirth(body.dob, body, new Date());
    if (birth.dob === null) {
      throw AppError.validation([
        { path: 'dob', code: 'age_basis_missing', message: 'Give a date of birth or an age.' },
      ]);
    }

    assertGuardianForMinor(body, birth);

    const fullName = composeFullName(body);
    const fingerprint = dedupeFingerprint({
      mobileLocal: mobile.local,
      dob: birth.dob,
      firstName: body.firstName,
      lastName: body.lastName,
      gender: body.gender,
    });

    const abhaAddress = body.abhaAddress === undefined ? null : normaliseAbhaAddress(body.abhaAddress);
    const abhaVariants = body.abhaNumber === undefined ? [] : abhaNumberVariants(body.abhaNumber);
    const id = newId();

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const candidates = await this.dedupe.findCandidates(tx, {
        fullName,
        gender: body.gender,
        dob: birth.dob,
        mobileE164: mobile.e164,
        fingerprint,
        abhaNumberVariants: abhaVariants,
        abhaAddress,
        aadhaarHash: null,
        excludePatientId: null,
      });

      const blocking = candidates.filter((c) => blocksRegistration(c.score));
      let overrideReason: string | null = null;

      if (blocking.length > 0) {
        const override = body.overrideDuplicate;
        if (override === undefined) throw duplicateHardStop(blocking);

        // The override acknowledges *specific* records. If a candidate the
        // caller never saw has appeared since — another counter registered the
        // same person a second ago — the save is refused again with the new one
        // named, rather than waved through on a stale acknowledgement.
        const acknowledged = new Set(override.acknowledgedPatientIds);
        const unseen = blocking.filter((c) => !acknowledged.has(c.patientId));
        if (unseen.length > 0) throw duplicateHardStop(unseen);

        overrideReason = override.reason;
      }

      const allocation = await this.numbering.allocate(tx, {
        key: 'UHID',
        branchId,
        refType: 'patient.patients',
        refId: id,
      });

      await this.insertPatient(tx, {
        id,
        branchId,
        uhid: allocation.formatted,
        body,
        fullName,
        mobile,
        birth,
        fingerprint,
        abhaAddress,
        overrideReason,
      });

      for (const identifier of body.identifiers) {
        await this.insertIdentifier(tx, id, identifier);
      }
      // OP-001 §4: the ABHA on the patient row is a denormalisation for the
      // search path; `patient.identifiers` remains the record of truth, so the
      // identifier row is written too rather than only the fast copy.
      if (body.abhaNumber !== undefined) {
        await this.insertIdentifier(tx, id, {
          type: 'abha_number',
          value: body.abhaNumber,
          isPrimary: false,
        });
      }
      if (body.abhaAddress !== undefined) {
        await this.insertIdentifier(tx, id, {
          type: 'abha_address',
          value: body.abhaAddress,
          isPrimary: false,
        });
      }

      for (const contact of body.contacts) {
        await tx.query(
          `INSERT INTO patient.contacts
             (id, hospital_id, patient_id, kind, name, relationship_code, phone,
              is_primary, is_guardian, created_by, updated_at)
           VALUES ($1, $2, $3, $4::patient."PatientContactKind", $5, $6, $7, $8, $9, $10, now())`,
          [
            newId(),
            ctx.hospitalId,
            id,
            contact.kind,
            contact.name,
            contact.relationshipCode ?? null,
            normaliseMobile(contact.phone).e164,
            contact.isPrimary,
            contact.isGuardian,
            ctx.userId,
          ],
        );
      }

      // Every scored pair is filed for MRD review, not only the blocking ones:
      // a 0.85 that was overridden and a 0.85 that was not are the same question
      // for the officer, and the queue is where it gets answered.
      for (const candidate of candidates) {
        await this.dedupe.recordCandidate(tx, id, candidate, 'create_time');
      }

      await this.audit.write(tx, {
        // An override is not an ordinary insert. `override` is one of the four
        // reason-mandatory actions in EN-024 §5, and recording it as `insert`
        // would hide the override from the register that exists to find them.
        action: overrideReason === null ? 'insert' : 'override',
        entity: 'patient.patients',
        rowId: id,
        businessKey: allocation.formatted,
        dataClass: 'phi',
        patientId: id,
        before: null,
        after: {
          uhid: allocation.formatted,
          branch_id: branchId,
          gender: body.gender,
          category: body.category,
          source_channel: body.sourceChannel,
          allergy_statement: body.allergy?.statement ?? 'not_recorded',
          duplicate_candidates: candidates.length,
          overridden_patient_ids: blocking.map((c) => c.patientId),
        },
        reasonText: overrideReason,
        sensitivity: body.isVip ? 'vip' : 'normal',
      });

      await this.outbox.publish(
        tx,
        patientEvent('patient.registered', id, {
          patientId: id,
          uhid: allocation.formatted,
          branchId,
          channel: body.sourceChannel,
          registeredAt: new Date().toISOString(),
        }),
      );
    });

    return this.get(id);
  }

  private async insertPatient(
    tx: TransactionClient,
    input: {
      readonly id: string;
      readonly branchId: string;
      readonly uhid: string;
      readonly body: RegisterPatientRequest;
      readonly fullName: string;
      readonly mobile: { readonly e164: string; readonly local: string };
      readonly birth: ReturnType<typeof resolveBirth>;
      readonly fingerprint: string;
      readonly abhaAddress: string | null;
      readonly overrideReason: string | null;
    },
  ): Promise<void> {
    const ctx = getContext();
    const { body } = input;
    const address = body.address;

    // The four-arm allergy statement (`docs/06` §10). Every arm other than
    // `not_recorded` is an assertion somebody is accountable for, so the acting
    // user and the instant are stamped here — the CHECK
    // `patients_allergy_assertion_attributed` refuses the row otherwise, and
    // that is the point: `none_known` can never be written by nobody.
    const statement = body.allergy?.statement ?? 'not_recorded';
    const asserted = statement !== 'not_recorded';

    await tx.query(
      `INSERT INTO patient.patients (
         id, hospital_id, branch_id, uhid, uhid_normalised,
         title_code, first_name, middle_name, last_name, full_name, local_name,
         gender, dob, dob_is_estimated, age_years, age_months, age_days,
         blood_group, marital_status,
         allergy_statement, allergy_asserted_by, allergy_asserted_at, allergy_unable_reason,
         mobile, mobile_local, alt_phone, email, whatsapp_opt_in,
         preferred_language, nationality_code, religion_code, occupation_code,
         id_type_code, id_last4,
         abha_number, abha_address, abha_linked_at,
         address_line1, address_line2, city, district, state, country_code, pincode,
         category, payer_type, payer_ref,
         referral_source_code, referred_by_text,
         is_vip, is_differently_abled, is_pregnant,
         status, dedupe_fingerprint, created_override_reason, source_channel,
         registered_at, created_by, updated_by, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10, $11,
         $12::patient."PatientGender", $13::date, $14, $15, $16, $17,
         $18::patient."PatientBloodGroup", $19,
         $20::patient."PatientAllergyStatement", $21, $22, $23,
         $24, $25, $26, $27, $28,
         $29, $30, $31, $32,
         $33, $34,
         $35, $36, $37,
         $38, $39, $40, $41, $42, $43, $44,
         $45::patient."PatientCategory", $46::patient."PatientPayerType", $47,
         $48, $49,
         $50, $51, $52,
         'active', $53, $54, $55,
         now(), $56, $56, now()
       )`,
      [
        input.id,
        ctx.hospitalId,
        input.branchId,
        input.uhid,
        normaliseUhid(input.uhid),
        body.titleCode ?? null,
        body.firstName,
        body.middleName ?? null,
        body.lastName ?? null,
        input.fullName,
        body.localName ?? null,
        body.gender,
        input.birth.dob,
        input.birth.dobIsEstimated,
        input.birth.ageYears,
        input.birth.ageMonths,
        input.birth.ageDays,
        body.bloodGroup,
        body.maritalStatus ?? null,
        statement,
        asserted ? ctx.userId : null,
        asserted ? new Date() : null,
        body.allergy?.unableReason ?? null,
        input.mobile.e164,
        input.mobile.local,
        body.altPhone === undefined ? null : normaliseMobile(body.altPhone).e164,
        body.email ?? null,
        body.whatsappOptIn,
        body.preferredLanguage,
        body.nationalityCode,
        body.religionCode ?? null,
        body.occupationCode ?? null,
        body.idTypeCode ?? null,
        body.idLast4 ?? null,
        body.abhaNumber ?? null,
        input.abhaAddress,
        body.abhaNumber === undefined && input.abhaAddress === null ? null : new Date(),
        address?.line1 ?? null,
        address?.line2 ?? null,
        address?.city ?? null,
        address?.district ?? null,
        address?.state ?? null,
        address?.countryCode ?? 'IN',
        address?.pincode ?? null,
        body.category,
        body.payerType,
        body.payerRef ?? null,
        body.referralSourceCode ?? null,
        body.referredByText ?? null,
        body.isVip,
        body.isDifferentlyAbled,
        body.isPregnant,
        input.fingerprint,
        input.overrideReason,
        body.sourceChannel,
        ctx.userId,
      ],
    );
  }

  private async insertIdentifier(
    tx: TransactionClient,
    patientId: string,
    identifier: {
      readonly type: string;
      readonly value: string;
      readonly idTypeCode?: string | undefined;
      readonly issuedBy?: string | undefined;
      readonly isPrimary: boolean;
    },
  ): Promise<void> {
    const ctx = getContext();
    const normalised = normaliseIdentifierValue(identifier.value);
    // Masked at the point of storage, so nothing downstream has to remember to
    // mask it. `value_encrypted` stays null: encryption is a KMS-backed
    // capability this platform does not have yet, and writing the number in the
    // clear into a column named "encrypted" would be worse than not storing it.
    const masked =
      normalised.length <= 4
        ? normalised
        : `${'•'.repeat(Math.min(8, normalised.length - 4))}${normalised.slice(-4)}`;

    try {
      await tx.query(
        `INSERT INTO patient.identifiers
           (id, hospital_id, patient_id, type, id_type_code, value_normalised, value_masked,
            issued_by, source, is_primary, created_by, updated_at)
         VALUES ($1, $2, $3, $4::patient."PatientIdentifierType", $5, $6, $7, $8, 'desk', $9, $10, now())`,
        [
          newId(),
          ctx.hospitalId,
          patientId,
          identifier.type,
          identifier.idTypeCode ?? null,
          normalised,
          masked,
          identifier.issuedBy ?? null,
          identifier.isPrimary,
          ctx.userId,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw AppError.conflict(
          `That ${identifier.type.replace(/_/g, ' ')} is already recorded against another patient.`,
        );
      }
      throw error;
    }
  }

  // ── read ──────────────────────────────────────────────────────────────────

  /**
   * The full record plus the safety banner (OP-001 §6, `docs/06` §PatientBanner).
   *
   * A PHI read, and `docs/04` §Security makes it auditable: the row records who
   * opened which patient, and the Privacy Officer's daily review reads exactly
   * this. The audit is written inside the same transaction as the read, so a
   * read that succeeds without being recorded is not reachable.
   */
  async get(id: string): Promise<PatientDetail> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const patient = await tx.maybeOne<
        Omit<PatientDetail, 'identifiers' | 'contacts' | 'banner'> & { readonly age_display: string }
      >(
        `SELECT p.id, p.uhid, p.mpi_group_id, p.branch_id,
                p.title_code, p.first_name, p.middle_name, p.last_name, p.full_name, p.local_name,
                p.gender::text AS gender, p.dob, p.dob_is_estimated,
                p.age_years, p.age_months, p.age_days,
                p.blood_group::text AS blood_group, p.marital_status,
                p.allergy_statement::text AS allergy_statement, p.allergy_asserted_by,
                p.allergy_asserted_at, p.allergy_unable_reason,
                p.mobile, p.mobile_verified_at, p.alt_phone, p.email, p.whatsapp_opt_in,
                p.preferred_language, p.nationality_code, p.religion_code, p.occupation_code,
                p.id_type_code, p.id_last4, p.aadhaar_last4, p.aadhaar_kyc_verified_at,
                p.abha_number, p.abha_address, p.abha_linked_at, p.photo_file_id,
                p.address_line1, p.address_line2, p.city, p.district, p.state,
                p.country_code, p.pincode,
                p.category::text AS category, p.payer_type::text AS payer_type, p.payer_ref,
                p.referral_source_code, p.referred_by_text,
                p.is_vip, p.is_staff, p.is_differently_abled, p.is_pregnant,
                p.is_deceased, p.deceased_at,
                p.status::text AS status, p.merged_into_id, p.merged_at,
                p.source_channel, p.created_override_reason,
                p.last_visit_at, p.registered_at, p.created_at, p.version,
                CASE
                  WHEN p.age_years IS NOT NULL THEN p.age_years || ' y'
                  WHEN p.age_months IS NOT NULL THEN p.age_months || ' m'
                  WHEN p.age_days IS NOT NULL THEN p.age_days || ' d'
                  WHEN p.dob IS NOT NULL
                    THEN EXTRACT(YEAR FROM age(p.dob))::int || ' y'
                  ELSE '—'
                END AS age_display
           FROM patient.patients p
          WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [id],
      );

      // Another hospital's patient was filtered out by row-level security, so it
      // arrives here as absent and leaves as a 404 — never a 403, which would
      // confirm the record exists (docs/09 §3.1 case 2).
      if (patient === undefined) throw AppError.notFound('The patient');

      const identifiers = await tx.rows<PatientIdentifierRow>(
        `SELECT id, type::text AS type, id_type_code, value_masked, issued_by,
                verified_at, source, is_primary
           FROM patient.identifiers
          WHERE patient_id = $1 AND deleted_at IS NULL
          ORDER BY is_primary DESC, type`,
        [id],
      );

      const contacts = await tx.rows<PatientContactRow>(
        `SELECT id, kind::text AS kind, name, relationship_code, phone, is_guardian, is_primary
           FROM patient.contacts
          WHERE patient_id = $1 AND deleted_at IS NULL
          ORDER BY is_primary DESC, kind`,
        [id],
      );

      const alerts = await tx.rows<PatientAlertRow>(
        `SELECT id, type::text AS type, severity::text AS severity, label, detail, acknowledged_at
           FROM patient.alerts
          WHERE patient_id = $1 AND is_active
            AND (active_to IS NULL OR active_to > now())
          ORDER BY severity DESC, created_at DESC`,
        [id],
      );

      const allergies = await tx.rows<PatientAllergyRow>(
        `SELECT id, category::text AS category, substance_text,
                criticality::text AS criticality, severity::text AS severity, status::text AS status
           FROM patient.allergies
          WHERE patient_id = $1 AND status = 'active'
          ORDER BY criticality DESC, substance_text`,
        [id],
      );

      await this.audit.write(tx, {
        action: 'read_phi',
        entity: 'patient.patients',
        rowId: id,
        businessKey: patient.uhid,
        dataClass: 'phi',
        patientId: id,
        before: null,
        after: null,
        rowCount: 1,
        sensitivity: patient.is_vip ? 'vip' : 'normal',
      });

      const { age_display: ageDisplay, ...rest } = patient;

      return {
        ...rest,
        identifiers,
        contacts,
        banner: {
          uhid: patient.uhid,
          full_name: patient.full_name,
          gender: patient.gender,
          age_display: ageDisplay,
          blood_group: patient.blood_group,
          photo_file_id: patient.photo_file_id,
          allergy_statement: patient.allergy_statement,
          allergy_asserted_at: patient.allergy_asserted_at,
          allergy_unable_reason: patient.allergy_unable_reason,
          allergies,
          alerts,
          is_vip: patient.is_vip,
          is_deceased: patient.is_deceased,
          status: patient.status,
          merged_into_id: patient.merged_into_id,
        },
      };
    });
  }

  // ── update ────────────────────────────────────────────────────────────────

  /**
   * OP-001 §3.2.2 / §14 AC-14 — a versioned demographic change.
   *
   * Three things happen together or not at all: the row moves, a
   * `patient.demographic_history` row records before/after with the reason and
   * the actor, and one audit row is chained to it by id. The history table has
   * UPDATE and DELETE revoked from `hms_app`, so what is written there is what
   * an enquiry will read years later.
   */
  async update(id: string, body: UpdatePatientRequest): Promise<PatientDetail> {
    const ctx = getContext();

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      // `FOR UPDATE`, not an optimistic read: two receptionists editing the same
      // patient must serialise here, or the second overwrites the first's
      // `full_name` recomputation with a stale first name.
      const before = await tx.maybeOne<PatientRow & Record<string, unknown>>(
        `SELECT p.id, p.uhid, p.version, p.status::text AS status,
                p.title_code, p.first_name, p.middle_name, p.last_name, p.local_name,
                p.gender::text AS gender, p.dob::text AS dob_text,
                p.blood_group::text AS blood_group, p.marital_status,
                p.mobile, p.mobile_local, p.alt_phone, p.email, p.whatsapp_opt_in,
                p.preferred_language, p.religion_code, p.occupation_code,
                p.address_line1, p.address_line2, p.city, p.district, p.state,
                p.country_code, p.pincode,
                p.category::text AS category, p.payer_type::text AS payer_type, p.payer_ref,
                p.is_vip, p.is_differently_abled, p.is_pregnant
           FROM patient.patients p
          WHERE p.id = $1 AND p.deleted_at IS NULL
          FOR UPDATE`,
        [id],
      );
      if (before === undefined) throw AppError.notFound('The patient');

      if (before.version !== body.version) {
        throw new AppError(
          ProblemType.OPTIMISTIC_LOCK_CONFLICT,
          'This patient was changed by somebody else while you were editing.',
          { nextAction: 'Reload the patient and reapply your change.' },
        );
      }
      if (before.status === 'merged') {
        throw AppError.conflict(
          'This record was merged into another one. Edit the surviving record instead.',
        );
      }

      const proposed = proposedColumns(body);
      const beforeValues: Record<string, unknown> = {};
      const afterValues: Record<string, unknown> = {};
      const changed: DemographicColumn[] = [];

      for (const column of DEMOGRAPHIC_COLUMNS) {
        if (!(column in proposed)) continue;
        const next = proposed[column];
        const current = column === 'dob' ? before.dob_text : before[column];
        if (Object.is(normaliseForDiff(current), normaliseForDiff(next))) continue;
        changed.push(column);
        beforeValues[column] = normaliseForDiff(current);
        afterValues[column] = normaliseForDiff(next);
      }

      if (changed.length === 0) {
        throw AppError.conflict('Nothing in this request changes the record.');
      }

      // Derived columns follow their sources rather than being settable: a
      // `full_name` that disagreed with its parts, or a fingerprint that
      // disagreed with the name, would silently switch duplicate detection off
      // for that patient.
      const identityChanged = changed.some((c) => IDENTITY_COLUMNS.includes(c));
      const derived: Record<string, unknown> = {};
      if (identityChanged) {
        const firstName = (afterValues['first_name'] ?? before.first_name) as string;
        const middleName = (afterValues['middle_name'] ?? before.middle_name) as string | null;
        const lastName = (afterValues['last_name'] ?? before.last_name) as string | null;
        const gender = (afterValues['gender'] ?? before.gender) as string;
        const dob = (afterValues['dob'] ?? before.dob_text) as string | null;
        const mobileE164 = (afterValues['mobile'] ?? before.mobile) as string;
        const mobileLocal =
          afterValues['mobile'] === undefined ? before.mobile_local : normaliseMobile(mobileE164).local;

        derived['full_name'] = composeFullName({ firstName, middleName, lastName });
        derived['mobile_local'] = mobileLocal;
        derived['dedupe_fingerprint'] = dedupeFingerprint({
          mobileLocal,
          dob,
          firstName,
          lastName,
          gender,
        });
        if (changed.includes('dob')) derived['dob_is_estimated'] = false;
      }

      const setValues: unknown[] = [id];
      const bind = (value: unknown): string => `$${setValues.push(value)}`;
      const assignments: string[] = [];
      for (const column of changed) {
        assignments.push(`${column} = ${bind(afterValues[column])}${castFor(column)}`);
      }
      for (const [column, value] of Object.entries(derived)) {
        assignments.push(`${column} = ${bind(value)}`);
      }
      assignments.push(`version = version + 1`, `updated_by = ${bind(ctx.userId)}`, `updated_at = now()`);

      await tx.query(`UPDATE patient.patients SET ${assignments.join(', ')} WHERE id = $1`, setValues);

      const auditId = await this.audit.write(tx, {
        action: 'update',
        entity: 'patient.patients',
        rowId: id,
        businessKey: before.uhid,
        dataClass: 'phi',
        patientId: id,
        // Changed columns only (EN-024 §3.1.3): an unchanged field in a diff is
        // noise an investigator has to read past.
        before: beforeValues,
        after: afterValues,
        reasonText: body.reason,
      });

      await tx.query(
        `INSERT INTO patient.demographic_history
           (id, hospital_id, patient_id, changed_fields, before, after, reason, channel,
            changed_by, audit_id)
         VALUES ($1, $2, $3, $4::text[], $5::jsonb, $6::jsonb, $7, $8, $9, $10)`,
        [
          newId(),
          ctx.hospitalId,
          id,
          changed,
          JSON.stringify(beforeValues),
          JSON.stringify(afterValues),
          body.reason,
          body.channel,
          ctx.userId,
          auditId,
        ],
      );

      await this.outbox.publish(
        tx,
        patientEvent('patient.updated', id, {
          patientId: id,
          changedFields: changed,
          reason: body.reason,
        }),
      );
    });

    return this.get(id);
  }

  // ── demographic history ───────────────────────────────────────────────────

  async history(id: string, query: HistoryQuery): Promise<Page<DemographicHistoryItem>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const resource = `${RESOURCE}.history`;
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const patient = await tx.maybeOne<{ uhid: string }>(
        `SELECT uhid FROM patient.patients WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (patient === undefined) throw AppError.notFound('The patient');

      const values: unknown[] = [id];
      const bind = (value: unknown): string => `$${values.push(value)}`;
      const keyset =
        after === null
          ? ''
          : `AND (h.changed_at, h.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`;

      const fetched = await tx.rows<DemographicHistoryItem & { cursor_key: string }>(
        `SELECT h.id, h.changed_fields, h.before, h.after, h.reason, h.channel,
                h.changed_by, h.changed_at, h.audit_id, h.changed_at::text AS cursor_key
           FROM patient.demographic_history h
          WHERE h.patient_id = $1 ${keyset}
          ORDER BY h.changed_at DESC, h.id DESC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      const page = this.cursors.keysetPage<DemographicHistoryItem>(fetched, limit, {
        hospitalId,
        resource,
        direction: 'desc',
      });

      await this.audit.write(tx, {
        action: 'read_phi',
        entity: 'patient.demographic_history',
        rowId: id,
        businessKey: patient.uhid,
        dataClass: 'phi',
        patientId: id,
        before: null,
        after: null,
        rowCount: page.items.length,
      });

      return page;
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OP-001 §3.1: "duplicate suspected with score ≥ 0.85 → hard-stop requiring
 * 'Create anyway (reason)'".
 *
 * A 422, not a 409: the request was well-formed and the caller is entitled to
 * make it — the refusal is a clinical judgement about the *content*, which is
 * exactly what `clinical-hard-stop` means. The candidates travel as RFC 9457
 * field errors because that is the only structured channel the problem document
 * has, and the desk needs to see which records it is being warned about in order
 * to choose one or override.
 */
function duplicateHardStop(candidates: readonly DuplicateCandidate[]): AppError {
  const errors: ProblemFieldError[] = candidates.map((candidate, index) => ({
    path: `overrideDuplicate/acknowledgedPatientIds/${index}`,
    code: 'duplicate_suspected',
    message:
      `${candidate.uhid} — ${candidate.fullName}, ${candidate.gender}` +
      `${candidate.ageYears === null ? '' : `, ${candidate.ageYears}`} ` +
      `(id ${candidate.patientId}, score ${candidate.score.toFixed(2)}, ${candidate.ruleHits.join(', ')})`,
  }));

  return new AppError(
    ProblemType.CLINICAL_HARD_STOP,
    'This looks like a patient who is already registered. Registering them twice splits their clinical record.',
    {
      errors,
      clinicalImpact:
        'A second record means allergies, results and prescriptions are recorded against a patient nobody is looking at.',
      nextAction:
        'Open the existing record and register the visit against it. If they really are different people, re-send with overrideDuplicate.acknowledgedPatientIds and a reason — that needs the patient.record.create_override permission.',
    },
  );
}

/**
 * OP-001 §14 AC-12 and the DPDP Rules 2025: "Given a minor (age < 18)
 * registration, then a guardian contact and guardian consent are mandatory
 * before save."
 *
 * Half of that is enforceable here and is: a contact marked `isGuardian`. The
 * other half — *verifiable* parental consent, with its own artefact and its own
 * withdrawal path — is EN-028's `patient.consents` and is not wired to this
 * route, so it is not claimed. Refusing the save for want of the contact is
 * still the right call: a child registered with no responsible adult on the
 * record is one nobody can be reached about.
 */
export function assertGuardianForMinor(
  body: RegisterPatientRequest,
  birth: ReturnType<typeof resolveBirth>,
): void {
  const years = ageInYears(birth);
  if (years === null || years >= 18) return;
  if (body.contacts.some((contact) => contact.isGuardian)) return;

  throw AppError.validation([
    {
      path: 'contacts',
      code: 'guardian_required',
      message: 'A patient under 18 needs a guardian on the record. Add a contact marked as the guardian.',
    },
  ]);
}

/**
 * Age in whole years.
 *
 * A real date of birth wins over a stated age whenever both are present, and
 * only a *real* one — `dob_is_estimated` means the date was reconstructed from
 * the age, so deriving the age back from it would be circular. Where a patient
 * says "about forty" and a card says 1988, the card is the better evidence for a
 * rule that decides whether somebody is a minor.
 */
export function ageInYears(birth: ReturnType<typeof resolveBirth>): number | null {
  if (birth.dob !== null && !birth.dobIsEstimated) {
    const born = Date.parse(`${birth.dob}T00:00:00Z`);
    if (!Number.isNaN(born)) return Math.floor((Date.now() - born) / (365.2425 * 86_400_000));
  }
  if (birth.ageYears !== null) return birth.ageYears;
  if (birth.ageMonths !== null) return Math.floor(birth.ageMonths / 12);
  if (birth.ageDays !== null) return Math.floor(birth.ageDays / 365);
  return null;
}

/** `pg` reports a unique violation as `23505`; everything else is ours. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

/**
 * `undefined` means "not mentioned", `null` means "clear it". Diffing has to
 * treat a database NULL and an explicit null as the same value, and a `Date`
 * (which `pg` returns for `date` columns) as its ISO day.
 */
function normaliseForDiff(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

/**
 * Enum and date columns need their type back, because PostgreSQL will not cast a
 * bare text parameter into a user-defined enum.
 *
 * A lookup table rather than a `switch`, so adding a column to
 * `DEMOGRAPHIC_COLUMNS` without a cast is silently correct (most columns need
 * none) instead of tripping an exhaustiveness rule that would push a developer
 * towards a `default` branch that hides the real ones.
 */
const COLUMN_CASTS: Partial<Record<DemographicColumn, string>> = {
  gender: '::patient."PatientGender"',
  blood_group: '::patient."PatientBloodGroup"',
  category: '::patient."PatientCategory"',
  payer_type: '::patient."PatientPayerType"',
  dob: '::date',
};

function castFor(column: DemographicColumn): string {
  return COLUMN_CASTS[column] ?? '';
}

/**
 * Flattens the request into the column names the table uses.
 *
 * Only keys the caller actually sent appear, so "not mentioned" and "set to
 * null" stay distinguishable all the way to the diff.
 */
function proposedColumns(body: UpdatePatientRequest): Partial<Record<DemographicColumn, unknown>> {
  const out: Partial<Record<DemographicColumn, unknown>> = {};
  const put = (column: DemographicColumn, value: unknown): void => {
    if (value !== undefined) out[column] = value;
  };

  put('title_code', body.titleCode);
  put('first_name', body.firstName);
  put('middle_name', body.middleName);
  put('last_name', body.lastName);
  put('local_name', body.localName);
  put('gender', body.gender);
  put('dob', body.dob);
  put('blood_group', body.bloodGroup);
  put('marital_status', body.maritalStatus);
  if (body.mobile !== undefined) out['mobile'] = normaliseMobile(body.mobile).e164;
  if (body.altPhone !== undefined) {
    out['alt_phone'] = body.altPhone === null ? null : normaliseMobile(body.altPhone).e164;
  }
  put('email', body.email);
  put('whatsapp_opt_in', body.whatsappOptIn);
  put('preferred_language', body.preferredLanguage);
  put('religion_code', body.religionCode);
  put('occupation_code', body.occupationCode);
  if (body.address !== undefined) {
    put('address_line1', body.address.line1);
    put('address_line2', body.address.line2);
    put('city', body.address.city);
    put('district', body.address.district);
    put('state', body.address.state);
    put('country_code', body.address.countryCode);
    put('pincode', body.address.pincode);
  }
  put('category', body.category);
  put('payer_type', body.payerType);
  put('payer_ref', body.payerRef);
  put('is_vip', body.isVip);
  put('is_differently_abled', body.isDifferentlyAbled);
  put('is_pregnant', body.isPregnant);

  return out;
}
