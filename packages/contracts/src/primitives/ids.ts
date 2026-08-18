/**
 * Identifier primitives.
 *
 * `docs/03 §Table rules`: "PK: `id uuid` (UUIDv7, time-ordered → index-friendly).
 * Human IDs separately (`uhid`, `bill_no`)."
 *
 * UUIDv7 is generated in application code rather than by the database because
 * (a) Postgres 17 has no built-in `uuidv7()` (that arrives in 18 — docs/02 §1),
 * and (b) the service needs the id *before* the insert so it can be written into
 * the audit row and the outbox row in the same transaction.
 *
 * Time-ordering is the whole point: a random v4 primary key on a table taking
 * 800 000 audit rows a day scatters B-tree inserts across the whole index and
 * turns the hottest table in the system into a write-amplification problem.
 */
import { uuidv7 as generateUuidV7 } from 'uuidv7';

/** Branded UUID so a `HospitalId` can never be passed where a `UserId` belongs. */
declare const brand: unique symbol;
export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type Uuid = string;
export type HospitalId = Branded<Uuid, 'HospitalId'>;
export type BranchId = Branded<Uuid, 'BranchId'>;
export type GroupId = Branded<Uuid, 'GroupId'>;
export type UserId = Branded<Uuid, 'UserId'>;
export type RoleId = Branded<Uuid, 'RoleId'>;
export type SessionId = Branded<Uuid, 'SessionId'>;
export type DeviceId = Branded<Uuid, 'DeviceId'>;
export type PatientId = Branded<Uuid, 'PatientId'>;
export type EncounterId = Branded<Uuid, 'EncounterId'>;
export type AuditLogId = Branded<Uuid, 'AuditLogId'>;
export type OutboxEventId = Branded<Uuid, 'OutboxEventId'>;
export type NotificationId = Branded<Uuid, 'NotificationId'>;
export type WorkflowRequestId = Branded<Uuid, 'WorkflowRequestId'>;
export type FileId = Branded<Uuid, 'FileId'>;
export type CorrelationId = Branded<string, 'CorrelationId'>;
export type RequestId = Branded<string, 'RequestId'>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is Uuid {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isUuidV7(value: unknown): value is Uuid {
  return typeof value === 'string' && UUID_V7_RE.test(value);
}

/**
 * The id generator, injected everywhere rather than imported, because
 * `docs/09 §2` forbids ambient randomness in unit tests: "randomness from an
 * injected `IdGen`". A test substitutes a counting generator and gets stable ids.
 */
export interface IdGen {
  next(): Uuid;
}

export const uuidv7IdGen: IdGen = Object.freeze({
  next: (): Uuid => generateUuidV7(),
});

/** Convenience for call sites that legitimately have no injection point (seeds, migrations). */
export function newId(): Uuid {
  return generateUuidV7();
}

/** Typed casts — the only sanctioned way to brand an id read from the database. */
export function asId<B extends string>(value: Uuid): Branded<Uuid, B> {
  return value as Branded<Uuid, B>;
}

/**
 * Extract the millisecond timestamp encoded in a UUIDv7's first 48 bits.
 * Used by the audit-integrity job to detect a row whose id and `occurred_at`
 * disagree — one of the cheapest tamper signals available (EN-024 §3.4).
 */
export function uuidV7Timestamp(id: Uuid): Date {
  if (!isUuidV7(id)) {
    throw new Error(`Not a UUIDv7: ${id}`);
  }
  const hex = id.replace(/-/g, '').slice(0, 12);
  return new Date(Number(BigInt(`0x${hex}`)));
}

/**
 * Clock, injected for the same reason as `IdGen` (docs/09 §2: "time comes from
 * an injected `Clock`"). Every timestamp written to the database goes through
 * this, so the retention, escalation and SLA jobs are testable against a frozen
 * clock rather than by sleeping.
 */
export interface Clock {
  now(): Date;
  /** Epoch milliseconds — cheaper than allocating a Date in hot paths. */
  nowMs(): number;
}

export const systemClock: Clock = Object.freeze({
  now: (): Date => new Date(),
  nowMs: (): number => Date.now(),
});

export class FixedClock implements Clock {
  #current: number;

  constructor(at: Date | number) {
    this.#current = typeof at === 'number' ? at : at.getTime();
  }

  now(): Date {
    return new Date(this.#current);
  }

  nowMs(): number {
    return this.#current;
  }

  advance(ms: number): void {
    this.#current += ms;
  }

  set(at: Date | number): void {
    this.#current = typeof at === 'number' ? at : at.getTime();
  }
}
