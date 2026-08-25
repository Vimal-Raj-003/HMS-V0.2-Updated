import { Body, Controller, Get, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../core/policy/permission.decorator.js';
import { ZodBody } from '../../core/validation/zod.pipe.js';
import {
  barcodeQuerySchema,
  blockItemSchema,
  createItemSchema,
  createLocationSchema,
  createStoreSchema,
  idSchema,
  itemPriceSchema,
  itemQuerySchema,
  itemUomSchema,
  mapBarcodeSchema,
  storeParamsSchema,
  storeQuerySchema,
  updateItemSchema,
  updateStoreSchema,
  type BarcodeQuery,
  type BlockItemRequest,
  type CreateItemRequest,
  type CreateLocationRequest,
  type CreateStoreRequest,
  type ItemPriceRequest,
  type ItemQuery,
  type MapBarcodeRequest,
  type StoreParamsRequest,
  type StoreQuery,
  type UpdateItemRequest,
  type UpdateStoreRequest,
} from './inventory.schemas.js';
import type {
  ItemUomView,
  ItemView,
  ScanResolution,
  StoreLocationView,
  StoreView,
} from './inventory.types.js';
import { ItemsService } from './items.service.js';
import { StoresService } from './stores.service.js';
import { z } from 'zod';

/**
 * `/api/v1/inventory/items` — NC-006 §3.1.
 *
 * `resolve` is the one route here that is on the critical path of a busy
 * counter, and it is deliberately a *read* with `inventory.item.read`: a
 * pharmacist scanning a pack is not editing a master, and asking them to hold a
 * configuration permission to identify a box would put the whole counter behind
 * an administrator's role.
 */
@Controller('inventory/items')
export class InventoryItemsController {
  constructor(@Inject(ItemsService) private readonly items: ItemsService) {}

  @Permission('inventory.item.list')
  @Get()
  async list(@Query(new ZodBody(itemQuerySchema)) query: ItemQuery): Promise<Page<ItemView>> {
    return this.items.list(query);
  }

  /** One scan → item, pack size, batch and expiry (EN-013 §3). */
  @Permission('inventory.item.read')
  @Get('resolve')
  async resolve(@Query(new ZodBody(barcodeQuerySchema)) query: BarcodeQuery): Promise<ScanResolution> {
    return this.items.resolveScan(query.barcode);
  }

  @Permission('inventory.item.read')
  @Get(':id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<ItemView> {
    return this.items.get(id);
  }

  @Permission('inventory.item.read')
  @Get(':id/substitutes')
  async substitutes(@Param('id', new ZodBody(idSchema)) id: string): Promise<{
    readonly items: readonly {
      readonly itemId: string;
      readonly code: string;
      readonly name: string;
      readonly kind: string;
      readonly isPreferred: boolean;
      readonly requiresPrescriberApproval: boolean;
      readonly equivalenceFactor: string;
    }[];
  }> {
    return this.items.substitutes(id);
  }

  @Permission('inventory.item.create')
  @Idempotent()
  @Post()
  async create(@Body(new ZodBody(createItemSchema)) body: CreateItemRequest): Promise<ItemView> {
    return this.items.create(body);
  }

  @Permission('inventory.item.update')
  @Patch(':id')
  async update(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(updateItemSchema)) body: UpdateItemRequest,
  ): Promise<ItemView> {
    return this.items.update(id, body);
  }

  /** NC-006 §5: refused while stock of the item is on a shelf. */
  @Permission('inventory.item.update')
  @Idempotent()
  @Post(':id/block')
  async block(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(blockItemSchema)) body: BlockItemRequest,
  ): Promise<ItemView> {
    return this.items.block(id, body);
  }

  @Permission('inventory.item.update')
  @Idempotent()
  @Post(':id/activate')
  async activate(@Param('id', new ZodBody(idSchema)) id: string): Promise<ItemView> {
    return this.items.activate(id);
  }

  @Permission('inventory.item.update')
  @Idempotent()
  @Post(':id/uoms')
  async addUom(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(itemUomSchema)) body: z.infer<typeof itemUomSchema>,
  ): Promise<{ readonly items: readonly ItemUomView[] }> {
    const rungs = await this.items.addUom(id, {
      uomId: body.uomId,
      factorToBase: body.factorToBase,
      packLevel: body.packLevel,
      isPurchaseDefault: body.isPurchaseDefault,
      isIssueDefault: body.isIssueDefault,
      ...(body.gtin === undefined ? {} : { gtin: body.gtin }),
    });
    return { items: rungs };
  }

  @Permission('inventory.item.gtin.map')
  @Idempotent()
  @Post(':id/barcodes')
  async mapBarcode(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(mapBarcodeSchema)) body: MapBarcodeRequest,
  ): Promise<ScanResolution> {
    return this.items.mapBarcode(id, body);
  }

  @Permission('inventory.item.params.configure')
  @Put(':id/store-params/:storeId')
  async storeParams(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Param('storeId', new ZodBody(idSchema)) storeId: string,
    @Body(new ZodBody(storeParamsSchema)) body: StoreParamsRequest,
  ): Promise<{ readonly ok: true }> {
    await this.items.setStoreParams(id, storeId, body);
    return { ok: true };
  }

  /** `phase-04 §Constraints`: effective-dated, never retroactive. */
  @Permission('pharmacy.price.update')
  @Idempotent()
  @Post(':id/prices')
  async price(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(itemPriceSchema)) body: ItemPriceRequest,
  ): Promise<{ readonly ok: true }> {
    await this.items.addPrice(id, body);
    return { ok: true };
  }
}

/** `/api/v1/inventory/stores` — NC-006 §3.2, the store hierarchy and its bins. */
@Controller('inventory/stores')
export class InventoryStoresController {
  constructor(@Inject(StoresService) private readonly stores: StoresService) {}

  @Permission('inventory.store.list')
  @Get()
  async list(@Query(new ZodBody(storeQuerySchema)) query: StoreQuery): Promise<Page<StoreView>> {
    return this.stores.list(query);
  }

  @Permission('inventory.store.read')
  @Get(':id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<StoreView> {
    return this.stores.get(id);
  }

  @Permission('inventory.store.read')
  @Get(':id/locations')
  async locations(
    @Param('id', new ZodBody(idSchema)) id: string,
  ): Promise<{ readonly items: readonly StoreLocationView[] }> {
    return this.stores.locations(id);
  }

  @Permission('inventory.store.configure')
  @Idempotent()
  @Post()
  async create(@Body(new ZodBody(createStoreSchema)) body: CreateStoreRequest): Promise<StoreView> {
    return this.stores.create(body);
  }

  @Permission('inventory.store.configure')
  @Patch(':id')
  async update(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(updateStoreSchema)) body: UpdateStoreRequest,
  ): Promise<StoreView> {
    return this.stores.update(id, body);
  }

  @Permission('inventory.store.configure')
  @Idempotent()
  @Post(':id/locations')
  async addLocation(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(createLocationSchema)) body: CreateLocationRequest,
  ): Promise<StoreLocationView> {
    return this.stores.addLocation(id, body);
  }
}
