import { Inject, Injectable } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { getContext } from '../../core/context/request-context.js';
import { MastersQueryService, likeTerm, type Bind } from './masters.query.js';
import type {
  ListConsultTypesQuery,
  ListDepartmentsQuery,
  ListRoomsQuery,
  ListServicesQuery,
  ListSpecialitiesQuery,
} from './masters.schemas.js';

/**
 * The five organisational masters every Phase-1 screen picks from:
 * department, speciality, consultation type, service and room.
 *
 * Each row carries **both** `id` and `record_key`, and the difference matters at
 * every call site. `id` identifies one *version* — it changes when a master is
 * re-priced or renamed, and it is what the cursor keys on. `record_key` is the
 * stable identity across versions, and it is what every operational table
 * stores: `clinical.appointments.practitioner_key`,
 * `queue.queue_definitions.department_key`, `mdm_services.speciality_key`. A
 * picker must therefore submit `record_key` and never `id`, or next month's
 * price revision would orphan every appointment booked this month.
 */

export interface DepartmentListItem {
  readonly id: string;
  readonly record_key: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly parent_department_key: string | null;
  readonly speciality_concept: string | null;
  readonly cost_centre_key: string | null;
  readonly active_branches: readonly string[];
  readonly effective_from: Date;
  readonly effective_to: Date | null;
}

export interface SpecialityListItem {
  readonly id: string;
  readonly record_key: string;
  readonly code: string;
  readonly name: string;
  readonly system_of_medicine: string;
  readonly department_key: string | null;
  readonly speciality_concept: string | null;
  readonly telemedicine_allowed: boolean;
  readonly website_visible: boolean;
  readonly sort_order: number;
  readonly active_branches: readonly string[];
  readonly effective_from: Date;
  readonly effective_to: Date | null;
}

export interface ConsultTypeListItem {
  readonly id: string;
  readonly record_key: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly is_chargeable: boolean;
  readonly validity_days: number | null;
  readonly validity_visits: number | null;
  readonly default_duration_min: number;
  readonly online_bookable: boolean;
  readonly sort_order: number;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
}

export interface ServiceListItem {
  readonly id: string;
  readonly record_key: string;
  readonly code: string;
  readonly name: string;
  readonly group_key: string;
  readonly department_key: string | null;
  readonly speciality_key: string | null;
  readonly sac_code: string | null;
  readonly gst_rate: string;
  readonly is_procedure: boolean;
  readonly requires_consent: boolean;
  readonly consent_type_key: string | null;
  readonly default_duration_min: number;
  readonly patient_instructions: string | null;
  readonly prerequisites: string | null;
  readonly is_appointable: boolean;
  readonly active_branches: readonly string[];
  readonly effective_from: Date;
  readonly effective_to: Date | null;
}

export interface RoomListItem {
  readonly id: string;
  readonly record_key: string;
  readonly branch_id: string;
  readonly code: string;
  readonly name: string;
  readonly display_name: string;
  readonly kind: string;
  readonly department_key: string | null;
  readonly block: string | null;
  readonly floor: string | null;
  readonly capacity: number;
  readonly wheelchair_accessible: boolean;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
}

/**
 * The branch a branch filter means.
 *
 * An explicit `?branchId=` wins — a group administrator legitimately looks at
 * another branch's rooms. Otherwise the acting branch is used, because a
 * receptionist asking for "the rooms" means the ones in front of them. When
 * neither is present the filter is simply absent: RLS has already narrowed the
 * read to the branches the session is granted, so the result is "every branch I
 * may see" rather than a leak.
 */
function branchFilter(requested: string | undefined): string | null {
  return requested ?? getContext().branchId;
}

/**
 * `active_branches` is a Phase-1 scoping list, and an **empty** one means
 * "not restricted", not "nowhere".
 *
 * The column defaults to `ARRAY[]::UUID[]`, so reading empty as "no branches"
 * would make every master created through a path that does not populate it
 * invisible in every branch — a master data set that exists and cannot be
 * picked. EN-027 §3.6 scopes a master to branches by listing them; a master that
 * lists none has not been scoped.
 */
function activeInBranch(alias: string, branchId: string, bind: Bind): string {
  const b = bind(branchId);
  return `(cardinality(${alias}.active_branches) = 0 OR ${b}::uuid = ANY (${alias}.active_branches))`;
}

@Injectable()
export class MastersCatalogueService {
  constructor(@Inject(MastersQueryService) private readonly query: MastersQueryService) {}

  async listDepartments(q: ListDepartmentsQuery): Promise<Page<DepartmentListItem>> {
    const branchId = branchFilter(q.branchId);
    return this.query.list<DepartmentListItem>(
      {
        resource: 'mdm.departments',
        from: 'mdm.mdm_departments m',
        alias: 'm',
        columns: `m.id, m.record_key, m.code, m.name, m.kind, m.parent_department_key,
                  m.speciality_concept, m.cost_centre_key, m.active_branches,
                  m.effective_from, m.effective_to`,
        label: 'm.name',
        effectiveDated: true,
      },
      q,
      (bind) => {
        const where: string[] = [];
        if (branchId !== null) where.push(activeInBranch('m', branchId, bind));
        if (q.kind !== undefined) where.push(`m.kind = ${bind(q.kind)}`);
        if (q.q !== undefined) where.push(`m.name ILIKE '%' || ${bind(likeTerm(q.q))} || '%'`);
        return where;
      },
    );
  }

  async listSpecialities(q: ListSpecialitiesQuery): Promise<Page<SpecialityListItem>> {
    const branchId = branchFilter(q.branchId);
    return this.query.list<SpecialityListItem>(
      {
        resource: 'mdm.specialities',
        from: 'mdm.mdm_specialities m',
        alias: 'm',
        columns: `m.id, m.record_key, m.code, m.name, m.system_of_medicine::text AS system_of_medicine,
                  m.department_key, m.speciality_concept, m.telemedicine_allowed, m.website_visible,
                  m.sort_order, m.active_branches, m.effective_from, m.effective_to`,
        label: 'm.name',
        effectiveDated: true,
      },
      q,
      (bind) => {
        const where: string[] = [];
        if (branchId !== null) where.push(activeInBranch('m', branchId, bind));
        if (q.departmentId !== undefined) where.push(`m.department_key = ${bind(q.departmentId)}::uuid`);
        if (q.telemedicineOnly === true) where.push('m.telemedicine_allowed');
        if (q.q !== undefined) where.push(`m.name ILIKE '%' || ${bind(likeTerm(q.q))} || '%'`);
        return where;
      },
    );
  }

  async listConsultTypes(q: ListConsultTypesQuery): Promise<Page<ConsultTypeListItem>> {
    return this.query.list<ConsultTypeListItem>(
      {
        resource: 'mdm.consult_types',
        from: 'mdm.mdm_consult_types m',
        alias: 'm',
        columns: `m.id, m.record_key, m.code, m.name, m.kind, m.is_chargeable, m.validity_days,
                  m.validity_visits, m.default_duration_min, m.online_bookable, m.sort_order,
                  m.effective_from, m.effective_to`,
        label: 'm.name',
        effectiveDated: true,
      },
      q,
      (bind) => {
        const where: string[] = [];
        if (q.onlineBookableOnly === true) where.push('m.online_bookable');
        if (q.q !== undefined) where.push(`m.name ILIKE '%' || ${bind(likeTerm(q.q))} || '%'`);
        return where;
      },
    );
  }

  async listServices(q: ListServicesQuery): Promise<Page<ServiceListItem>> {
    const branchId = branchFilter(q.branchId);
    return this.query.list<ServiceListItem>(
      {
        resource: 'mdm.services',
        from: 'mdm.mdm_services m',
        alias: 'm',
        // `gst_rate` is `numeric(5,2)` and is returned as the string Postgres
        // renders. `docs/03` is explicit that money and rates never pass through
        // a JavaScript `number`: 0.1 + 0.2 is not 0.3, and a GST rate that is
        // 17.999999999999996 on the invoice is a filing defect.
        columns: `m.id, m.record_key, m.code, m.name, m.group_key, m.department_key, m.speciality_key,
                  m.sac_code, m.gst_rate::text AS gst_rate, m.is_procedure, m.requires_consent,
                  m.consent_type_key, m.default_duration_min, m.patient_instructions, m.prerequisites,
                  m.is_appointable, m.active_branches, m.effective_from, m.effective_to`,
        label: 'm.name',
        effectiveDated: true,
      },
      q,
      (bind) => {
        const where: string[] = [];
        if (branchId !== null) where.push(activeInBranch('m', branchId, bind));
        if (q.departmentId !== undefined) where.push(`m.department_key = ${bind(q.departmentId)}::uuid`);
        if (q.specialityId !== undefined) where.push(`m.speciality_key = ${bind(q.specialityId)}::uuid`);
        if (q.group !== undefined) where.push(`m.group_key = ${bind(q.group)}`);
        if (q.appointableOnly === true) where.push('m.is_appointable');
        if (q.q !== undefined) where.push(`m.name ILIKE '%' || ${bind(likeTerm(q.q))} || '%'`);
        return where;
      },
    );
  }

  async listRooms(q: ListRoomsQuery): Promise<Page<RoomListItem>> {
    const branchId = branchFilter(q.branchId);
    return this.query.list<RoomListItem>(
      {
        resource: 'mdm.rooms',
        from: 'mdm.mdm_rooms m',
        alias: 'm',
        columns: `m.id, m.record_key, m.branch_id, m.code, m.name, m.display_name, m.kind::text AS kind,
                  m.department_key, m.block, m.floor, m.capacity, m.wheelchair_accessible,
                  m.effective_from, m.effective_to`,
        label: 'm.name',
        effectiveDated: true,
      },
      q,
      (bind) => {
        const where: string[] = [];
        // A room is the one master with `branch_id NOT NULL` — it is a physical
        // place, so it belongs to exactly one campus and is matched directly
        // rather than through `active_branches`.
        if (branchId !== null) where.push(`m.branch_id = ${bind(branchId)}::uuid`);
        if (q.departmentId !== undefined) where.push(`m.department_key = ${bind(q.departmentId)}::uuid`);
        if (q.kind !== undefined) where.push(`m.kind = ${bind(q.kind)}::mdm."MdmRoomKind"`);
        if (q.q !== undefined) where.push(`m.name ILIKE '%' || ${bind(likeTerm(q.q))} || '%'`);
        return where;
      },
    );
  }
}
