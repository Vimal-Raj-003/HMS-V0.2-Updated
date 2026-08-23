import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import {
  accessionSampleSchema,
  barcodeSchema,
  collectSampleSchema,
  receiveSampleSchema,
  rejectSampleSchema,
  type AccessionSampleRequest,
  type CollectSampleRequest,
  type ReceiveSampleRequest,
  type RejectSampleRequest,
} from './lab.schemas.js';
import type { LabSampleView } from './lab.types.js';
import { LabSamplesService } from './samples.service.js';

/**
 * `/api/v1/lab/samples/{barcode}/*` — OP-004 §3.2.
 *
 * **Keyed by barcode, not by id.** Every one of these actions happens with a
 * tube in one hand and a scanner in the other; a route that needed a UUID would
 * need a lookup screen first, and a lookup screen is where somebody picks the
 * wrong patient. The barcode is unique per hospital by index, and RLS is what
 * makes "per hospital" true — so a scan from another tenant resolves to nothing,
 * which is the 404 `docs/09 §3.1` requires.
 */
@Controller('lab/samples')
export class LabSamplesController {
  constructor(@Inject(LabSamplesService) private readonly samples: LabSamplesService) {}

  @Permission('lab.order.read')
  @Get(':barcode')
  async get(@Param('barcode', new ZodBody(barcodeSchema)) barcode: string): Promise<LabSampleView> {
    return this.samples.getByBarcode(barcode);
  }

  /** Two scans, or a named override with a reason. There is no third answer. */
  @Permission('lab.sample.collect')
  @Idempotent()
  @Post(':barcode/collect')
  async collect(
    @Param('barcode', new ZodBody(barcodeSchema)) barcode: string,
    @Body(new ZodBody(collectSampleSchema)) body: CollectSampleRequest,
  ): Promise<LabSampleView> {
    return this.samples.collect(barcode, body);
  }

  @Permission('lab.sample.receive')
  @Idempotent()
  @Post(':barcode/receive')
  async receive(
    @Param('barcode', new ZodBody(barcodeSchema)) barcode: string,
    @Body(new ZodBody(receiveSampleSchema)) body: ReceiveSampleRequest,
  ): Promise<LabSampleView> {
    return this.samples.receive(barcode, body);
  }

  @Permission('lab.sample.receive')
  @Idempotent()
  @Post(':barcode/accession')
  async accession(
    @Param('barcode', new ZodBody(barcodeSchema)) barcode: string,
    @Body(new ZodBody(accessionSampleSchema)) body: AccessionSampleRequest,
  ): Promise<LabSampleView> {
    return this.samples.accession(barcode, body);
  }

  /**
   * `phase-03` exit gate 3. The coded reason is mandatory, the recollection is
   * raised against the same order, and the replacement line is free by CHECK.
   */
  @Permission('lab.sample.reject')
  @Idempotent()
  @Post(':barcode/reject')
  async reject(
    @Param('barcode', new ZodBody(barcodeSchema)) barcode: string,
    @Body(new ZodBody(rejectSampleSchema)) body: RejectSampleRequest,
  ): Promise<LabSampleView> {
    return this.samples.reject(barcode, body);
  }
}
