import { Body, Controller, Get, Inject, Put, Query } from '@nestjs/common';
import { putSettingRequestSchema } from '@vims/contracts';
import { z } from 'zod';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { SettingsService } from './settings.service.js';
import type { EffectiveSetting } from './settings.logic.js';

export const settingsQuerySchema = z.object({
  module: z.string().max(16).optional(),
  q: z.string().max(120).optional(),
  branchId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
});

/**
 * `/api/v1/admin/settings` — EN-007 §6.
 *
 * `admin.settings.read` to look, `admin.settings.configure` to change. The
 * configure key is `requiresStepUp` in the catalogue, so the policy engine
 * demands fresh authentication before a configuration change lands.
 *
 * `/definitions` is declared before any dynamic segment so it can never be
 * shadowed by one.
 */
@Controller('admin/settings')
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Permission('admin.settings.read')
  @Get('definitions')
  definitions(): { items: ReturnType<SettingsService['definitions']> } {
    return { items: this.settings.definitions() };
  }

  @Permission('admin.settings.read')
  @Get()
  async effective(
    @Query(new ZodBody(settingsQuerySchema)) query: z.infer<typeof settingsQuerySchema>,
  ): Promise<{ items: readonly EffectiveSetting[] }> {
    return this.settings.effective(query);
  }

  @Permission('admin.settings.configure')
  @Put()
  async put(
    @Body(new ZodBody(putSettingRequestSchema)) body: z.infer<typeof putSettingRequestSchema>,
  ): Promise<EffectiveSetting> {
    return this.settings.put(body);
  }
}
