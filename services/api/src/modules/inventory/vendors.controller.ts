import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../core/policy/permission.decorator.js';
import { ZodBody } from '../../core/validation/zod.pipe.js';
import {
  approveVendorSchema,
  createVendorSchema,
  idSchema,
  rateContractSchema,
  updateVendorSchema,
  vendorActionSchema,
  vendorItemSchema,
  vendorQuerySchema,
  type ApproveVendorRequest,
  type CreateVendorRequest,
  type RateContractRequest,
  type UpdateVendorRequest,
  type VendorActionRequest,
  type VendorItemRequest,
  type VendorQuery,
} from './inventory.schemas.js';
import type { RateContractView, VendorView } from './inventory.types.js';
import { VendorsService } from './vendors.service.js';

/**
 * `/api/v1/vendors` — NC-021.
 *
 * `vendor.master.approve` is a separate key from `vendor.master.manage` because
 * the two must be held by different people, and `VendorsService.approve`
 * enforces that the *specific* approver is not the specific creator. A key
 * split without the row-level check would let one person hold both and approve
 * their own record; a row-level check without the key split would make the
 * control invisible in the role matrix.
 */
@Controller('vendors')
export class VendorsController {
  constructor(@Inject(VendorsService) private readonly vendors: VendorsService) {}

  @Permission('vendor.master.list')
  @Get()
  async list(@Query(new ZodBody(vendorQuerySchema)) query: VendorQuery): Promise<Page<VendorView>> {
    return this.vendors.list(query);
  }

  @Permission('vendor.master.read')
  @Get(':id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<VendorView> {
    return this.vendors.get(id);
  }

  @Permission('vendor.master.manage')
  @Idempotent()
  @Post()
  async create(@Body(new ZodBody(createVendorSchema)) body: CreateVendorRequest): Promise<VendorView> {
    return this.vendors.create(body);
  }

  @Permission('vendor.master.manage')
  @Patch(':id')
  async update(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(updateVendorSchema)) body: UpdateVendorRequest,
  ): Promise<VendorView> {
    return this.vendors.update(id, body);
  }

  /** Maker ≠ checker: the creator of the record may not approve it. */
  @Permission('vendor.master.approve')
  @Idempotent()
  @Post(':id/approve')
  async approve(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(approveVendorSchema)) body: ApproveVendorRequest,
  ): Promise<VendorView> {
    return this.vendors.approve(id, body);
  }

  @Permission('vendor.item.manage')
  @Idempotent()
  @Post(':id/items')
  async mapItem(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(vendorItemSchema)) body: VendorItemRequest,
  ): Promise<{ readonly ok: true }> {
    await this.vendors.mapItem(id, body);
    return { ok: true };
  }

  @Permission('vendor.contract.list')
  @Get(':id/rate-contracts')
  async rateContracts(
    @Param('id', new ZodBody(idSchema)) id: string,
  ): Promise<{ readonly items: readonly RateContractView[] }> {
    return this.vendors.rateContracts(id);
  }

  @Permission('vendor.contract.manage')
  @Idempotent()
  @Post(':id/rate-contracts')
  async createRateContract(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(rateContractSchema)) body: RateContractRequest,
  ): Promise<RateContractView> {
    return this.vendors.createRateContract(id, body);
  }

  @Permission('vendor.contract.approve')
  @Idempotent()
  @Post('rate-contracts/:id/approve')
  async approveRateContract(@Param('id', new ZodBody(idSchema)) id: string): Promise<RateContractView> {
    return this.vendors.approveRateContract(id);
  }

  /**
   * A sanction, or the show-cause notice that has to precede one.
   *
   * Decorated with `vendor.action.propose`; a hospital that wants proposal and
   * approval in different hands grants `vendor.action.approve` separately and
   * routes the decision through EN-038. The notice itself is not a sanction and
   * changes nothing about the vendor's status, which is the point of it.
   */
  @Permission('vendor.action.propose')
  @Idempotent()
  @Post(':id/actions')
  async action(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(vendorActionSchema)) body: VendorActionRequest,
  ): Promise<VendorView> {
    return this.vendors.action(id, body);
  }
}
