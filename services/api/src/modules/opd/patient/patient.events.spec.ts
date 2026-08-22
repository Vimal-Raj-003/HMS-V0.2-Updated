import { getEventDefinition } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { patientEvent } from './patient.events.js';

const PATIENT_A = '018f4b5c-0000-7000-8000-0000000000a1';
const PATIENT_B = '018f4b5c-0000-7000-8000-0000000000b2';
const USER = '018f4b5c-0000-7000-8000-0000000000c3';
const BRANCH = '018f4b5c-0000-7000-8000-0000000000d4';
const AT = '2026-08-22T09:15:00.000Z';

describe('patientEvent', () => {
  it('refuses an unregistered type instead of writing an event nobody consumes', () => {
    expect(() => patientEvent('patient.merge', PATIENT_A, {})).toThrow(/Unregistered event type/);
  });

  it('refuses a payload the registered schema does not accept', () => {
    expect(() => patientEvent('patient.registered', PATIENT_A, { patientId: PATIENT_A })).toThrow(
      /does not match its registered schema/,
    );
  });

  /**
   * The property the merge depends on. `patient.merged` is the only notice every
   * other module gets that a `patient_id` it holds is stale, and OP-001 §5 gives
   * them five minutes to re-point. A payload missing the victim UHID would leave
   * anything keyed on the printed identifier — a label, an external interface —
   * unable to act.
   */
  it('carries both ids and the victim UHID on patient.merged', () => {
    const event = patientEvent('patient.merged', PATIENT_A, {
      survivorId: PATIENT_A,
      victimId: PATIENT_B,
      victimUhid: 'BLRA00000042',
      mergedBy: USER,
      mergedAt: AT,
    });
    expect(event.payload).toMatchObject({
      survivorId: PATIENT_A,
      victimId: PATIENT_B,
      victimUhid: 'BLRA00000042',
    });

    expect(() =>
      patientEvent('patient.merged', PATIENT_A, {
        survivorId: PATIENT_A,
        victimId: PATIENT_B,
        mergedBy: USER,
        mergedAt: AT,
      }),
    ).toThrow(/does not match its registered schema/);
  });

  it('copies aggregate, PHI flag and retention from the registry, never from the call site', () => {
    const event = patientEvent('patient.registered', PATIENT_A, {
      patientId: PATIENT_A,
      uhid: 'BLRA00000042',
      branchId: BRANCH,
      channel: 'counter',
      registeredAt: AT,
    });
    const definition = getEventDefinition('patient.registered');

    expect(event.aggregate).toBe(definition?.aggregate);
    expect(event.containsPhi).toBe(true);
    expect(event.retentionDays).toBe(definition?.retentionDays);
    // A patient registration is part of the medical record's provenance and is
    // kept for the statutory retention period, not the outbox's 7-day default.
    expect(event.retentionDays).toBeGreaterThan(365);
  });

  it('accepts every event this module publishes', () => {
    const built = [
      patientEvent('patient.registered', PATIENT_A, {
        patientId: PATIENT_A,
        uhid: 'BLRA00000042',
        branchId: BRANCH,
        channel: 'counter',
        registeredAt: AT,
      }),
      patientEvent('patient.updated', PATIENT_A, {
        patientId: PATIENT_A,
        changedFields: ['mobile'],
        reason: 'Patient changed their number',
      }),
      patientEvent('patient.merged', PATIENT_A, {
        survivorId: PATIENT_A,
        victimId: PATIENT_B,
        victimUhid: 'BLRA00000043',
        mergedBy: USER,
        mergedAt: AT,
      }),
      patientEvent('patient.unmerged', PATIENT_A, {
        survivorId: PATIENT_A,
        victimId: PATIENT_B,
        unmergedBy: USER,
        reason: 'Merged the wrong pair',
      }),
    ];

    expect(built.map((e) => e.eventType)).toEqual([
      'patient.registered',
      'patient.updated',
      'patient.merged',
      'patient.unmerged',
    ]);
    expect(built.every((e) => e.containsPhi)).toBe(true);
  });

  /**
   * Recorded here rather than in the report alone, because the next person to
   * read this file will otherwise wonder why the duplicate path publishes
   * nothing.
   *
   * OP-001 §3.1 flags a suspected duplicate into the MRD queue, and the natural
   * announcement of that is `patient.duplicate_suspected` — which is **not** in
   * the registry in `packages/contracts`. This module does not invent it: an
   * event type that is not registered would be refused by `patientEvent` and,
   * were it forced through, relayed to no consumer. The dedupe queue row in
   * `patient.dedupe_candidates` is the durable record meanwhile, and the
   * in-app notification EN-037 owes the MRD officer (OP-001 §11) is what the
   * event would have driven.
   */
  it('has no patient.duplicate_suspected to publish', () => {
    expect(getEventDefinition('patient.duplicate_suspected')).toBeUndefined();
  });
});
