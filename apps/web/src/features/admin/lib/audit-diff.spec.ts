import { describe, expect, it } from 'vitest';
import type { AuditRow } from '../api/types';
import { auditFieldChanges, isDenial, toAuditDiffEntry } from './audit-diff';
import { humaniseFieldName, renderAuditValue } from './format';

function row(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: '0192f0e2-0000-7000-8000-000000000001',
    occurred_at: '2026-08-18T08:37:00.000Z',
    actor_user_id: '0192f0e2-0000-7000-8000-0000000000aa',
    actor_role: 'hospital_admin',
    impersonator_user_id: null,
    entity: 'core.roles',
    row_id: null,
    business_key: 'ward_pharmacist',
    action: 'config_change',
    patient_id: null,
    data_class: 'operational',
    sensitivity: 'normal',
    result: 'success',
    denial_reason: null,
    reason_code: null,
    reason_text: 'Pharmacy restructure',
    before: { name: 'Ward pharmacist', permissions: ['rx.read'] },
    after: { name: 'Ward pharmacist (day)', permissions: ['rx.read', 'rx.dispense'] },
    changed_fields: ['name', 'permissions'],
    row_count: 1,
    trace_id: '0192f0e2-aaaa-7000-8000-000000000001',
    api_route: 'PATCH /api/v1/admin/roles/:id',
    sealed_at: '2026-08-18T09:00:00.000Z',
    ...overrides,
  };
}

describe('the before-and-after diff', () => {
  it('uses the fields the writer named, in that order', () => {
    const changes = auditFieldChanges(row());
    expect(changes.map((c) => c.field)).toEqual(['Name', 'Permissions']);
    expect(changes[0]?.before).toBe('Ward pharmacist');
    expect(changes[0]?.after).toBe('Ward pharmacist (day)');
  });

  it('renders an array as a readable list rather than as JSON', () => {
    const changes = auditFieldChanges(row());
    expect(changes[1]?.after).toBe('rx.read, rx.dispense');
  });

  it('reconstructs the field list when the row carries none, so a create still shows its contents', () => {
    const changes = auditFieldChanges(
      row({ changed_fields: [], before: null, after: { key: 'ward_pharmacist', name: 'Ward pharmacist' } }),
    );
    expect(changes.map((c) => c.field)).toEqual(['Key', 'Name']);
    expect(changes[0]?.before).toBeNull();
    expect(changes[0]?.after).toBe('ward_pharmacist');
  });

  it('keeps a field the writer named even when the value did not move — the log is evidence', () => {
    const changes = auditFieldChanges(
      row({ changed_fields: ['name'], before: { name: 'Same' }, after: { name: 'Same' } }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.before).toBe('Same');
  });

  it('reports an absent value as null so it renders as "not set" rather than the word null', () => {
    expect(renderAuditValue(null)).toBeNull();
    expect(renderAuditValue('')).toBeNull();
    expect(renderAuditValue(0)).toBe('0');
    expect(renderAuditValue(false)).toBe('false');
  });

  it('turns a column name into a sentence rather than showing the DB word', () => {
    expect(humaniseFieldName('valid_to')).toBe('Valid to');
    expect(humaniseFieldName('homeWorkspace')).toBe('Home workspace');
  });
});

describe('the viewer entry', () => {
  it('carries the actor, the role, the reason and the seal state', () => {
    const entry = toAuditDiffEntry(row());
    expect(entry.actorRole).toBe('hospital_admin');
    expect(entry.reason).toBe('Pharmacy restructure');
    expect(entry.hashChainVerified).toBe(true);
    expect(entry.at).toMatch(/^\d{2}-\d{2}-\d{4} \d{2}:\d{2}$/);
  });

  it('shows an unsealed row as unsealed rather than as verified', () => {
    expect(toAuditDiffEntry(row({ sealed_at: null })).hashChainVerified).toBe(false);
  });

  it('names a system actor rather than leaving the byline blank', () => {
    expect(toAuditDiffEntry(row({ actor_user_id: null })).actorName).toBe('System');
  });

  it('resolves an actor to a name when the console knows one', () => {
    const entry = toAuditDiffEntry(row(), { resolveActor: () => 'Dr A. Menon' });
    expect(entry.actorName).toBe('Dr A. Menon');
  });

  it('leaves the IP and device fields unset rather than filling them with the route', () => {
    const entry = toAuditDiffEntry(row());
    expect(entry.ipAddress).toBeUndefined();
    expect(entry.device).toBeUndefined();
  });

  it('renders the hospital time zone, not the browser one', () => {
    // 08:37 UTC is 14:07 in Asia/Kolkata; a viewer in London must still read the
    // time the ward staff saw.
    expect(toAuditDiffEntry(row()).at).toBe('18-08-2026 14:07');
  });

  it('recognises a refusal', () => {
    expect(isDenial(row())).toBe(false);
    expect(isDenial(row({ result: 'denied' }))).toBe(true);
  });
});
