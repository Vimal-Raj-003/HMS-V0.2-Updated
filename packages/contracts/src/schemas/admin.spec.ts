import { describe, expect, it } from 'vitest';
import {
  assignRoleRequestSchema,
  auditSearchQuerySchema,
  branchKindSchema,
  breakGlassAccessRequestSchema,
  breakGlassReviewRequestSchema,
  cloneBranchConfigRequestSchema,
  createBranchRequestSchema,
  createNumberingSeriesRequestSchema,
  createRoleRequestSchema,
  createUserRequestSchema,
  deactivateUserRequestSchema,
  deviceKindSchema,
  listUsersQuerySchema,
  numberingPreviewResponseSchema,
  numberingResetPolicySchema,
  pairDeviceRequestSchema,
  personNameSchema,
  policySimulateRequestSchema,
  policySimulateResponseSchema,
  professionalDetailsSchema,
  putFeatureFlagRequestSchema,
  putSettingRequestSchema,
  settingScopeSchema,
  smokeTestResultSchema,
  startImpersonationRequestSchema,
  updateRoleRequestSchema,
  updateUserRequestSchema,
  userStatusSchema,
  userTypeSchema,
} from './admin.js';

/**
 * Admin console DTOs (EN-007 §6, EN-041 §6). Every schema here guards something a
 * hospital administrator can do to the whole tenant at once — create a login,
 * change who can do what, define an invoice series, open a branch — so the tests
 * are about the shapes that must be **refused**.
 */

const UUID = '0194f2c0-0000-7000-8000-000000000001';
const UUID_2 = '0194f2c0-0000-7000-8000-000000000002';

const name = { family: 'Menon', given: 'Anita' };
const validUser = {
  username: 'a.menon',
  name,
  roleAssignments: [{ roleId: UUID, branchId: UUID_2 }],
};

describe('user creation', () => {
  it('accepts the minimum a usable staff account needs', () => {
    const parsed = createUserRequestSchema.parse(validUser);
    expect(parsed.type).toBe('staff');
    expect(parsed.inviteVia).toBe('email');
    // An unspecified scope is an empty ABAC condition set, not "no restriction
    // recorded" — the policy service must always receive an object.
    expect(parsed.roleAssignments[0]?.scope).toEqual({});
  });

  it('refuses a user with no role, who would land on an empty workspace', () => {
    const result = createUserRequestSchema.safeParse({ ...validUser, roleAssignments: [] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/at least one role/i);
  });

  it('refuses a username with characters that break a login field or a URL', () => {
    for (const username of ['a menon', 'a/menon', 'a@menon', 'ab', 'x'.repeat(65), '']) {
      expect(createUserRequestSchema.safeParse({ ...validUser, username }).success, username).toBe(false);
    }
    expect(createUserRequestSchema.safeParse({ ...validUser, username: 'a.menon_2-x' }).success).toBe(true);
  });

  it('normalises the contact details through the shared auth primitives', () => {
    const parsed = createUserRequestSchema.parse({
      ...validUser,
      email: '  A.Menon@Example.COM ',
      mobile: '+91 98765 43210',
    });
    expect(parsed.email).toBe('a.menon@example.com');
    expect(parsed.mobile).toBe('9876543210');
    expect(createUserRequestSchema.safeParse({ ...validUser, mobile: '1234567890' }).success).toBe(false);
  });

  it('requires both parts of a person name, because documents print both', () => {
    // docs/06 §4.2: the family name is emphasised in the patient banner.
    expect(personNameSchema.safeParse({ family: 'Menon', given: 'Anita' }).success).toBe(true);
    expect(personNameSchema.safeParse({ family: 'Menon' }).success).toBe(false);
    expect(personNameSchema.safeParse({ family: '   ', given: 'Anita' }).success).toBe(false);
    expect(personNameSchema.parse({ family: ' Menon ', given: 'Anita' }).family).toBe('Menon');
  });

  it('carries the registration number that every prescription must print', () => {
    // NMC norms; the signature file is an approval-gated change (EN-007 §3.2.3).
    expect(
      professionalDetailsSchema.safeParse({
        registrationNo: 'KMC-45219',
        council: 'Karnataka Medical Council',
        signatureFileId: UUID,
      }).success,
    ).toBe(true);
    expect(professionalDetailsSchema.safeParse({ signatureFileId: 'signature.png' }).success).toBe(false);
    expect(professionalDetailsSchema.safeParse({}).success).toBe(true);
  });

  it('validates the ABAC scope of each role assignment rather than trusting it', () => {
    expect(
      createUserRequestSchema.safeParse({
        ...validUser,
        roleAssignments: [{ roleId: UUID, branchId: null, scope: { amountLimit: { maxPercent: '10' } } }],
      }).success,
    ).toBe(true);
    expect(
      createUserRequestSchema.safeParse({
        ...validUser,
        roleAssignments: [{ roleId: UUID, branchId: null, scope: { amountLimit: { maxPercent: 10 } } }],
      }).success,
    ).toBe(false);
  });

  it('requires an offset-bearing validity window on a temporary elevation', () => {
    expect(
      createUserRequestSchema.safeParse({
        ...validUser,
        roleAssignments: [
          { roleId: UUID, branchId: null, validFrom: '2026-08-17T00:00:00.000Z', validTo: null },
        ],
      }).success,
    ).toBe(true);
    expect(
      createUserRequestSchema.safeParse({
        ...validUser,
        roleAssignments: [{ roleId: UUID, branchId: null, validFrom: '2026-08-17' }],
      }).success,
    ).toBe(false);
  });

  it('knows every kind and every lifecycle state a login can have', () => {
    expect(userTypeSchema.options).toEqual(['staff', 'external', 'partner', 'device', 'service', 'patient']);
    expect(userStatusSchema.options).toEqual(['invited', 'active', 'locked', 'suspended', 'deactivated']);
    expect(userTypeSchema.safeParse('admin').success).toBe(false);
  });
});

describe('user update and deactivation', () => {
  it('never lets an update rewrite the username, the roles or the invitation', () => {
    // Rewriting a username silently re-points every audit row a human would
    // search by; role changes go through the reviewed assign endpoint instead.
    const parsed = updateUserRequestSchema.parse({
      version: 3,
      name,
      username: 'someone.else',
      roleAssignments: [],
    });
    expect(Object.hasOwn(parsed, 'username')).toBe(false);
    expect(Object.hasOwn(parsed, 'roleAssignments')).toBe(false);
    expect(Object.hasOwn(parsed, 'inviteVia')).toBe(false);
  });

  it('requires the version, so a concurrent edit is a conflict rather than a silent overwrite', () => {
    expect(updateUserRequestSchema.safeParse({ name }).success).toBe(false);
    expect(updateUserRequestSchema.safeParse({ version: -1 }).success).toBe(false);
    expect(updateUserRequestSchema.safeParse({ version: 0 }).success).toBe(true);
  });

  it('requires a real reason to deactivate, because it is recorded in the audit log', () => {
    expect(deactivateUserRequestSchema.safeParse({ reason: 'Left the hospital on 31 July.' }).success).toBe(
      true,
    );
    expect(deactivateUserRequestSchema.safeParse({ reason: 'na' }).success).toBe(false);
    expect(deactivateUserRequestSchema.safeParse({}).success).toBe(false);
  });

  it('lets pending approvals be reassigned to a named user', () => {
    // EN-038 §3.5: otherwise the leaver's queue silently stalls.
    expect(
      deactivateUserRequestSchema.safeParse({ reason: 'Left the hospital.', reassignApprovalsToUserId: UUID })
        .success,
    ).toBe(true);
    expect(
      deactivateUserRequestSchema.safeParse({
        reason: 'Left the hospital.',
        reassignApprovalsToUserId: 'a.menon',
      }).success,
    ).toBe(false);
  });
});

describe('user listing', () => {
  it('coerces the query string and caps an interactive page at 100', () => {
    // docs/07 §4: 25 default, 100 max interactive.
    const parsed = listUsersQuerySchema.parse({});
    expect(parsed.limit).toBe(25);
    expect(listUsersQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    expect(listUsersQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listUsersQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('bounds the dormant-account window to something a decade can hold', () => {
    // EN-007 §10 hygiene report.
    expect(listUsersQuerySchema.parse({ noLoginSinceDays: '90' }).noLoginSinceDays).toBe(90);
    expect(listUsersQuerySchema.safeParse({ noLoginSinceDays: '3651' }).success).toBe(false);
    expect(listUsersQuerySchema.safeParse({ noLoginSinceDays: '0' }).success).toBe(false);
  });

  it('rejects a status filter that is not a real status', () => {
    expect(listUsersQuerySchema.safeParse({ status: 'archived' }).success).toBe(false);
    expect(listUsersQuerySchema.safeParse({ branchId: 'BLR' }).success).toBe(false);
  });
});

describe('roles', () => {
  const validRole = {
    key: 'ward_pharmacist',
    name: 'Ward pharmacist',
    description: 'Dispenses against ward indents.',
    permissions: ['admin.user.read'],
    homeWorkspace: 'pharmacy',
  };

  it('accepts a role cloned from a system template', () => {
    // EN-007 §3.3.2: cloning rather than starting blank is the recommended path.
    const parsed = createRoleRequestSchema.parse({ ...validRole, templateKey: 'pharmacy_incharge' });
    expect(parsed.abacDefaults).toEqual({});
    expect(parsed.templateKey).toBe('pharmacy_incharge');
  });

  it('refuses a role key that is not lower snake_case', () => {
    // The key ends up in permission traces, seeds and the matrix fixture.
    for (const key of ['WardPharmacist', 'ward pharmacist', 'ward-pharmacist', '2ward', 'ab']) {
      expect(createRoleRequestSchema.safeParse({ ...validRole, key }).success, key).toBe(false);
    }
  });

  it('requires a home workspace, or the role has nowhere to land', () => {
    expect(createRoleRequestSchema.safeParse({ ...validRole, homeWorkspace: '' }).success).toBe(false);
    const { homeWorkspace: _h, ...withoutWorkspace } = validRole;
    expect(createRoleRequestSchema.safeParse(withoutWorkspace).success).toBe(false);
  });

  it('validates the ABAC defaults rather than accepting free-form JSON', () => {
    expect(
      createRoleRequestSchema.safeParse({ ...validRole, abacDefaults: { branchIds: ['BLR'] } }).success,
    ).toBe(false);
    expect(
      createRoleRequestSchema.safeParse({ ...validRole, abacDefaults: { requiresSecondPerson: true } })
        .success,
    ).toBe(true);
  });

  it('demands a reason on every role edit and refuses to rename the key', () => {
    // EN-007 §5: a role edit changes who can do what.
    const parsed = updateRoleRequestSchema.parse({
      version: 2,
      reason: 'Adds ward indent dispensing.',
      key: 'other',
    });
    expect(Object.hasOwn(parsed, 'key')).toBe(false);
    expect(updateRoleRequestSchema.safeParse({ version: 2 }).success).toBe(false);
    expect(updateRoleRequestSchema.safeParse({ version: 2, reason: 'fix' }).success).toBe(false);
  });

  it('demands a justification on every role assignment', () => {
    expect(
      assignRoleRequestSchema.safeParse({
        roleId: UUID,
        branchId: null,
        justification: 'Covering the night shift.',
      }).success,
    ).toBe(true);
    expect(assignRoleRequestSchema.safeParse({ roleId: UUID, branchId: null }).success).toBe(false);
    expect(
      assignRoleRequestSchema.safeParse({ roleId: UUID, branchId: null, justification: 'ok' }).success,
    ).toBe(false);
  });

  it('models the effective-permission simulator with a rule trace', () => {
    // EN-007 §3.3.5: "shows allowed actions and why" — the trace is the point.
    expect(
      policySimulateRequestSchema.safeParse({
        userId: UUID,
        action: 'bill.discount.approve',
        resource: { type: 'bill', id: 'B-1', branchId: UUID_2, amount: '2500.00', percent: '12.50' },
      }).success,
    ).toBe(true);
    // Money in a policy question is a decimal string, never a float.
    expect(
      policySimulateRequestSchema.safeParse({
        userId: UUID,
        action: 'bill.discount.approve',
        resource: { type: 'bill', amount: 2500 },
      }).success,
    ).toBe(false);
    expect(
      policySimulateResponseSchema.safeParse({
        allowed: false,
        reason: 'amount_limit_exceeded',
        trace: ['role ok', 'ceiling 10%'],
        obligations: [],
      }).success,
    ).toBe(true);
    expect(
      policySimulateResponseSchema.safeParse({ allowed: true, reason: null, obligations: [] }).success,
    ).toBe(false);
  });
});

describe('settings and feature flags', () => {
  it('always states the scope a setting is written at', () => {
    expect(settingScopeSchema.options).toEqual(['hospital', 'branch', 'department', 'user']);
    expect(
      putSettingRequestSchema.safeParse({
        key: 'session.idle_timeout_min',
        scope: 'hospital',
        scopeId: null,
        value: 15,
      }).success,
    ).toBe(true);
    expect(
      putSettingRequestSchema.safeParse({ key: 'session.idle_timeout_min', scopeId: null, value: 15 })
        .success,
    ).toBe(false);
    expect(
      putSettingRequestSchema.safeParse({
        key: 'session.idle_timeout_min',
        scope: 'tenant',
        scopeId: null,
        value: 15,
      }).success,
    ).toBe(false);
  });

  it('requires the scope id key to be present, even when it is null', () => {
    // A missing `scopeId` is ambiguous between "hospital-wide" and "forgot to send".
    expect(
      putSettingRequestSchema.safeParse({ key: 'ui.default_theme', scope: 'user', value: 'dark' }).success,
    ).toBe(false);
  });

  it('bounds a flag rollout to a percentage and lets it expire', () => {
    expect(
      putFeatureFlagRequestSchema.safeParse({ key: 'module.sso.enabled', enabled: true, rolloutPct: 50 })
        .success,
    ).toBe(true);
    expect(
      putFeatureFlagRequestSchema.safeParse({ key: 'module.sso.enabled', enabled: true, rolloutPct: 101 })
        .success,
    ).toBe(false);
    expect(
      putFeatureFlagRequestSchema.safeParse({ key: 'module.sso.enabled', enabled: true, rolloutPct: -1 })
        .success,
    ).toBe(false);
    expect(
      putFeatureFlagRequestSchema.safeParse({
        key: 'module.sso.enabled',
        enabled: false,
        expiresAt: '2026-12-31T00:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(putFeatureFlagRequestSchema.safeParse({ key: 'module.sso.enabled' }).success).toBe(false);
  });
});

describe('numbering series', () => {
  const validSeries = {
    key: 'BILL_OP',
    scope: 'branch',
    branchId: UUID,
    pattern: '{BR}/{FY}/{SEQ:6}',
    gapless: true,
    resetPolicy: 'fy',
  };

  it('accepts the worked example from docs/03', () => {
    const parsed = createNumberingSeriesRequestSchema.parse(validSeries);
    expect(parsed.startValue).toBe(0);
    expect(parsed.gapless).toBe(true);
  });

  it('refuses a pattern with no sequence token, which would repeat one number forever', () => {
    expect(
      createNumberingSeriesRequestSchema.safeParse({ ...validSeries, pattern: '{BR}/{FY}' }).success,
    ).toBe(false);
    expect(
      createNumberingSeriesRequestSchema.safeParse({ ...validSeries, pattern: '{BR}/{FY}/{SEQ}' }).success,
    ).toBe(false);
  });

  it('makes gaplessness an explicit choice, never a default', () => {
    // docs/03: gapless trades throughput for a statutory guarantee.
    const { gapless: _g, ...withoutGapless } = validSeries;
    expect(createNumberingSeriesRequestSchema.safeParse(withoutGapless).success).toBe(false);
  });

  it('refuses a series key that is not upper SNAKE_CASE', () => {
    for (const key of ['bill_op', 'Bill_Op', 'BILL-OP', '1BILL', 'B']) {
      expect(createNumberingSeriesRequestSchema.safeParse({ ...validSeries, key }).success, key).toBe(false);
    }
  });

  it('offers exactly the five reset policies a financial year needs', () => {
    expect(numberingResetPolicySchema.options).toEqual(['fy', 'year', 'month', 'day', 'never']);
    expect(
      createNumberingSeriesRequestSchema.safeParse({ ...validSeries, resetPolicy: 'quarter' }).success,
    ).toBe(false);
  });

  it('refuses a negative start value', () => {
    expect(createNumberingSeriesRequestSchema.safeParse({ ...validSeries, startValue: -1 }).success).toBe(
      false,
    );
  });

  it('previews the next number and a sample, so an admin sees the shape before committing', () => {
    expect(
      numberingPreviewResponseSchema.safeParse({
        key: 'BILL_OP',
        pattern: '{BR}/{FY}/{SEQ:6}',
        currentValue: 41,
        nextNumber: 'BLR/2026-27/000042',
        sample: ['BLR/2026-27/000042', 'BLR/2026-27/000043'],
        fy: '2026-27',
      }).success,
    ).toBe(true);
  });
});

describe('devices', () => {
  it('upper-cases a pairing code the way it is printed on the device', () => {
    const parsed = pairDeviceRequestSchema.parse({
      pairingCode: ' a1b2c3 ',
      name: 'ER kiosk 1',
      kind: 'kiosk',
      branchId: UUID,
    });
    expect(parsed.pairingCode).toBe('A1B2C3');
  });

  it('refuses a pairing code that is too short, too long or not alphanumeric', () => {
    for (const pairingCode of ['A1B2', 'A1B2C3D4E5F6', 'A1-B2C3']) {
      expect(
        pairDeviceRequestSchema.safeParse({ pairingCode, name: 'kiosk', kind: 'kiosk', branchId: UUID })
          .success,
        pairingCode,
      ).toBe(false);
    }
  });

  it('knows every device class the platform pairs', () => {
    expect(deviceKindSchema.options).toEqual([
      'kiosk',
      'tv',
      'print_agent',
      'workstation',
      'mobile',
      'analyzer',
    ]);
    expect(
      pairDeviceRequestSchema.safeParse({ pairingCode: 'A1B2C3', name: 'x', kind: 'fridge', branchId: UUID })
        .success,
    ).toBe(false);
  });
});

describe('audit viewer and break-glass', () => {
  it('coerces the boolean filters a query string carries as text', () => {
    expect(auditSearchQuerySchema.parse({ breakGlassOnly: 'true' }).breakGlassOnly).toBe(true);
    expect(auditSearchQuerySchema.parse({}).breakGlassOnly).toBeUndefined();
    expect(auditSearchQuerySchema.parse({}).limit).toBe(50);
    expect(auditSearchQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('refuses a malformed date range rather than searching the wrong window', () => {
    expect(
      auditSearchQuerySchema.safeParse({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.000Z' })
        .success,
    ).toBe(true);
    expect(auditSearchQuerySchema.safeParse({ from: '2026-08-01' }).success).toBe(false);
  });

  it('refuses a non-uuid patient or row filter', () => {
    expect(auditSearchQuerySchema.safeParse({ patientId: 'UHID-000123' }).success).toBe(false);
    expect(auditSearchQuerySchema.safeParse({ rowId: '42' }).success).toBe(false);
  });

  it('requires a coded reason and a real explanation before a chart is opened', () => {
    // EN-024 §5: break-glass is allowed, and it is always reviewed.
    expect(
      breakGlassAccessRequestSchema.safeParse({
        patientId: UUID,
        reasonCode: 'code_blue',
        reasonText: 'Arrest call in ER, patient not on my list.',
      }).success,
    ).toBe(true);
    expect(
      breakGlassAccessRequestSchema.safeParse({
        patientId: UUID,
        reasonCode: 'code_blue',
        reasonText: 'urgent',
      }).success,
    ).toBe(false);
    expect(
      breakGlassAccessRequestSchema.safeParse({
        patientId: UUID,
        reasonCode: 'curious',
        reasonText: 'Arrest call in ER.',
      }).success,
    ).toBe(false);
  });

  it('records a reviewer’s verdict as one of three outcomes, with a note', () => {
    for (const reviewStatus of ['justified', 'not_justified', 'explained']) {
      expect(
        breakGlassReviewRequestSchema.safeParse({
          reviewStatus,
          reviewNote: 'Confirmed with the ER consultant.',
        }).success,
        reviewStatus,
      ).toBe(true);
    }
    expect(
      breakGlassReviewRequestSchema.safeParse({ reviewStatus: 'justified', reviewNote: 'ok' }).success,
    ).toBe(false);
    expect(
      breakGlassReviewRequestSchema.safeParse({ reviewStatus: 'pending', reviewNote: 'Awaiting reply.' })
        .success,
    ).toBe(false);
  });

  it('demands a ticket reference and a reason before impersonation, and defaults to read-only', () => {
    // EN-007 §3.8: no ticket, no impersonation.
    const parsed = startImpersonationRequestSchema.parse({
      targetUserId: UUID,
      ticketRef: 'HD-8842',
      reason: 'Reproducing a billing screen defect the user reported.',
    });
    expect(parsed.mode).toBe('read');
    expect(
      startImpersonationRequestSchema.safeParse({ targetUserId: UUID, reason: 'Reproducing a defect.' })
        .success,
    ).toBe(false);
    expect(
      startImpersonationRequestSchema.safeParse({ targetUserId: UUID, ticketRef: 'HD-8842', reason: 'debug' })
        .success,
    ).toBe(false);
  });
});

describe('branch onboarding', () => {
  const validBranch = {
    code: 'BLR-01',
    name: 'Vim’s Hospital Bengaluru',
    shortName: 'Bengaluru',
    kind: 'branch',
    address: { line1: '12 MG Road', city: 'Bengaluru', stateCode: '29', pincode: '560001' },
    moduleProfile: 'full_hospital',
    colourToken: 'brand.blue',
  };

  it('applies the Indian defaults a new branch inherits', () => {
    const parsed = createBranchRequestSchema.parse(validBranch);
    expect(parsed.timezone).toBe('Asia/Kolkata');
    expect(parsed.currency).toBe('INR');
    expect(parsed.residencyZone).toBe('in');
    expect(parsed.bedCount).toBe(0);
    expect(parsed.address.country).toBe('IN');
  });

  it('refuses a branch code that is not upper case letters, digits and hyphen', () => {
    for (const code of ['blr-01', 'BLR 01', 'B', 'BLR_01']) {
      expect(createBranchRequestSchema.safeParse({ ...validBranch, code }).success, code).toBe(false);
    }
  });

  it('refuses a PIN code that is not six digits', () => {
    for (const pincode of ['56001', '5600011', '560 001', 'ABC001']) {
      expect(
        createBranchRequestSchema.safeParse({ ...validBranch, address: { ...validBranch.address, pincode } })
          .success,
        pincode,
      ).toBe(false);
    }
  });

  it('refuses anything that is not GSTIN-shaped, because it prints on every invoice', () => {
    // NOTE: the committed pattern is one character longer than a real GSTIN, so
    // no genuine 15-character GSTIN currently validates. That is reported as a
    // source defect rather than asserted here, which is why this test only pins
    // down the rejections — all of which are correct either way.
    for (const gstin of ['NOT-A-GSTIN-123', '29AABCU9603R1Z', '', '29aabcu', '999999999999999']) {
      expect(createBranchRequestSchema.safeParse({ ...validBranch, gstin }).success, gstin).toBe(false);
    }
    // A branch that is not separately registered legitimately has none.
    expect(createBranchRequestSchema.safeParse({ ...validBranch, gstin: null }).success).toBe(true);
    expect(createBranchRequestSchema.safeParse(validBranch).success).toBe(true);
  });

  it('requires a two-character state code, which drives the CGST/SGST versus IGST split', () => {
    expect(
      createBranchRequestSchema.safeParse({
        ...validBranch,
        address: { ...validBranch.address, stateCode: '9' },
      }).success,
    ).toBe(false);
    expect(
      createBranchRequestSchema.safeParse({
        ...validBranch,
        address: { ...validBranch.address, stateCode: 'KAR' },
      }).success,
    ).toBe(false);
  });

  it('knows every kind of site a group can open', () => {
    expect(branchKindSchema.options).toEqual([
      'hospital',
      'branch',
      'satellite',
      'collection_centre',
      'daycare',
      'polyclinic',
      'warehouse',
    ]);
    expect(createBranchRequestSchema.safeParse({ ...validBranch, kind: 'clinic' }).success).toBe(false);
    expect(createBranchRequestSchema.safeParse({ ...validBranch, moduleProfile: 'everything' }).success).toBe(
      false,
    );
  });

  it('links a satellite to the branch that serves it', () => {
    // EN-041 §3.1: a collection centre depends on a parent for lab processing.
    expect(
      createBranchRequestSchema.safeParse({
        ...validBranch,
        kind: 'collection_centre',
        servesFromBranchId: UUID,
        parentBranchId: UUID_2,
      }).success,
    ).toBe(true);
    expect(
      createBranchRequestSchema.safeParse({ ...validBranch, servesFromBranchId: 'BLR-01' }).success,
    ).toBe(false);
  });

  it('refuses a negative bed count', () => {
    expect(createBranchRequestSchema.safeParse({ ...validBranch, bedCount: -1 }).success).toBe(false);
  });

  it('requires at least one section when cloning a branch configuration', () => {
    // Cloning nothing is a no-op that would read as a successful onboarding step.
    expect(
      cloneBranchConfigRequestSchema.safeParse({ sourceBranchId: UUID, sections: ['tariffs', 'branding'] })
        .success,
    ).toBe(true);
    expect(cloneBranchConfigRequestSchema.safeParse({ sourceBranchId: UUID, sections: [] }).success).toBe(
      false,
    );
    expect(
      cloneBranchConfigRequestSchema.safeParse({ sourceBranchId: UUID, sections: ['everything'] }).success,
    ).toBe(false);
  });
});

describe('go-live smoke test', () => {
  const check = {
    key: 'rls_isolation',
    label: 'RLS isolation',
    mandatory: true,
    status: 'passed',
    detail: null,
    remediation: null,
  };

  it('reports each check with its remediation hint', () => {
    // EN-041 §14 AC-13: a failing mandatory check blocks go-live and must say why.
    expect(
      smokeTestResultSchema.safeParse({
        branchId: UUID,
        startedAt: '2026-08-17T10:00:00.000Z',
        finishedAt: null,
        checks: [
          check,
          {
            ...check,
            status: 'failed',
            detail: 'Branch 2 rows visible',
            remediation: 'Re-apply the RLS policy.',
          },
        ],
        allMandatoryPassed: false,
        canGoLive: false,
      }).success,
    ).toBe(true);
  });

  it('rejects a check state the go-live gate has no meaning for', () => {
    expect(
      smokeTestResultSchema.safeParse({
        branchId: UUID,
        startedAt: '2026-08-17T10:00:00.000Z',
        finishedAt: null,
        checks: [{ ...check, status: 'maybe' }],
        allMandatoryPassed: false,
        canGoLive: false,
      }).success,
    ).toBe(false);
  });

  it('always states both whether the mandatory checks passed and whether go-live is allowed', () => {
    expect(
      smokeTestResultSchema.safeParse({
        branchId: UUID,
        startedAt: '2026-08-17T10:00:00.000Z',
        finishedAt: '2026-08-17T10:04:00.000Z',
        checks: [check],
        allMandatoryPassed: true,
      }).success,
    ).toBe(false);
  });
});
