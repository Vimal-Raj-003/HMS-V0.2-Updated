import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { DatabaseService } from '../../../core/db/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { Permission } from '../../../core/policy/permission.decorator.js';

interface UserListRow {
  id: string;
  username: string;
  display_name: string;
  status: string;
}

/**
 * The first route that exercises the whole chain end to end.
 *
 * It is deliberately a boring list, because what it proves is not the feature:
 * a request reaches here only after auth (2), tenancy (3), validation (5) and
 * policy (6) have all run, and it reads through `withTenant` so step 8 has
 * stamped the scope and RLS is doing the filtering. The `hospital_id` never
 * appears in the WHERE clause below — if the isolation test passes anyway, the
 * *policy* is what enforced it, which is the property `docs/09` §3.1 asks us to
 * demonstrate rather than assume.
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(limit: number): Promise<readonly UserListRow[]> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
        const rows = await tx.rows<UserListRow>(
          `SELECT id, username, display_name, status
             FROM core.users
            WHERE deleted_at IS NULL
            ORDER BY display_name
            LIMIT $1`,
          [limit],
        );

        // A list of staff is HR-class data, and reading it is itself auditable
        // (docs/05 §Data classes). The count is recorded, never the identifiers.
        await this.audit.write(tx, {
          action: 'read_phi',
          entity: 'core.users',
          rowId: null,
          businessKey: null,
          dataClass: 'hr',
          before: null,
          after: null,
          rowCount: rows.length,
        });

      return rows;
    });
  }
}

@Controller('admin/users')
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Permission('admin.user.read')
  @Get()
  async list(@Query('limit') limit?: string): Promise<{ items: readonly UserListRow[] }> {
    const parsed = Number.parseInt(limit ?? '50', 10);
    const bounded = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
    return { items: await this.users.list(bounded) };
  }
}
