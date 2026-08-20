import { Controller, Get, Inject, Query } from '@nestjs/common';
import { auditSearchQuerySchema, type Page } from '@vims/contracts';
import type { z } from 'zod';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { AuditLogService, type AuditEntry } from './audit-log.service.js';

/**
 * `/api/v1/admin/audit` — the audit log viewer (EN-007 §6, EN-024 §6).
 *
 * `admin.audit.read` is the EN-007 §12 key for the console's viewer, and it
 * carries `phiRead: true` — so the policy engine attaches a `write_phi_read_audit`
 * obligation and the service discharges it inside the same transaction as the
 * read. Export is a different key (`admin.audit.export`, step-up and
 * reason-required) and a different surface; it is not offered here.
 */
@Controller('admin/audit')
export class AuditLogController {
  constructor(@Inject(AuditLogService) private readonly auditLog: AuditLogService) {}

  @Permission('admin.audit.read')
  @Get()
  async search(
    @Query(new ZodBody(auditSearchQuerySchema)) query: z.infer<typeof auditSearchQuerySchema>,
  ): Promise<Page<AuditEntry>> {
    return this.auditLog.search(query);
  }
}
