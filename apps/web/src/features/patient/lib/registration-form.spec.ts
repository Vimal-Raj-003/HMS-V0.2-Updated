import { describe, expect, it } from 'vitest';
import {
  ageInYears,
  emptyRegistrationForm,
  toRegisterRequest,
  validateRegistration,
  type RegistrationFormState,
} from './registration-form';

/**
 * The desk's rules, asserted where they live.
 *
 * The one that matters most is the last block: **there is no Aadhaar field, and
 * no code path that can put an Aadhaar number in the request.** OP-001 §5 and the
 * Aadhaar Act allow only a hash and the last four, produced by a licensed e-KYC
 * path that is not this screen, and `registerPatientSchema` accepts nothing of the
 * sort. A regression here is a statutory problem, not a UI one.
 */

const NOW = new Date('2026-08-22T09:00:00.000Z');

function usable(overrides: Partial<RegistrationFormState> = {}): RegistrationFormState {
  return {
    ...emptyRegistrationForm(),
    firstName: 'Ramesh',
    lastName: 'Sharma',
    gender: 'male',
    mobile: '9845012345',
    dob: '1981-04-12',
    ...overrides,
  };
}

describe('what the desk refuses before asking the server', () => {
  it('accepts the mandatory minimum: a name, a sex, a mobile and a basis for age', () => {
    expect(validateRegistration(usable(), NOW)).toEqual({});
  });

  it('refuses a patient with no name', () => {
    expect(validateRegistration(usable({ firstName: '  ' }), NOW)['firstName']).toContain('name');
  });

  it('refuses a phone number too short to dial', () => {
    expect(validateRegistration(usable({ mobile: '984' }), NOW)['mobile']).toContain('area or country code');
  });

  it('refuses a date of birth in the future', () => {
    expect(validateRegistration(usable({ dob: '2030-01-01' }), NOW)['dob']).toContain('future');
  });

  it('accepts an age-only registration and refuses one with no age at all', () => {
    expect(validateRegistration(usable({ ageBasis: 'age', dob: '', ageYears: '62' }), NOW)).toEqual({});
    const empty = validateRegistration(usable({ ageBasis: 'age', dob: '' }), NOW);
    expect(empty['ageYears']).toContain('years, months or days');
  });

  it('requires a payer reference for a corporate, insurance or scheme patient', () => {
    for (const payerType of ['corporate', 'insurance', 'scheme']) {
      const errors = validateRegistration(usable({ payerType }), NOW);
      expect(errors['payerRef'], payerType).toContain('employee number');
    }
    expect(validateRegistration(usable({ payerType: 'self' }), NOW)['payerRef']).toBeUndefined();
  });

  it('requires a guardian for a patient under eighteen, and only for one', () => {
    const child = usable({ dob: '2015-01-01' });
    expect(validateRegistration(child, NOW)['emergencyName']).toContain('guardian');

    const withGuardian = usable({
      dob: '2015-01-01',
      emergencyName: 'Meena Sharma',
      emergencyPhone: '9845012345',
      emergencyIsGuardian: true,
    });
    expect(validateRegistration(withGuardian, NOW)['emergencyName']).toBeUndefined();

    // A contact who is not marked as the guardian does not satisfy the rule: the
    // API refuses the save, and DPDP Rules 2025 want a named responsible adult.
    const contactOnly = usable({
      dob: '2015-01-01',
      emergencyName: 'A Neighbour',
      emergencyPhone: '9845012345',
    });
    expect(validateRegistration(contactOnly, NOW)['emergencyName']).toContain('guardian');
  });

  it('refuses an unexplained “unable to assess” allergy statement', () => {
    const vague = usable({ allergy: { kind: 'unable-to-assess', reason: 'dunno' } });
    expect(validateRegistration(vague, NOW)['allergy']).toContain('why');

    const explained = usable({
      allergy: { kind: 'unable-to-assess', reason: 'Patient unconscious, no attendant present' },
    });
    expect(validateRegistration(explained, NOW)['allergy']).toBeUndefined();
  });

  it('refuses to save allergy entries this phase cannot store, rather than dropping them silently', () => {
    const withEntries = usable({
      allergy: {
        kind: 'known',
        entries: [
          {
            id: 'a1',
            allergen: { display: 'Penicillin', category: 'drug' },
            reactions: { kind: 'not-documented' },
            severity: 'severe',
            criticality: 'high',
            verification: { kind: 'unverified' },
          },
        ],
      },
    });
    expect(validateRegistration(withEntries, NOW)['allergy']).toContain('clinical record');
  });

  it('requires only the last four digits of a photo ID', () => {
    expect(validateRegistration(usable({ idLast4: '12345' }), NOW)['idLast4']).toContain('last four');
    expect(validateRegistration(usable({ idLast4: '1234' }), NOW)['idLast4']).toBeUndefined();
  });
});

describe('age', () => {
  it('is computed from the date of birth, not rounded up on the birthday eve', () => {
    expect(ageInYears(usable({ dob: '1981-04-12' }), NOW)).toBe(45);
    expect(ageInYears(usable({ dob: '1981-08-23' }), NOW)).toBe(44);
    expect(ageInYears(usable({ dob: '1981-08-22' }), NOW)).toBe(45);
  });

  it('falls back through years, months and days for an age-only registration', () => {
    expect(ageInYears(usable({ ageBasis: 'age', dob: '', ageYears: '7' }), NOW)).toBe(7);
    expect(ageInYears(usable({ ageBasis: 'age', dob: '', ageMonths: '30' }), NOW)).toBe(2);
    expect(ageInYears(usable({ ageBasis: 'age', dob: '', ageDays: '10' }), NOW)).toBe(0);
  });
});

describe('the request the desk sends', () => {
  it('omits blank optional fields rather than sending empty strings the schema rejects', () => {
    const request = toRegisterRequest(usable());
    expect(request).not.toHaveProperty('email');
    expect(request).not.toHaveProperty('middleName');
    expect(request).not.toHaveProperty('address');
    expect(request.contacts).toEqual([]);
  });

  it('sends a date of birth or an age, never both', () => {
    expect(toRegisterRequest(usable())).toMatchObject({ dob: '1981-04-12' });
    const byAge = toRegisterRequest(usable({ ageBasis: 'age', dob: '1981-04-12', ageYears: '45' }));
    expect(byAge).not.toHaveProperty('dob');
    expect(byAge).toMatchObject({ ageYears: 45 });
  });

  it('marks the emergency contact as the guardian when it is one', () => {
    const request = toRegisterRequest(
      usable({
        emergencyName: 'Meena Sharma',
        emergencyPhone: '9845012345',
        emergencyRelation: 'mother',
        emergencyIsGuardian: true,
      }),
    );
    expect(request.contacts).toEqual([
      {
        kind: 'guardian',
        name: 'Meena Sharma',
        phone: '9845012345',
        isGuardian: true,
        isPrimary: true,
        relationshipCode: 'mother',
      },
    ]);
  });

  it('translates the three client-settable allergy statements and never invents the fourth', () => {
    expect(toRegisterRequest(usable()).allergy).toEqual({ statement: 'not_recorded' });
    expect(
      toRegisterRequest(
        usable({ allergy: { kind: 'none-known', assertedBy: 'A. Clerk', assertedOn: '22-08-2026' } }),
      ).allergy,
    ).toEqual({ statement: 'none_known' });
    expect(
      toRegisterRequest(usable({ allergy: { kind: 'unable-to-assess', reason: 'No shared language' } }))
        .allergy,
    ).toEqual({ statement: 'unable_to_assess', unableReason: 'No shared language' });
  });

  it('never sends a `known` statement, because only the database may assert it', () => {
    const request = toRegisterRequest(
      usable({
        allergy: {
          kind: 'known',
          entries: [
            {
              id: 'a1',
              allergen: { display: 'Penicillin', category: 'drug' },
              reactions: { kind: 'not-documented' },
              severity: 'severe',
              criticality: 'high',
              verification: { kind: 'unverified' },
            },
          ],
        },
      }),
    );
    expect(request).not.toHaveProperty('allergy');
  });

  it('carries the duplicate override only when one was given', () => {
    expect(toRegisterRequest(usable())).not.toHaveProperty('overrideDuplicate');
    const overridden = toRegisterRequest(usable(), {
      overrideDuplicate: { acknowledgedPatientIds: ['p1'], reason: 'Different mother and address' },
    });
    expect(overridden.overrideDuplicate).toEqual({
      acknowledgedPatientIds: ['p1'],
      reason: 'Different mother and address',
    });
  });

  it('sends the address as a whole once any part of it is filled in', () => {
    const form = usable();
    const request = toRegisterRequest({
      ...form,
      address: { ...form.address, pincode: '560034', city: 'Bengaluru', stateCode: 'KA' },
    });
    expect(request.address).toEqual({
      countryCode: 'IN',
      pincode: '560034',
      city: 'Bengaluru',
      state: 'KA',
    });
  });

  it('contains nothing that could carry an Aadhaar number, under any key', () => {
    const form = usable({
      idTypeCode: 'passport',
      idLast4: '4471',
      abhaNumber: '12345678901234',
      emergencyName: 'Meena',
      emergencyPhone: '9845012345',
    });
    const request = toRegisterRequest(form);
    const serialised = JSON.stringify(request).toLowerCase();
    expect(serialised).not.toContain('aadhaar');
    expect(serialised).not.toContain('aadhar');
    expect(Object.keys(request).some((key) => key.toLowerCase().includes('aadha'))).toBe(false);
    // The only identity digits that leave this screen are the last four of a
    // non-Aadhaar photo ID.
    expect(request.idLast4).toBe('4471');
  });
});
