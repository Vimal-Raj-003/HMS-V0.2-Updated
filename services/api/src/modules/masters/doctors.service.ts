import { Inject, Injectable } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { getContext } from '../../core/context/request-context.js';
import { DatabaseService } from '../../core/db/database.service.js';
import { AppError } from '../../core/problem/app-error.js';
import { currentTenantContext } from '../../core/tenancy/tenant-context.js';
import { MastersQueryService, effectivePredicate, likeTerm, type Bind } from './masters.query.js';
import type { DoctorDetailQuery, ListDoctorsQuery } from './masters.schemas.js';

/**
 * `GET /doctors` — the practitioner master (EN-027 §4), as an appointment
 * picker sees it.
 *
 * **What is deliberately not here.** A practitioner is a person, and this list
 * is readable by every holder of `mdm.read` — which is every member of staff,
 * including the front desk. So the projection carries what a picker needs to
 * choose a doctor and nothing that identifies or authenticates them:
 *
 *  - no `registration_number`, `registration_council` or `registration_valid_to`
 *    — professional credentials belong on the prescription and in the NMC
 *    verification screen, not in a dropdown feed;
 *  - no `hpr_id` — an ABDM national-registry identifier for a real person;
 *  - no `signature_file_id` — a pointer to a scanned signature is the closest
 *    thing in this table to a credential, and a receptionist has no use for it;
 *  - no `user_id` — the practitioner-to-login mapping is an access-control fact
 *    (`docs/04` §3), and a caller who needs their own is served by `/me`.
 *
 * `docs/04` §7's "no PHI in a list" is about patients; this is the same argument
 * applied to staff, which `docs/05` classes as HR-class data.
 */

export interface DoctorListItem {
  readonly id: string;
  readonly record_key: string;
  readonly code: string;
  readonly title: string | null;
  readonly full_name: string;
  readonly display_name: string;
  readonly gender: string | null;
  readonly qualifications: readonly string[];
  readonly department_key: string | null;
  readonly speciality_keys: readonly string[];
  readonly languages: readonly string[];
  readonly employment_type: string;
  readonly default_room_key: string | null;
  readonly tele_enabled: boolean;
  readonly online_booking_enabled: boolean;
  readonly website_visible: boolean;
  readonly follow_up_days: number | null;
  readonly follow_up_free_visits: number | null;
  readonly photo_file_id: string | null;
  readonly active_branches: readonly string[];
  readonly effective_from: Date;
  readonly effective_to: Date | null;
}

/** One consultation fee, in effect at the same instant as the practitioner row. */
export interface DoctorFee {
  readonly consult_type_key: string;
  readonly amount: string;
  readonly currency: string;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
}

export interface DoctorDetail extends DoctorListItem {
  readonly bio: string | null;
  /** Empty when no fee has been approved for this practitioner yet. */
  readonly fees: readonly DoctorFee[];
}

const LIST_COLUMNS = `m.id, m.record_key, m.code, m.title, m.full_name, m.display_name, m.gender,
                      m.qualifications, m.department_key, m.speciality_keys, m.languages,
                      m.employment_type, m.default_room_key, m.tele_enabled, m.online_booking_enabled,
                      m.website_visible, m.follow_up_days, m.follow_up_free_visits, m.photo_file_id,
                      m.active_branches, m.effective_from, m.effective_to`;

@Injectable()
export class DoctorsService {
  constructor(
    @Inject(MastersQueryService) private readonly query: MastersQueryService,
    @Inject(DatabaseService) private readonly db: DatabaseService,
  ) {}

  async list(q: ListDoctorsQuery): Promise<Page<DoctorListItem>> {
    const branchId = q.branchId ?? getContext().branchId;

    return this.query.list<DoctorListItem>(
      {
        resource: 'mdm.practitioners',
        from: 'mdm.mdm_practitioners m',
        alias: 'm',
        columns: LIST_COLUMNS,
        // The picker is an alphabetical list of the names it displays, so the
        // sort key is `display_name` ("Dr. Ananya Krishnan") rather than the
        // legal `full_name`. Sorting on one column and showing another is how a
        // list ends up looking unsorted to the person reading it.
        label: 'm.display_name',
        effectiveDated: true,
      },
      q,
      (bind) => {
        const where: string[] = [];
        if (branchId !== null) {
          where.push(
            `(cardinality(m.active_branches) = 0 OR ${bind(branchId)}::uuid = ANY (m.active_branches))`,
          );
        }
        if (q.specialityId !== undefined) {
          where.push(`${bind(q.specialityId)}::uuid = ANY (m.speciality_keys)`);
        }
        if (q.departmentId !== undefined) where.push(`m.department_key = ${bind(q.departmentId)}::uuid`);
        if (q.onlineBookableOnly === true) where.push('m.online_booking_enabled');
        if (q.teleOnly === true) where.push('m.tele_enabled');
        if (q.q !== undefined) {
          // Both columns are searched because the desk types the name it knows
          // ("Krishnan") while the board shows the name it displays. The trigram
          // index `idx_mdm_practitioners_name_trgm` covers `full_name`.
          const term = bind(likeTerm(q.q));
          where.push(
            `(m.full_name ILIKE '%' || ${term} || '%' OR m.display_name ILIKE '%' || ${term} || '%')`,
          );
        }
        return where;
      },
    );
  }

  /**
   * One practitioner, keyed by **`record_key`**.
   *
   * The same identifier `GET /doctors/:id/slots` takes, and the same one
   * `clinical.appointments.practitioner_key` stores. Taking the version `id`
   * here instead would give the appointment book two different meanings for the
   * same path parameter.
   *
   * A `record_key` belonging to another hospital is filtered out by RLS before
   * this method sees it and leaves as a 404 rather than a 403 — a 403 would
   * confirm that the doctor exists somewhere (`docs/09` §3.1 case 2).
   */
  async get(recordKey: string, query: DoctorDetailQuery): Promise<DoctorDetail> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [recordKey];
      const bind: Bind = (value) => `$${values.push(value)}`;
      const inEffect = effectivePredicate('m', query.asOf, bind);

      const doctor = await tx.maybeOne<Omit<DoctorDetail, 'fees'>>(
        `SELECT ${LIST_COLUMNS}, m.bio
           FROM mdm.mdm_practitioners m
          WHERE m.record_key = $1::uuid AND ${inEffect}`,
        values,
      );
      if (doctor === undefined) throw AppError.notFound('The doctor');

      const feeValues: unknown[] = [recordKey];
      const feeBind: Bind = (value) => `$${feeValues.push(value)}`;
      const feesInEffect = effectivePredicate('f', query.asOf, feeBind);

      // The fee is resolved at the *same* instant as the practitioner. Asking
      // for the doctor as of March and the fee as of today would produce a
      // quotation that never existed.
      const fees = await tx.rows<DoctorFee>(
        `SELECT f.consult_type_key, f.amount::text AS amount, f.currency,
                f.effective_from, f.effective_to
           FROM mdm.mdm_practitioner_fees f
          WHERE f.practitioner_key = $1::uuid AND ${feesInEffect}
          ORDER BY f.consult_type_key`,
        feeValues,
      );

      return { ...doctor, fees };
    });
  }
}
