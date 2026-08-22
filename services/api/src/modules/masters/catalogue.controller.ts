import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Permission } from '../../core/policy/permission.decorator.js';
import { ZodBody } from '../../core/validation/zod.pipe.js';
import {
  MastersCatalogueService,
  type ConsultTypeListItem,
  type DepartmentListItem,
  type RoomListItem,
  type ServiceListItem,
  type SpecialityListItem,
} from './catalogue.service.js';
import {
  listConsultTypesQuerySchema,
  listDepartmentsQuerySchema,
  listRoomsQuerySchema,
  listServicesQuerySchema,
  listSpecialitiesQuerySchema,
  type ListConsultTypesQuery,
  type ListDepartmentsQuery,
  type ListRoomsQuery,
  type ListServicesQuery,
  type ListSpecialitiesQuery,
} from './masters.schemas.js';

/**
 * `/api/v1/{departments,specialities,consult-types,services,rooms}` — EN-027 §6
 * row 2, "list any master, point-in-time".
 *
 * All five are `mdm.read`, which EN-027 §12 describes as "all staff — pickers
 * and lookups". They are one controller per URL prefix rather than one
 * controller with five paths because Nest binds a controller to a single prefix,
 * and five two-line classes are cheaper to read than a routing table.
 *
 * These are `docs/07` §2.1 **class A** endpoints — p95 80 ms — and they are hit
 * on the first paint of the registration desk, the appointment book, the queue
 * console and the cash counter. They therefore do exactly one indexed query
 * each, return no aggregate, and never join.
 */
@Controller('departments')
export class DepartmentsController {
  constructor(@Inject(MastersCatalogueService) private readonly masters: MastersCatalogueService) {}

  @Permission('mdm.read')
  @Get()
  async list(
    @Query(new ZodBody(listDepartmentsQuerySchema)) query: ListDepartmentsQuery,
  ): Promise<Page<DepartmentListItem>> {
    return this.masters.listDepartments(query);
  }
}

@Controller('specialities')
export class SpecialitiesController {
  constructor(@Inject(MastersCatalogueService) private readonly masters: MastersCatalogueService) {}

  @Permission('mdm.read')
  @Get()
  async list(
    @Query(new ZodBody(listSpecialitiesQuerySchema)) query: ListSpecialitiesQuery,
  ): Promise<Page<SpecialityListItem>> {
    return this.masters.listSpecialities(query);
  }
}

@Controller('consult-types')
export class ConsultTypesController {
  constructor(@Inject(MastersCatalogueService) private readonly masters: MastersCatalogueService) {}

  @Permission('mdm.read')
  @Get()
  async list(
    @Query(new ZodBody(listConsultTypesQuerySchema)) query: ListConsultTypesQuery,
  ): Promise<Page<ConsultTypeListItem>> {
    return this.masters.listConsultTypes(query);
  }
}

@Controller('services')
export class ServicesController {
  constructor(@Inject(MastersCatalogueService) private readonly masters: MastersCatalogueService) {}

  @Permission('mdm.read')
  @Get()
  async list(
    @Query(new ZodBody(listServicesQuerySchema)) query: ListServicesQuery,
  ): Promise<Page<ServiceListItem>> {
    return this.masters.listServices(query);
  }
}

@Controller('rooms')
export class RoomsController {
  constructor(@Inject(MastersCatalogueService) private readonly masters: MastersCatalogueService) {}

  @Permission('mdm.read')
  @Get()
  async list(@Query(new ZodBody(listRoomsQuerySchema)) query: ListRoomsQuery): Promise<Page<RoomListItem>> {
    return this.masters.listRooms(query);
  }
}
