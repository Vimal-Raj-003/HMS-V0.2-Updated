import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PERMISSION_CATALOGUE } from '@vims/contracts';
import { DatabaseService } from '../db/database.service.js';

/**
 * Verifies at boot that `core.permissions` matches the catalogue in code.
 *
 * It **verifies** rather than writes, and that distinction is deliberate.
 * `packages/db/.../_grants` says, in as many words,
 * `REVOKE INSERT, UPDATE, DELETE ON core.permissions FROM hms_app`. The
 * application role is not allowed to author the list of things it may do — if it
 * were, a compromised API could grant itself authority and the least-privilege
 * split in `docs/04` §6 would be decorative. The catalogue is therefore written
 * by the migration/seed running as `hms_migrator`, and the running service only
 * checks that what it was given agrees with its own code.
 *
 * Drift is not a warning. `core.role_permissions` has a foreign key to this
 * table, so a key present in code but missing from the database cannot be granted
 * to anybody — every route guarded by it would deny every user, and the symptom
 * ("the ward list is empty for everyone") looks nothing like the cause. Failing
 * at boot turns a confusing outage into a clear one.
 */
@Injectable()
export class PermissionRegistryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PermissionRegistryService.name);

  constructor(private readonly db: DatabaseService) {}

  async onApplicationBootstrap(): Promise<void> {
    const { missingInDatabase, unknownInCode } = await this.verify();

    if (unknownInCode.length > 0) {
      // Not fatal: a key retired from code but still in the table is harmless
      // until something tries to grant it, and deleting it would cascade to
      // live role assignments during a deploy.
      this.logger.warn(
        `${unknownInCode.length} permission key(s) exist in the database but not in code (retired?): ${unknownInCode.slice(0, 5).join(', ')}${unknownInCode.length > 5 ? '…' : ''}`,
      );
    }

    if (missingInDatabase.length > 0) {
      throw new Error(
        `Permission catalogue drift: ${missingInDatabase.length} key(s) exist in code but not in core.permissions, ` +
          `so no role can be granted them and every route using them would deny all users. ` +
          `Run the database seed (\`pnpm --filter @vims/db seed\`) before starting the API. ` +
          `Missing: ${missingInDatabase.slice(0, 10).join(', ')}${missingInDatabase.length > 10 ? '…' : ''}`,
      );
    }

    this.logger.log(`permission catalogue verified: ${PERMISSION_CATALOGUE.length} keys present`);
  }

  async verify(): Promise<{ missingInDatabase: readonly string[]; unknownInCode: readonly string[] }> {
    const rows = await this.db.withoutTenant((tx) =>
      // `core.permissions` is one of the two deliberately tenant-less catalogues
      // (D-17), so reading it without a scope is by design, not by omission.
      tx.rows<{ key: string }>('SELECT key FROM core.permissions'),
    );

    const inDatabase = new Set(rows.map((r) => r.key));
    const inCode = new Set(PERMISSION_CATALOGUE.map((p) => p.key));

    return {
      missingInDatabase: [...inCode].filter((k) => !inDatabase.has(k)),
      unknownInCode: [...inDatabase].filter((k) => !inCode.has(k)),
    };
  }
}
