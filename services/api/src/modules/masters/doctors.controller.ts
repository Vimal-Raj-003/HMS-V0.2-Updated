import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Permission } from '../../core/policy/permission.decorator.js';
import { ZodBody } from '../../core/validation/zod.pipe.js';
import { DoctorsService, type DoctorDetail, type DoctorListItem } from './doctors.service.js';
import {
  doctorDetailQuerySchema,
  listDoctorsQuerySchema,
  uuidSchema,
  type DoctorDetailQuery,
  type ListDoctorsQuery,
} from './masters.schemas.js';

/**
 * `/api/v1/doctors` — the practitioner master (EN-027 §4).
 *
 * The prefix is shared with `DoctorSchedulesController` in the scheduling
 * module, which owns `/doctors/{id}/slots`, `/doctors/{id}/schedule-templates`
 * and `/doctors/{id}/schedule-exceptions`. Two controllers on one prefix is
 * legal in Nest and correct here: the roster of doctors is master data (EN-027)
 * while a doctor's *availability* is scheduling (OP-001 §3.6), and neither
 * module should own the other's tables. The paths do not collide — this
 * controller adds `GET /doctors` and `GET /doctors/{id}`, both of which are free
 * — and `{id}` means the same thing in both: the practitioner's `record_key`.
 *
 * `mdm.read` rather than a scheduling key, because the picker is opened by the
 * front desk, the call centre, the lab and the pharmacy alike.
 */
@Controller('doctors')
export class DoctorsController {
  constructor(@Inject(DoctorsService) private readonly doctors: DoctorsService) {}

  @Permission('mdm.read')
  @Get()
  async list(
    @Query(new ZodBody(listDoctorsQuerySchema)) query: ListDoctorsQuery,
  ): Promise<Page<DoctorListItem>> {
    return this.doctors.list(query);
  }

  @Permission('mdm.read')
  @Get(':id')
  async get(
    @Param('id', new ZodBody(uuidSchema)) id: string,
    @Query(new ZodBody(doctorDetailQuerySchema)) query: DoctorDetailQuery,
  ): Promise<DoctorDetail> {
    return this.doctors.get(id, query);
  }
}
