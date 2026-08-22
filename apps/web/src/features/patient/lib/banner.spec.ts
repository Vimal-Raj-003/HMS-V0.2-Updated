import { describe, expect, it } from 'vitest';
import type { PatientAlertRow } from '../api/types';
import { bannerAlerts, toPatientIdentity } from './banner';
import { bannerFixture, patientFixture } from './__fixtures__/patient';

function alert(overrides: Partial<PatientAlertRow> = {}): PatientAlertRow {
  return {
    id: 'alert-1',
    type: 'custom',
    severity: 'moderate',
    label: 'Something',
    detail: null,
    acknowledged_at: null,
    ...overrides,
  };
}

describe('the banner’s flag row', () => {
  it('gives isolation and MLC their own slots rather than the generic alert row', () => {
    const patient = patientFixture({
      banner: bannerFixture({
        alerts: [
          alert({ id: 'i', type: 'isolation', label: 'Contact isolation' }),
          alert({ id: 'm', type: 'mlc', label: 'MLC', detail: '4471' }),
          alert({ id: 'v', type: 'vip', label: 'VIP' }),
        ],
      }),
    });
    const identity = toPatientIdentity(patient);
    expect(identity.isolation).toEqual({ type: 'Contact isolation' });
    expect(identity.mlc).toEqual({ number: '4471' });
    expect(identity.alerts?.map((entry) => entry.kind)).toEqual(['vip']);
  });

  it('drops the allergy mirror, because the allergy strip already shows it', () => {
    // `patient.alerts` mirrors allergies for banner speed (OP-001 §4). Rendering
    // both shows one allergy twice, which reads as two.
    expect(bannerAlerts([alert({ type: 'allergy', label: 'Penicillin' })])).toEqual([]);
  });

  it('renders an unmapped alert type as a generic flag rather than dropping it', () => {
    const [entry] = bannerAlerts([
      alert({ type: 'credit_block', label: 'Credit blocked', detail: 'Accounts' }),
    ]);
    expect(entry?.kind).toBe('other');
    expect(entry?.label).toBe('Credit blocked — Accounts');
  });
});

describe('the banner identity', () => {
  it('uses the server’s pre-formatted age and falls back only when it is absent', () => {
    expect(toPatientIdentity(patientFixture()).age).toBe('45 y');
    const noAge = patientFixture({ banner: bannerFixture({ age_display: '' }) });
    expect(toPatientIdentity(noAge, noAge.banner, new Date('2026-08-22T09:00:00.000Z')).age).toBe('45 y');
  });

  it('omits a blood group nobody has established rather than printing “unknown”', () => {
    const patient = patientFixture({ banner: bannerFixture({ blood_group: 'unknown' }) });
    expect(toPatientIdentity(patient).bloodGroup).toBeUndefined();
  });

  it('shows the payer only when somebody other than the patient is paying', () => {
    expect(toPatientIdentity(patientFixture({ payer_type: 'self' })).payer).toBeUndefined();
    expect(toPatientIdentity(patientFixture({ payer_type: 'insurance' })).payer).toBe('insurance');
  });

  it('carries the four-arm allergy state through, unflattened', () => {
    const patient = patientFixture({ banner: bannerFixture({ allergy_statement: 'not_recorded' }) });
    expect(toPatientIdentity(patient).allergies).toEqual({ kind: 'not-recorded' });
  });
});
