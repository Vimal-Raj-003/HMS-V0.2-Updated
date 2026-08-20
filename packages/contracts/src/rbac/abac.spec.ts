import { describe, expect, it } from 'vitest';
import { abacConditionsSchema, amountLimitSchema, timeWindowSchema } from './abac.js';

/**
 * `docs/05 §Model: RBAC + ABAC` enumerates the conditions; `EN-007 §3.3.3` adds
 * the scope arrays and `data_class_masks`. These schemas are what an administrator's
 * input is validated against before it becomes a policy decision, so the tests
 * below are mostly about what must be **rejected**: a malformed condition that
 * parses is a permission that silently does nothing.
 */

const BRANCH = '0194f2c0-0000-7000-8000-00000000000b';
const DEPARTMENT = '0194f2c0-0000-7000-8000-00000000000d';

describe('amount limit', () => {
  it('expresses ceilings as decimal strings, never as floats', () => {
    // primitives/money.ts exists because 0.1 + 0.2 !== 0.3; a discount ceiling
    // stored as a JS number would inherit exactly that problem.
    const parsed = amountLimitSchema.parse({ maxAmount: '25000.00', maxPercent: '25' });
    expect(parsed.maxAmount).toBe('25000.00');
    expect(parsed.maxPercent).toBe('25');
  });

  it('rejects a numeric ceiling outright', () => {
    expect(amountLimitSchema.safeParse({ maxAmount: 25000 }).success).toBe(false);
    expect(amountLimitSchema.safeParse({ maxPercent: 10 }).success).toBe(false);
  });

  it('rejects a ceiling with more precision than money has', () => {
    expect(amountLimitSchema.safeParse({ maxAmount: '25000.005' }).success).toBe(false);
    expect(amountLimitSchema.safeParse({ maxPercent: '12.555' }).success).toBe(false);
  });

  it('rejects a negative or non-numeric ceiling', () => {
    // A negative discount ceiling would be a permission to *increase* a bill.
    expect(amountLimitSchema.safeParse({ maxAmount: '-1.00' }).success).toBe(false);
    expect(amountLimitSchema.safeParse({ maxPercent: 'ten' }).success).toBe(false);
    expect(amountLimitSchema.safeParse({ maxAmount: '' }).success).toBe(false);
  });

  it('defaults to the safer combination when both ceilings are set', () => {
    // EN-038 §3.2: "25 % **or** ₹25 000, whichever is lower". The default must be
    // the lower of the two, never the higher.
    expect(amountLimitSchema.parse({ maxAmount: '25000.00', maxPercent: '25' }).combine).toBe(
      'whichever_is_lower',
    );
  });

  it('allows the other two combination rules to be named explicitly', () => {
    expect(amountLimitSchema.parse({ combine: 'whichever_is_higher' }).combine).toBe('whichever_is_higher');
    expect(amountLimitSchema.parse({ combine: 'both_must_pass' }).combine).toBe('both_must_pass');
    expect(amountLimitSchema.safeParse({ combine: 'either' }).success).toBe(false);
  });
});

describe('time window', () => {
  it('accepts a night-shift window that crosses midnight', () => {
    const parsed = timeWindowSchema.parse({ startTime: '22:00', endTime: '06:00', crossesMidnight: true });
    expect(parsed.crossesMidnight).toBe(true);
    expect(parsed.daysOfWeek).toEqual([]);
  });

  it('treats an empty weekday list as every day, not as no day', () => {
    // A window that matched nothing would deny the role its whole shift.
    expect(timeWindowSchema.parse({ startTime: '09:00', endTime: '17:00' }).daysOfWeek).toEqual([]);
  });

  it('requires both ends of the window', () => {
    expect(timeWindowSchema.safeParse({ startTime: '09:00' }).success).toBe(false);
    expect(timeWindowSchema.safeParse({ endTime: '17:00' }).success).toBe(false);
  });

  it('rejects a time that is not a real 24-hour clock reading', () => {
    for (const bad of ['24:00', '09:60', '9:00', '0900', '09:00:00', '', '09:0']) {
      expect(timeWindowSchema.safeParse({ startTime: bad, endTime: '17:00' }).success, bad).toBe(false);
    }
  });

  it('uses ISO weekdays 1–7 and rejects a zero-based day', () => {
    // Off-by-one here would roster a nurse on the wrong day.
    expect(
      timeWindowSchema.parse({ startTime: '09:00', endTime: '17:00', daysOfWeek: [1, 7] }).daysOfWeek,
    ).toEqual([1, 7]);
    expect(
      timeWindowSchema.safeParse({ startTime: '09:00', endTime: '17:00', daysOfWeek: [0] }).success,
    ).toBe(false);
    expect(
      timeWindowSchema.safeParse({ startTime: '09:00', endTime: '17:00', daysOfWeek: [8] }).success,
    ).toBe(false);
    expect(
      timeWindowSchema.safeParse({
        startTime: '09:00',
        endTime: '17:00',
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7, 1],
      }).success,
    ).toBe(false);
  });

  it('defaults crossesMidnight to false, so a window is same-day unless declared', () => {
    expect(timeWindowSchema.parse({ startTime: '09:00', endTime: '17:00' }).crossesMidnight).toBe(false);
  });
});

describe('abac conditions', () => {
  it('treats an empty condition set as "no narrowing", which is what RBAC alone means', () => {
    expect(abacConditionsSchema.parse({})).toEqual({});
  });

  it('accepts every scope-narrowing array as uuid lists', () => {
    const parsed = abacConditionsSchema.parse({
      branchIds: [BRANCH],
      departmentIds: [DEPARTMENT],
      wardIds: [BRANCH],
      unitIds: [DEPARTMENT],
    });
    expect(parsed.branchIds).toEqual([BRANCH]);
    expect(parsed.departmentIds).toEqual([DEPARTMENT]);
    expect(parsed.wardIds).toEqual([BRANCH]);
    expect(parsed.unitIds).toEqual([DEPARTMENT]);
  });

  it('rejects a scope entry that is not a uuid', () => {
    // A branch code such as "BLR-01" here would silently match no branch and
    // the role would quietly lose access rather than fail loudly.
    for (const field of ['branchIds', 'departmentIds', 'wardIds', 'unitIds']) {
      expect(abacConditionsSchema.safeParse({ [field]: ['BLR-01'] }).success, field).toBe(false);
      expect(abacConditionsSchema.safeParse({ [field]: BRANCH }).success, field).toBe(false);
    }
  });

  it('accepts each relationship gate as a boolean', () => {
    // docs/05 §Model names these five by name.
    const parsed = abacConditionsSchema.parse({
      ownPatientsOnly: true,
      careTeamOnly: true,
      ownDepartmentOnly: true,
      assignedWardOnly: true,
      ownQueueOnly: true,
    });
    expect(parsed.ownPatientsOnly).toBe(true);
    expect(parsed.careTeamOnly).toBe(true);
    expect(parsed.ownDepartmentOnly).toBe(true);
    expect(parsed.assignedWardOnly).toBe(true);
    expect(parsed.ownQueueOnly).toBe(true);
  });

  it('rejects a truthy string where a relationship gate is expected', () => {
    // `"false"` is truthy in JavaScript; coercing it would invert the gate.
    expect(abacConditionsSchema.safeParse({ ownPatientsOnly: 'false' }).success).toBe(false);
    expect(abacConditionsSchema.safeParse({ careTeamOnly: 1 }).success).toBe(false);
  });

  it('nests the amount limit and the time window with their own defaults', () => {
    const parsed = abacConditionsSchema.parse({
      amountLimit: { maxPercent: '10' },
      timeWindow: { startTime: '22:00', endTime: '06:00', crossesMidnight: true },
    });
    expect(parsed.amountLimit?.combine).toBe('whichever_is_lower');
    expect(parsed.timeWindow?.daysOfWeek).toEqual([]);
  });

  it('rejects an invalid nested amount limit instead of dropping it', () => {
    // Silently dropping it would leave the role with no ceiling at all.
    expect(abacConditionsSchema.safeParse({ amountLimit: { maxPercent: '110.555' } }).success).toBe(false);
  });

  it('carries the extra-friction gates the safety rules depend on', () => {
    // docs/05 §ABAC: requires_second_person (blood issue, narcotics);
    // EN-007 §3.3.3: ip_allowlist and device_bound for break-glass and admin roles.
    const parsed = abacConditionsSchema.parse({
      requiresSecondPerson: true,
      ipAllowlist: ['10.0.0.0/8', '203.0.113.7'],
      deviceBound: true,
    });
    expect(parsed.requiresSecondPerson).toBe(true);
    expect(parsed.ipAllowlist).toEqual(['10.0.0.0/8', '203.0.113.7']);
    expect(parsed.deviceBound).toBe(true);
  });

  it('accepts only the declared data classes for masking', () => {
    // docs/04 §4: identifiers masked by default in non-care roles. An unknown
    // class name would mask nothing while looking as if it did.
    const parsed = abacConditionsSchema.parse({ dataClassMasks: ['mobile', 'diagnosis', 'full_name'] });
    expect(parsed.dataClassMasks).toEqual(['mobile', 'diagnosis', 'full_name']);
    expect(abacConditionsSchema.safeParse({ dataClassMasks: ['name'] }).success).toBe(false);
    expect(abacConditionsSchema.safeParse({ dataClassMasks: ['MOBILE'] }).success).toBe(false);
  });

  it('covers every data class the specs enumerate', () => {
    expect(
      abacConditionsSchema.safeParse({
        dataClassMasks: ['mobile', 'address', 'aadhaar', 'abha', 'email', 'photo', 'diagnosis', 'full_name'],
      }).success,
    ).toBe(true);
  });
});
