import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CONSOLE_COMPONENT_CATALOGUE } from '@vims/contracts';
import { DatabaseService } from '../../core/db/database.service.js';

/**
 * Verifies at boot that `mdm.console_components` matches the catalogue in code.
 *
 * The same shape, and the same argument, as `PermissionRegistryService`. The
 * migration revokes INSERT, UPDATE and DELETE on the table from `hms_app`,
 * because an application that could add a component key could then register a
 * console naming it — and the trigger that makes "register a console as data,
 * no code deploy" safe would be checking the attacker's own row.
 *
 * Drift in the missing direction is fatal, for the reason F1 exists at all: a
 * component in code but absent from the table cannot be named by any console,
 * so a hospital admin composing one is told their own build does not ship a tab
 * it plainly does. The symptom — "the ophthalmology console will not save" —
 * looks nothing like the cause, and failing at boot turns a confusing afternoon
 * into a clear one.
 */
@Injectable()
export class ConsoleComponentRegistryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConsoleComponentRegistryService.name);

  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async onApplicationBootstrap(): Promise<void> {
    const { missingInDatabase, unknownInCode } = await this.verify();

    if (unknownInCode.length > 0) {
      // Not fatal. A key retired from code but still in the table is exactly
      // what `deprecated` is for: consoles already registered against it keep
      // resolving, and the trigger refuses only new registrations naming it.
      this.logger.warn(
        `${unknownInCode.length} console component(s) exist in the database but not in code (retired?): ` +
          `${unknownInCode.slice(0, 5).join(', ')}${unknownInCode.length > 5 ? '…' : ''}`,
      );
    }

    if (missingInDatabase.length > 0) {
      throw new Error(
        `Console component catalogue drift: ${missingInDatabase.length} component(s) exist in code but not in ` +
          `mdm.console_components, so no console can name them and registering one would be refused by the ` +
          `database with a message about a component this build plainly ships. ` +
          `Run the database seed (\`pnpm --filter @vims/db seed\`) before starting the API. ` +
          `Missing: ${missingInDatabase.slice(0, 10).join(', ')}${missingInDatabase.length > 10 ? '…' : ''}`,
      );
    }

    this.logger.log(
      `console component catalogue verified: ${CONSOLE_COMPONENT_CATALOGUE.length} component(s) present`,
    );
  }

  async verify(): Promise<{ missingInDatabase: readonly string[]; unknownInCode: readonly string[] }> {
    const rows = await this.db.withoutTenant((tx) =>
      // A code catalogue, not tenant data — read without a scope by design, the
      // same as `core.permissions` (D-17).
      tx.rows<{ key: string }>('SELECT key FROM mdm.console_components'),
    );

    const inDatabase = new Set(rows.map((r) => r.key));
    const inCode = new Set(CONSOLE_COMPONENT_CATALOGUE.map((c) => c.key));

    return {
      missingInDatabase: [...inCode].filter((k) => !inDatabase.has(k)),
      unknownInCode: [...inDatabase].filter((k) => !inCode.has(k)),
    };
  }
}
