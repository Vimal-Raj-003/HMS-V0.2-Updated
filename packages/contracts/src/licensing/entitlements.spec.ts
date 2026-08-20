import { describe, expect, it } from 'vitest';
import {
  CLINICAL_SAFETY_EXEMPT_KEYS,
  DEGRADATION_LADDER,
  ENFORCEMENT_POINTS,
  ENTITLEMENT_CACHE_MAX_AGE_SECONDS,
  ENTITLEMENT_KEYS,
  ENTITLEMENT_PROPAGATION_SLA_SECONDS,
  NEVER_DEGRADED_CAPABILITIES,
  emergencyHeadroom,
  getEnforcementPoint,
} from './entitlements.js';

/**
 * `EN-040 §1`: "commercial state may restrict *administrative and convenience*
 * functions, but it must **never** block clinical care, patient safety functions,
 * or a hospital's access to its own data."
 *
 * `EN-040 §14 AC-20` requires an automated test asserting every
 * `clinicalSafetyExempt` enforcement point stays exempt at every tier, and that
 * the build fails if one is not. This file is that test.
 */

const exempt = new Set(CLINICAL_SAFETY_EXEMPT_KEYS);

describe('enforcement points', () => {
  it('registers every key exactly once', () => {
    expect(new Set(ENTITLEMENT_KEYS).size).toBe(ENTITLEMENT_KEYS.length);
    expect(ENTITLEMENT_KEYS).toHaveLength(ENFORCEMENT_POINTS.length);
  });

  it('names every key as <family>.<...> in lower snake segments', () => {
    for (const point of ENFORCEMENT_POINTS) {
      expect(point.key, `"${point.key}" is not a valid entitlement key shape`).toMatch(
        /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/,
      );
    }
  });

  it('gives every key a family that matches the prefix it is filed under', () => {
    // `capacity.seats.admin` filed as a `quota` would be counted by the wrong
    // meter and would degrade at the wrong tier.
    for (const point of ENFORCEMENT_POINTS) {
      const prefix = point.key.split('.')[0];
      if (prefix === 'capacity') expect(point.family, point.key).toBe('capacity');
      if (prefix === 'quota') expect(point.family, point.key).toBe('quota');
      if (prefix === 'module' || prefix === 'feature') expect(point.family, point.key).toBe('feature');
    }
  });

  it('resolves a registered key and returns nothing for an unregistered one', () => {
    expect(getEnforcementPoint('module.audit.enabled')?.family).toBe('feature');
    expect(getEnforcementPoint('module.does_not_exist.enabled')).toBeUndefined();
  });

  it('writes every refusal message in words a nurse can act on', () => {
    // EN-040 §3.2: "never 'SKU' or 'entitlement'".
    for (const point of ENFORCEMENT_POINTS) {
      expect(point.message.length, `${point.key} has no usable message`).toBeGreaterThan(10);
      expect(point.message, `${point.key} message uses commercial jargon`).not.toMatch(
        /SKU|entitlement|licence key|license key|403|402/i,
      );
      expect(point.message.endsWith('.'), `${point.key} message should be a sentence`).toBe(true);
      expect(point.description.length, `${point.key} has no description`).toBeGreaterThan(5);
    }
  });

  it('never offers an upgrade call-to-action for something that is always on', () => {
    // "Audit logging is always active — Ask about Enterprise Group" would be a lie.
    for (const point of ENFORCEMENT_POINTS.filter((p) => p.clinicalSafetyExempt)) {
      expect(point.upgradeCta, `${point.key} must not be sold`).toBeUndefined();
    }
  });
});

describe('the clinical-safety exemption', () => {
  it('marks the platform capabilities a lapsed subscription must never touch', () => {
    // EN-040 §5: authenticate staff, audit what they do, identify a patient,
    // print, back up, and export the hospital's own data.
    for (const key of [
      'module.admin.enabled',
      'module.audit.enabled',
      'module.barcode.enabled',
      'module.print.enabled',
      'module.backup_dr.enabled',
      'module.security.enabled',
      'feature.data_export.enabled',
    ]) {
      expect(CLINICAL_SAFETY_EXEMPT_KEYS, `${key} must be exempt`).toContain(key);
    }
  });

  it('fails open for every exempt point and closed for every commercial one', () => {
    // EN-040 §3.2: "fails open for clinical modules and fails closed for
    // administrative/commercial features — never the reverse."
    for (const point of ENFORCEMENT_POINTS) {
      expect(point.failOpen, `${point.key} has the wrong fail direction`).toBe(point.clinicalSafetyExempt);
    }
  });

  it('never lets a degradation tier restrict an exempt key', () => {
    // EN-040 §14 AC-20. This is the assertion the whole file exists for: a future
    // PR that adds an exempt key to a tier's restricted list fails the build here.
    for (const tier of DEGRADATION_LADDER) {
      for (const capability of tier.restrictedCapabilities) {
        expect(
          exempt.has(capability),
          `tier ${tier.tier} (${tier.status}) restricts clinical-safety-exempt key "${capability}"`,
        ).toBe(false);
      }
    }
  });

  it('restricts only keys that are actually registered', () => {
    // An unregistered key in a tier restricts nothing — a silent no-op that would
    // read as enforcement in a review.
    const registered = new Set(ENTITLEMENT_KEYS);
    for (const tier of DEGRADATION_LADDER) {
      for (const capability of tier.restrictedCapabilities) {
        expect(registered.has(capability), `tier ${tier.tier} restricts unknown key "${capability}"`).toBe(
          true,
        );
      }
    }
  });

  it('lists the capabilities that are never degraded at any tier', () => {
    // EN-040 §3.5 enumerates these by name; they are the contract later phases
    // must satisfy, so a shrinking list is a regression.
    for (const capability of [
      'allergy_alerts',
      'interaction_alerts',
      'critical_value_alerts',
      'critical_alert_escalation',
      'mar_safety_checks',
      'blood_crossmatch',
      'emergency_department',
      'operation_theatre',
      'audit_logging',
      'backup_jobs',
      'data_export',
      'patient_identification',
    ]) {
      expect(NEVER_DEGRADED_CAPABILITIES, `${capability} must never be degraded`).toContain(capability);
    }
    expect(new Set(NEVER_DEGRADED_CAPABILITIES).size).toBe(NEVER_DEGRADED_CAPABILITIES.length);
  });
});

describe('the degradation ladder', () => {
  it('defines tiers 0 to 4 exactly once each, in order', () => {
    expect(DEGRADATION_LADDER.map((t) => t.tier)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(DEGRADATION_LADDER.map((t) => t.status)).size).toBe(DEGRADATION_LADDER.length);
  });

  it('restricts nothing at all while the subscription is active', () => {
    const active = DEGRADATION_LADDER.find((t) => t.tier === 0);
    expect(active?.status).toBe('active');
    expect(active?.restrictedCapabilities).toEqual([]);
  });

  it('never releases a module restriction as the tier worsens', () => {
    // A module restricted at tier 2 that worked again at tier 3 would be a ladder
    // that is not a ladder — and an escape hatch from an unpaid bill.
    const moduleRestrictions = DEGRADATION_LADDER.filter((t) => t.tier >= 2).map((t) => ({
      tier: t.tier,
      keys: t.restrictedCapabilities.filter((k) => k.startsWith('module.')),
    }));
    for (let i = 1; i < moduleRestrictions.length; i += 1) {
      const previous = moduleRestrictions[i - 1]!;
      const current = moduleRestrictions[i]!;
      for (const capability of previous.keys) {
        expect(current.keys, `tier ${current.tier} released "${capability}"`).toContain(capability);
      }
      expect(current.keys.length).toBeGreaterThanOrEqual(previous.keys.length);
    }
  });

  it('describes both what still works and what is restricted, in plain language', () => {
    // EN-040 §8: the customer-facing preview screen renders these verbatim.
    for (const tier of DEGRADATION_LADDER) {
      expect(tier.label.length, `tier ${tier.tier} has no label`).toBeGreaterThan(2);
      expect(tier.stillWorks.length, `tier ${tier.tier} does not say what still works`).toBeGreaterThan(5);
      expect(tier.restricted.length, `tier ${tier.tier} does not say what is restricted`).toBeGreaterThan(5);
    }
  });

  it('keeps clinical work and data export available right down to suspension', () => {
    // EN-040 §3.5 / §5: a billing dispute must never become a patient-safety event.
    const soft = DEGRADATION_LADDER.find((t) => t.status === 'soft_degraded')!;
    expect(soft.stillWorks).toMatch(/clinical/i);
    expect(soft.stillWorks).toMatch(/billing/i);
    const hard = DEGRADATION_LADDER.find((t) => t.status === 'hard_degraded')!;
    expect(hard.stillWorks).toMatch(/export/i);
    const suspended = DEGRADATION_LADDER.find((t) => t.status === 'suspended')!;
    expect(suspended.stillWorks).toMatch(/export/i);
  });
});

describe('emergency headroom', () => {
  it('is the greater of five sessions and ten per cent of the limit', () => {
    // EN-040 §3.3.4: "+10 % or 5 sessions, whichever is greater".
    expect(emergencyHeadroom(100)).toBe(10);
    expect(emergencyHeadroom(40)).toBe(5);
    expect(emergencyHeadroom(50)).toBe(5);
    expect(emergencyHeadroom(51)).toBe(6);
  });

  it('rounds a fractional ten per cent up, never down', () => {
    // Rounding down is how a mass-casualty surge loses its last clinician login.
    expect(emergencyHeadroom(55)).toBe(6);
    expect(emergencyHeadroom(201)).toBe(21);
  });

  it('still gives five sessions to a hospital with a tiny or zero limit', () => {
    expect(emergencyHeadroom(0)).toBe(5);
    expect(emergencyHeadroom(1)).toBe(5);
  });

  it('never returns less than the limit-independent floor', () => {
    for (const limit of [0, 1, 7, 25, 49, 200, 2000]) {
      expect(emergencyHeadroom(limit), `limit ${limit}`).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('propagation and caching constants', () => {
  it('keeps a cached entitlement document valid for the documented 72 hours', () => {
    // EN-040 §3.2: an on-prem hospital whose link to the licence service is down
    // must keep working for three days before the fail direction applies.
    expect(ENTITLEMENT_CACHE_MAX_AGE_SECONDS).toBe(72 * 60 * 60);
  });

  it('holds every service to a 30-second propagation SLA', () => {
    // EN-040 §7.
    expect(ENTITLEMENT_PROPAGATION_SLA_SECONDS).toBe(30);
    expect(ENTITLEMENT_PROPAGATION_SLA_SECONDS).toBeLessThan(ENTITLEMENT_CACHE_MAX_AGE_SECONDS);
  });
});
