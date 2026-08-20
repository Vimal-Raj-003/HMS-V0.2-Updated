import { Controller, Get, Inject } from '@nestjs/common';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { LicenceService, type LicenceState } from './licence.service.js';

/**
 * `/api/v1/admin/licence` — EN-007 §6 "licence status", EN-040 §6.
 *
 * `admin.licence.read` is the hospital-side key ("View plan, seats, quotas and
 * expiry"), classified `commercial`/`low`. No mutation exists on this route: the
 * commercial state is the operator's to change.
 */
@Controller('admin/licence')
export class LicenceController {
  constructor(@Inject(LicenceService) private readonly licence: LicenceService) {}

  @Permission('admin.licence.read')
  @Get()
  async state(): Promise<LicenceState> {
    return this.licence.state();
  }
}
