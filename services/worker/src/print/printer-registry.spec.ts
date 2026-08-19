import { describe, expect, it } from 'vitest';

import {
  AGENT_HEARTBEAT_STALE_MS,
  PrintScopeError,
  printerUnavailableReason,
  rankMappings,
  withPrintScope,
  type PrintMappingRow,
} from './printer-registry.js';
import type { PrinterStatus, PrinterTarget } from './types.js';

const BRANCH = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const WORKSTATION = '33333333-3333-4333-8333-333333333333';
const COUNTER = '44444444-4444-4444-8444-444444444444';

function printer(name: string, overrides: Partial<PrinterTarget> = {}): PrinterTarget {
  return {
    printerId: `printer-${name}`,
    name,
    kind: 'thermal',
    driverMode: 'raw_escpos',
    paper: 'thermal_80mm',
    status: 'online',
    agentId: null,
    agentStatus: null,
    agentLastHeartbeatAt: null,
    branchId: BRANCH,
    ...overrides,
  };
}

function mapping(
  scopeType: PrintMappingRow['scopeType'],
  scopeId: string | null,
  name: string,
  priority = 100,
): PrintMappingRow {
  return {
    mappingId: `map-${scopeType}-${name}`,
    scopeType,
    scopeId,
    templateKey: 'token.escpos.v1',
    copies: 1,
    priority,
    options: {},
    printer: printer(name),
  };
}

const CONTEXT = {
  hospitalId: '55555555-5555-4555-8555-555555555555',
  branchId: BRANCH,
  docType: 'token',
  userId: USER,
  workstationId: WORKSTATION,
  counterId: COUNTER,
};

describe('mapping specificity (EN-005 §3.2)', () => {
  it('prefers the user override over the counter, and the counter over the branch default', () => {
    const ranked = rankMappings(
      [
        mapping('branch', BRANCH, 'branch-default'),
        mapping('counter', COUNTER, 'counter-3'),
        mapping('user', USER, 'my-printer'),
        mapping('workstation', WORKSTATION, 'desk-12'),
      ],
      CONTEXT,
    );
    expect(ranked.map((row) => row.printer.name)).toEqual([
      'my-printer',
      'desk-12',
      'counter-3',
      'branch-default',
    ]);
  });

  it('drops mappings whose scope does not match this request', () => {
    const ranked = rankMappings(
      [
        mapping('counter', '99999999-9999-4999-8999-999999999999', 'other-counter'),
        mapping('branch', BRANCH, 'branch-default'),
      ],
      CONTEXT,
    );
    expect(ranked.map((row) => row.printer.name)).toEqual(['branch-default']);
  });

  it('treats a NULL scope id on a branch mapping as "the default for this branch"', () => {
    const ranked = rankMappings([mapping('branch', null, 'branch-default')], CONTEXT);
    expect(ranked).toHaveLength(1);
  });

  it('ignores a user mapping when the request has no user (an event-driven auto-print)', () => {
    const ranked = rankMappings([mapping('user', USER, 'my-printer'), mapping('branch', null, 'fallback')], {
      ...CONTEXT,
      userId: null,
    });
    expect(ranked.map((row) => row.printer.name)).toEqual(['fallback']);
  });

  it('breaks a specificity tie on priority, lowest first', () => {
    const ranked = rankMappings(
      [mapping('branch', null, 'second', 200), mapping('branch', null, 'first', 10)],
      CONTEXT,
    );
    expect(ranked.map((row) => row.printer.name)).toEqual(['first', 'second']);
  });
});

describe('printer readiness', () => {
  const cases: ReadonlyArray<readonly [PrinterStatus, string | null]> = [
    ['online', null],
    ['unknown', null],
    ['toner_low', null],
    ['offline', 'printer_offline'],
    ['paper_out', 'paper_out'],
    ['door_open', 'door_open'],
    ['error', 'printer_error'],
  ];

  it.each(cases)('maps printer status %s to %s', (status, expected) => {
    expect(printerUnavailableReason(printer('p', { status }))).toBe(expected);
  });

  /** `toner_low` is a *warning*: refusing to print would stop a ward for nothing. */
  it('still prints when toner is low', () => {
    expect(printerUnavailableReason(printer('p', { status: 'toner_low' }))).toBeNull();
  });

  it('treats a stale agent heartbeat as the agent being down', () => {
    const now = new Date('2026-08-20T09:00:00Z');
    const fresh = new Date(now.getTime() - 10_000);
    const stale = new Date(now.getTime() - AGENT_HEARTBEAT_STALE_MS - 1);

    const agented = (beat: Date): PrinterTarget =>
      printer('p', { agentId: 'agent-1', agentStatus: 'online', agentLastHeartbeatAt: beat });

    expect(printerUnavailableReason(agented(fresh), now)).toBeNull();
    expect(printerUnavailableReason(agented(stale), now)).toBe('agent_down');
  });

  it('treats a never-seen or offline agent as down', () => {
    expect(
      printerUnavailableReason(
        printer('p', { agentId: 'a', agentStatus: 'online', agentLastHeartbeatAt: null }),
      ),
    ).toBe('agent_down');
    expect(
      printerUnavailableReason(
        printer('p', { agentId: 'a', agentStatus: 'offline', agentLastHeartbeatAt: new Date() }),
      ),
    ).toBe('agent_down');
  });
});

describe('tenancy scope', () => {
  /**
   * The scope values become a `uuid[]` literal, so they are validated before
   * they are interpolated — the one place in the system where an unvalidated
   * string would decide which hospital's data is visible.
   */
  it('refuses a non-UUID hospital or branch id', async () => {
    const pool = {
      connect: () => Promise.reject(new Error('must not connect')),
    } as unknown as Parameters<typeof withPrintScope>[0];

    await expect(
      withPrintScope(pool, { hospitalId: 'not-a-uuid', branchIds: [] }, () => Promise.resolve(1)),
    ).rejects.toBeInstanceOf(PrintScopeError);

    await expect(
      withPrintScope(pool, { hospitalId: CONTEXT.hospitalId, branchIds: ["'; DROP TABLE"] }, () =>
        Promise.resolve(1),
      ),
    ).rejects.toBeInstanceOf(PrintScopeError);
  });
});
