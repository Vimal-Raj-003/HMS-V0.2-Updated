import { assertRegisteredEvent } from '@vims/contracts';
import type { OutboxEvent } from '../../core/outbox/outbox.service.js';
import { mapInventoryDatabaseError } from '../inventory/inventory.common.js';

/**
 * The two shared helpers this module needs, and why one of them is imported.
 *
 * `mapInventoryDatabaseError` already translates every refusal Phase 4's
 * database can raise — the ledger's, the register's, the counter's — because
 * they are one migration and their messages were written together. Duplicating
 * the table here would give the same trigger two different wordings, and the one
 * a pharmacist saw would depend on which service happened to catch it. So the
 * pharmacy path wraps the same map rather than owning a second copy.
 *
 * This is a deliberate coupling between `modules/pharmacy` and
 * `modules/inventory`, and it is the same coupling `docs/01 §4` already sanctions
 * for `StockLedgerService`: dispensing is a stock movement, and the rules it must
 * obey belong to the ledger.
 */
export async function withPharmacyErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapInventoryDatabaseError(error);
  }
}

/**
 * Builds an OP-003 outbox event from the registry rather than from a literal.
 *
 * `rx.dispensed` is the one this exists for. It is what tells the prescriber the
 * patient actually left with the drug, what the portal shows, and what Phase 5
 * bills from. A mistyped type would be written happily, relayed happily and
 * consumed by nobody — and the failure would look exactly like a pharmacy that
 * never dispensed anything.
 */
export function pharmacyEvent(
  type: string,
  aggregateId: string,
  payload: Readonly<Record<string, unknown>>,
): OutboxEvent {
  const definition = assertRegisteredEvent(type);

  const parsed = definition.schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `Event "${type}" payload does not match its registered schema (docs/09 §4): ` +
        parsed.error.issues
          .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
          .join('; '),
    );
  }

  return {
    eventType: definition.type,
    aggregate: definition.aggregate,
    aggregateId,
    payload,
    schemaVersion: definition.schemaVersion,
    containsPhi: definition.containsPhi,
    retentionDays: definition.retentionDays,
  };
}

/** The schedules that may never leave a counter without a prescription. */
export const PRESCRIPTION_ONLY = new Set(['h', 'h1', 'x', 'ndps_narcotic', 'ndps_psychotropic']);

/** The schedules that need two authorising pharmacists. */
export const DUAL_AUTH_SCHEDULES = new Set(['ndps_narcotic', 'ndps_psychotropic']);

/** Which statutory register an item's schedule belongs in, or `null`. */
export function registerFor(
  schedule: string,
  isNarcotic: boolean,
): 'ndps' | 'schedule_x' | 'schedule_h1' | null {
  if (isNarcotic || schedule === 'ndps_narcotic' || schedule === 'ndps_psychotropic') return 'ndps';
  if (schedule === 'x') return 'schedule_x';
  if (schedule === 'h1') return 'schedule_h1';
  return null;
}

/** The Indian financial year of a date, as `controlled_drug_register.fy` wants it. */
export function financialYear(at: Date): string {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth() + 1;
  const startYear = month >= 4 ? year : year - 1;
  return `${String(startYear)}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}
