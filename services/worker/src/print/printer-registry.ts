import { TENANT_GUC } from '@vims/db/tenancy';
import type { Pool, PoolClient } from 'pg';

import {
  MAPPING_SPECIFICITY,
  NOT_READY_PRINTER_STATUSES,
  type PrintAgentStatus,
  type PrintMappingScope,
  type PrinterDriverMode,
  type PrinterKind,
  type PrinterStatus,
  type PrinterTarget,
  type PrinterUnavailableReason,
} from './types.js';

/**
 * Printer registry resolution — `EN-005 §3.2`: which *physical* device does
 * "the OPD token printer at branch X" mean right now?
 *
 * The answer is data, not code: `core.print_mappings` rows say "for this doc
 * type, at this scope, use this printer", and the most specific matching row
 * wins. Everything below exists to make that resolution (a) tenant-safe and
 * (b) testable without a printer.
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class PrintScopeError extends Error {
  override readonly name = 'PrintScopeError';
}

function assertUuid(value: string, field: string): string {
  if (!UUID_RE.test(value)) {
    throw new PrintScopeError(
      `${field} must be a UUID; refusing to build a tenancy scope from an unvalidated value.`,
    );
  }
  return value;
}

/**
 * The tenancy scope a print operation runs under.
 *
 * There is no user for most of this work — the worker prints because an event
 * said to, not because someone clicked — so `userId` is optional and
 * `app.user_id` is simply left unset. That is *not* an RLS bypass:
 * `app.hospital_id` and `app.branch_ids` are still stamped, so every read stays
 * inside one tenant and one branch set, and a bug fails closed (sees nothing)
 * rather than open.
 */
export interface PrintTenantScope {
  readonly hospitalId: string;
  readonly branchIds: readonly string[];
  readonly userId?: string | undefined;
}

/**
 * Runs `fn` in a transaction with the tenancy GUCs applied.
 *
 * `set_config(name, value, is_local => true)` — never a built `SET LOCAL`
 * string. The values are bind parameters, so a tenant id can never be
 * concatenated into the one statement that decides which hospital's data is
 * visible, and `is_local` makes the setting die at COMMIT so a PgBouncer-pooled
 * connection cannot carry one tenant's scope into the next request
 * (`packages/db/src/tenancy.ts`, `docs/07 §4`). ESLint bans the string form.
 */
export async function withPrintScope<T>(
  pool: Pool,
  scope: PrintTenantScope,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertUuid(scope.hospitalId, 'hospitalId');
  const branchIds = scope.branchIds.map((id, index) => assertUuid(id, `branchIds[${index}]`));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', [TENANT_GUC.hospitalId, scope.hospitalId]);
    await client.query('SELECT set_config($1, $2, true)', [TENANT_GUC.scope, 'branch']);
    if (branchIds.length > 0) {
      await client.query('SELECT set_config($1, $2, true)', [
        TENANT_GUC.branchIds,
        `{${branchIds.join(',')}}`,
      ]);
    }
    if (scope.userId !== undefined) {
      await client.query('SELECT set_config($1, $2, true)', [
        TENANT_GUC.userId,
        assertUuid(scope.userId, 'userId'),
      ]);
    }

    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; the original error is the useful one.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Where a print request came from — the scopes a mapping row can target. */
export interface PrinterResolutionContext {
  readonly hospitalId: string;
  readonly branchId: string;
  readonly docType: string;
  readonly userId?: string | null | undefined;
  readonly workstationId?: string | null | undefined;
  readonly counterId?: string | null | undefined;
  readonly locationId?: string | null | undefined;
  readonly departmentId?: string | null | undefined;
}

export interface PrintMappingRow {
  readonly mappingId: string;
  readonly scopeType: PrintMappingScope;
  readonly scopeId: string | null;
  readonly templateKey: string | null;
  readonly copies: number;
  readonly priority: number;
  readonly options: Record<string, unknown>;
  readonly printer: PrinterTarget;
}

export interface PrinterResolution {
  readonly mappingId: string;
  readonly scopeType: PrintMappingScope;
  readonly templateKey: string | null;
  readonly copies: number;
  readonly options: Record<string, unknown>;
  readonly printer: PrinterTarget;
}

function contextIdFor(scopeType: PrintMappingScope, context: PrinterResolutionContext): string | null {
  switch (scopeType) {
    case 'user':
      return context.userId ?? null;
    case 'workstation':
      return context.workstationId ?? null;
    case 'counter':
      return context.counterId ?? null;
    case 'location':
      return context.locationId ?? null;
    case 'department':
      return context.departmentId ?? null;
    case 'branch':
      return context.branchId;
  }
}

/**
 * Keep the mappings that apply to this request and order them by specificity.
 *
 * Pure on purpose. The specificity order of `EN-005 §3.2` is the rule most
 * likely to be got subtly wrong (a branch default quietly beating a user's own
 * choice), and it is worth a unit test that needs no database, no printer and
 * no fixture.
 *
 * A `branch`-scoped row may carry either the branch id or NULL as its scope id —
 * "the default for this branch" is expressible both ways and admins write both.
 */
export function rankMappings(
  rows: readonly PrintMappingRow[],
  context: PrinterResolutionContext,
): readonly PrintMappingRow[] {
  return rows
    .filter((row) => {
      const expected = contextIdFor(row.scopeType, context);
      if (row.scopeType === 'branch') return row.scopeId === null || row.scopeId === expected;
      return expected !== null && row.scopeId === expected;
    })
    .slice()
    .sort((a, b) => {
      const bySpecificity = MAPPING_SPECIFICITY[a.scopeType] - MAPPING_SPECIFICITY[b.scopeType];
      if (bySpecificity !== 0) return bySpecificity;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.printer.name.localeCompare(b.printer.name);
    });
}

/**
 * Why this printer cannot take the job right now, or `null` if it can.
 *
 * The agent heartbeat is `EN-005 §3.1`'s 30 s; four missed beats is the point at
 * which "the network blipped" becomes "the PC at that counter is off". Treating
 * a stale heartbeat as *down* rather than *unknown* is what routes the job to a
 * working printer instead of into a silent hole.
 */
export const AGENT_HEARTBEAT_STALE_MS = 120_000;

export function printerUnavailableReason(
  printer: PrinterTarget,
  now: Date = new Date(),
  staleAfterMs: number = AGENT_HEARTBEAT_STALE_MS,
): PrinterUnavailableReason | null {
  if (NOT_READY_PRINTER_STATUSES.has(printer.status)) {
    switch (printer.status) {
      case 'paper_out':
        return 'paper_out';
      case 'door_open':
        return 'door_open';
      case 'error':
        return 'printer_error';
      case 'offline':
      case 'unknown':
      case 'online':
      case 'toner_low':
        // Reached only for 'offline': the set above is what NOT_READY holds.
        // Listed exhaustively so adding a status to the enum is a build error
        // rather than a printer that silently reports itself ready.
        return 'printer_offline';
    }
  }

  if (printer.agentId !== null) {
    if (printer.agentStatus !== 'online') return 'agent_down';
    const beat = printer.agentLastHeartbeatAt;
    if (beat === null || now.getTime() - beat.getTime() > staleAfterMs) return 'agent_down';
  }

  return null;
}

interface MappingQueryRow {
  mapping_id: string;
  scope_type: string;
  scope_id: string | null;
  template_key: string | null;
  copies: number;
  priority: number;
  options: Record<string, unknown> | null;
  printer_id: string;
  printer_name: string;
  printer_kind: string;
  driver_mode: string;
  paper: string;
  printer_status: string;
  printer_branch_id: string;
  agent_id: string | null;
  agent_status: string | null;
  agent_last_heartbeat_at: Date | null;
  [column: string]: unknown;
}

function toMappingRow(row: MappingQueryRow): PrintMappingRow {
  const printer: PrinterTarget = {
    printerId: row.printer_id,
    name: row.printer_name,
    kind: row.printer_kind as PrinterKind,
    driverMode: row.driver_mode as PrinterDriverMode,
    paper: row.paper,
    status: row.printer_status as PrinterStatus,
    agentId: row.agent_id,
    agentStatus: row.agent_status === null ? null : (row.agent_status as PrintAgentStatus),
    agentLastHeartbeatAt: row.agent_last_heartbeat_at,
    branchId: row.printer_branch_id,
  };
  return {
    mappingId: row.mapping_id,
    scopeType: row.scope_type as PrintMappingScope,
    scopeId: row.scope_id,
    templateKey: row.template_key,
    copies: row.copies,
    priority: row.priority,
    options: row.options ?? {},
    printer,
  };
}

const MAPPING_SQL = `
  SELECT m.id             AS mapping_id,
         m.scope_type     AS scope_type,
         m.scope_id       AS scope_id,
         m.template_key   AS template_key,
         m.copies         AS copies,
         m.priority       AS priority,
         m.options        AS options,
         p.id             AS printer_id,
         p.name           AS printer_name,
         p.kind           AS printer_kind,
         p.driver_mode    AS driver_mode,
         p.paper          AS paper,
         p.status         AS printer_status,
         p.branch_id      AS printer_branch_id,
         a.id             AS agent_id,
         a.status         AS agent_status,
         a.last_heartbeat_at AS agent_last_heartbeat_at
    FROM core.print_mappings m
    JOIN core.print_printers p ON p.id = m.printer_id
    LEFT JOIN core.print_agents a ON a.id = p.agent_id
   WHERE m.hospital_id = $1
     AND m.branch_id = $2
     AND m.doc_type = $3
     AND m.deleted_at IS NULL
     AND p.deleted_at IS NULL
     AND p.active = true
`;

/**
 * Every mapping that could serve this document type in this branch.
 *
 * SQL filters by tenant, branch, document type and printer liveness — the parts
 * an index can serve — and `rankMappings()` applies the specificity rule in
 * TypeScript, because the scope id it compares against comes from six different
 * request fields and expressing that as a `CASE` would trade a unit-testable
 * rule for an untestable one.
 */
export async function loadPrintMappings(
  client: PoolClient,
  context: PrinterResolutionContext,
): Promise<readonly PrintMappingRow[]> {
  const { rows } = await client.query<MappingQueryRow>(MAPPING_SQL, [
    context.hospitalId,
    context.branchId,
    context.docType,
  ]);
  return rows.map(toMappingRow);
}

/** The single printer this request should use, or `null` if nothing is mapped. */
export async function resolvePrinter(
  client: PoolClient,
  context: PrinterResolutionContext,
): Promise<PrinterResolution | null> {
  const ranked = rankMappings(await loadPrintMappings(client, context), context);
  const winner = ranked[0];
  if (winner === undefined) return null;
  return {
    mappingId: winner.mappingId,
    scopeType: winner.scopeType,
    templateKey: winner.templateKey,
    copies: winner.copies,
    options: winner.options,
    printer: winner.printer,
  };
}

/**
 * The "print elsewhere" list of `docs/01 §7`.
 *
 * When a counter's printer is out of paper the job must not fail — it waits, and
 * the user is offered somewhere else to send it. That offer is only useful if
 * the alternatives are actually *ready*, so unavailable devices are filtered out
 * here rather than in the UI.
 */
export async function listAlternativePrinters(
  client: PoolClient,
  context: PrinterResolutionContext,
  excludePrinterId: string | null = null,
  now: Date = new Date(),
): Promise<readonly PrinterTarget[]> {
  const mappings = await loadPrintMappings(client, context);
  const seen = new Set<string>();
  const alternatives: PrinterTarget[] = [];

  for (const mapping of rankMappings(mappings, context)) {
    const printer = mapping.printer;
    if (printer.printerId === excludePrinterId) continue;
    if (seen.has(printer.printerId)) continue;
    if (printerUnavailableReason(printer, now) !== null) continue;
    seen.add(printer.printerId);
    alternatives.push(printer);
  }

  return alternatives;
}

const PRINTER_SQL = `
  SELECT p.id             AS printer_id,
         p.name           AS printer_name,
         p.kind           AS printer_kind,
         p.driver_mode    AS driver_mode,
         p.paper          AS paper,
         p.status         AS printer_status,
         p.branch_id      AS printer_branch_id,
         a.id             AS agent_id,
         a.status         AS agent_status,
         a.last_heartbeat_at AS agent_last_heartbeat_at
    FROM core.print_printers p
    LEFT JOIN core.print_agents a ON a.id = p.agent_id
   WHERE p.id = $1
     AND p.deleted_at IS NULL
`;

/**
 * Load one printer by id — the path a job that already names its printer takes
 * (a redirect, a reprint "to this printer", an agent callback).
 *
 * RLS still applies: an id from another tenant simply returns nothing, which is
 * why this can safely take an id straight off the job row.
 */
export async function findPrinter(client: PoolClient, printerId: string): Promise<PrinterTarget | null> {
  const { rows } = await client.query<MappingQueryRow>(PRINTER_SQL, [printerId]);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    printerId: row.printer_id,
    name: row.printer_name,
    kind: row.printer_kind as PrinterKind,
    driverMode: row.driver_mode as PrinterDriverMode,
    paper: row.paper,
    status: row.printer_status as PrinterStatus,
    agentId: row.agent_id,
    agentStatus: row.agent_status === null ? null : (row.agent_status as PrintAgentStatus),
    agentLastHeartbeatAt: row.agent_last_heartbeat_at,
    branchId: row.printer_branch_id,
  };
}
