import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { putFeatureFlagRequestSchema } from '@vims/contracts';
import { z } from 'zod';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { FlagsService } from './flags.service.js';
import type { ResolvedFlag } from './entitlements.logic.js';

const flagKeySchema = z.string().min(3).max(128).regex(/^[a-z][a-z0-9_.]*$/, 'Lower snake_case, dot-separated');

/**
 * `/api/v1/admin/flags` — EN-007 §6.
 *
 * EN-007 §6 assigns `admin.flags.configure` to both the read and the write of
 * this resource; the catalogue has no `admin.flags.read`, and inventing one
 * would stop the process at boot (`assertRegisteredPermission`). The read is
 * therefore configure-gated, which is defensible: the module grid shows what the
 * hospital is licensed for, which is commercial information.
 */
@Controller('admin/flags')
export class FlagsController {
  constructor(@Inject(FlagsService) private readonly flags: FlagsService) {}

  @Permission('admin.flags.configure')
  @Get()
  async list(): Promise<{ items: readonly ResolvedFlag[] }> {
    return this.flags.list();
  }

  @Permission('admin.flags.configure')
  @Put(':key')
  async put(
    @Param('key', new ZodBody(flagKeySchema)) key: string,
    @Body(new ZodBody(putFeatureFlagRequestSchema.omit({ key: true })))
    body: Omit<z.infer<typeof putFeatureFlagRequestSchema>, 'key'>,
  ): Promise<ResolvedFlag> {
    return this.flags.put(key, { ...body, key });
  }
}
