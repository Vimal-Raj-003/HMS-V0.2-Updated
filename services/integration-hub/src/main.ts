/**
 * Entry point.
 *
 * There is nothing to serve yet, and pretending otherwise would be worse than
 * saying so: EN-017's long-lived duties are the MLLP/ASTM listeners (Phase 3),
 * the webhook endpoint (EN-026), the BullMQ delivery workers and the health
 * cron — none of which exist in Phase 0. So `main` does the one useful thing it
 * can: it builds the hub exactly as a service would, prints the adapter
 * catalogue it is able to instantiate, verifies the database is reachable, and
 * exits. A deploy that cannot construct the hub therefore fails here rather than
 * on the first message.
 */
import { Pool } from 'pg';
import { IntegrationHub } from './hub.js';
import { createLogger } from './logger.js';

async function main(): Promise<number> {
  const logger = createLogger();
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    logger.error({}, 'DATABASE_URL is not set');
    return 1;
  }

  const pool = new Pool({ connectionString, max: 4, application_name: 'vims-integration-hub' });
  const hub = new IntegrationHub({ pool, logger });

  try {
    await pool.query('SELECT 1');
    logger.info(
      {
        adapters: hub.adapters.list().map((m) => `${m.id}@${m.version}`),
        liveConnectors: 0,
      },
      'integration hub constructed; no live connectors in Phase 0 (EN-017 §3.8)',
    );
    return 0;
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, 'database unreachable');
    return 1;
  } finally {
    await hub.shutdown();
    await pool.end();
  }
}

const code = await main();
process.exitCode = code;
