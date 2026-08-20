import { describe, expect, it } from 'vitest';
import {
  branchSelectRequestSchema,
  emailSchema,
  indianMobileSchema,
  loginChallengeSchema,
  loginIdentifierSchema,
  loginRequestSchema,
  meResponseSchema,
  mfaConfirmRequestSchema,
  mfaEnrolRequestSchema,
  mfaEnrolResponseSchema,
  mfaVerifyRequestSchema,
  otpCodeSchema,
  otpRequestSchema,
  otpVerifyRequestSchema,
  passwordChangeRequestSchema,
  passwordForgotRequestSchema,
  passwordResetRequestSchema,
  passwordSchema,
  pinSchema,
  pinSetRequestSchema,
  pinVerifyRequestSchema,
  secondPersonAuthSchema,
  sessionSummarySchema,
  stepUpChallengeSchema,
  stepUpRequestSchema,
  stepUpVerifyRequestSchema,
  totpCodeSchema,
} from './auth.js';

/**
 * `docs/02 §2`: "one schema validates client & server". These tests are therefore
 * mostly about **rejection** — a shape the server would refuse must be a shape the
 * form could never submit, and vice versa. Where the schema encodes a security
 * rule (docs/04 §2 password floor, docs/04 §6 no account enumeration, EN-007
 * §3.4.6 PIN quality) the test cites it.
 */

const UUID = '0194f2c0-0000-7000-8000-000000000001';
const UUID_2 = '0194f2c0-0000-7000-8000-000000000002';

describe('field primitives', () => {
  it('normalises an Indian mobile written the way patients actually write it', () => {
    for (const written of ['9876543210', '+919876543210', '919876543210', '98765 43210', '98765-43210']) {
      expect(indianMobileSchema.parse(written), written).toBe('9876543210');
    }
  });

  it('rejects a number that is not a ten-digit Indian mobile', () => {
    // A landline or a truncated number here becomes an OTP that never arrives and
    // a patient who cannot log in.
    for (const bad of ['5876543210', '987654321', '98765432101', '', 'ninety']) {
      expect(indianMobileSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('lower-cases and trims an email so one address cannot become two accounts', () => {
    expect(emailSchema.parse('  A.Menon@Example.COM ')).toBe('a.menon@example.com');
    expect(emailSchema.safeParse('a.menon@example').success).toBe(false);
    expect(emailSchema.safeParse('not an email').success).toBe(false);
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@example.com`).success).toBe(false);
  });

  it('keeps the login identifier deliberately loose, so it cannot enumerate accounts', () => {
    // docs/04 §6: the login endpoint must not reveal which identifier shapes exist.
    expect(loginIdentifierSchema.safeParse('a.menon').success).toBe(true);
    expect(loginIdentifierSchema.safeParse('a.menon@example.com').success).toBe(true);
    expect(loginIdentifierSchema.safeParse('EMP-00421').success).toBe(true);
    expect(loginIdentifierSchema.safeParse('ab').success).toBe(false);
  });

  it('enforces the twelve-character password floor and rejects edge whitespace', () => {
    // docs/04 §2. A password that starts or ends with a space is one a user will
    // never be able to retype from a printed handover sheet.
    expect(passwordSchema.safeParse('correct horse battery').success).toBe(true);
    expect(passwordSchema.safeParse('short1234!').success).toBe(false);
    expect(passwordSchema.safeParse(' leadingspace123').success).toBe(false);
    expect(passwordSchema.safeParse('trailingspace123 ').success).toBe(false);
    expect(passwordSchema.safeParse('x'.repeat(201)).success).toBe(false);
  });

  it('accepts a six-digit TOTP and nothing else', () => {
    expect(totpCodeSchema.parse(' 123456 ')).toBe('123456');
    for (const bad of ['12345', '1234567', '12345a', '']) {
      expect(totpCodeSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('accepts a four-to-eight digit OTP and a four-to-six digit PIN', () => {
    expect(otpCodeSchema.safeParse('1234').success).toBe(true);
    expect(otpCodeSchema.safeParse('12345678').success).toBe(true);
    expect(otpCodeSchema.safeParse('123').success).toBe(false);
    expect(pinSchema.safeParse('1234').success).toBe(true);
    expect(pinSchema.safeParse('123456').success).toBe(true);
    expect(pinSchema.safeParse('1234567').success).toBe(false);
    expect(pinSchema.safeParse('12a4').success).toBe(false);
  });
});

describe('login request', () => {
  it('remembers the device only when asked', () => {
    // EN-007 §3.4.2: remembering a device weakens MFA, so it is opt-in.
    const parsed = loginRequestSchema.parse({ identifier: 'a.menon', password: 'correct horse battery' });
    expect(parsed.rememberDevice).toBe(false);
    expect(
      loginRequestSchema.parse({ identifier: 'a.menon', password: 'x', rememberDevice: true }).rememberDevice,
    ).toBe(true);
  });

  it('does not apply the password policy to the login field itself', () => {
    // The floor is enforced when a password is *set*. Applying it at login would
    // tell an attacker which accounts predate the policy.
    expect(loginRequestSchema.safeParse({ identifier: 'a.menon', password: 'old' }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ identifier: 'a.menon', password: '' }).success).toBe(false);
  });

  it('requires both an identifier and a password', () => {
    expect(loginRequestSchema.safeParse({ password: 'correct horse battery' }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ identifier: 'a.menon' }).success).toBe(false);
  });

  it('bounds the device fingerprint so it cannot become an unbounded field', () => {
    expect(
      loginRequestSchema.safeParse({
        identifier: 'a.menon',
        password: 'x',
        deviceFingerprint: 'f'.repeat(129),
      }).success,
    ).toBe(false);
  });
});

describe('login challenge', () => {
  it('models the MFA stop, including the enrolment grace period', () => {
    expect(
      loginChallengeSchema.safeParse({
        status: 'mfa_required',
        challengeToken: 'ct_1',
        methods: ['totp', 'webauthn'],
        enrolmentRequired: true,
        graceDaysRemaining: 3,
      }).success,
    ).toBe(true);
    // `null` means "no grace left to speak of", which is different from `0`.
    expect(
      loginChallengeSchema.safeParse({
        status: 'mfa_required',
        challengeToken: 'ct_1',
        methods: ['totp'],
        enrolmentRequired: false,
        graceDaysRemaining: null,
      }).success,
    ).toBe(true);
    expect(
      loginChallengeSchema.safeParse({
        status: 'mfa_required',
        challengeToken: 'ct_1',
        methods: ['carrier_pigeon'],
        enrolmentRequired: false,
        graceDaysRemaining: null,
      }).success,
    ).toBe(false);
  });

  it('models the branch-selection stop with everything the shell needs to band correctly', () => {
    // EN-041 §3.7: the branch colour band exists because "which branch am I in?"
    // errors cause real harm, so the token is not optional.
    const withBranches = {
      status: 'branch_selection_required',
      challengeToken: 'ct_2',
      branches: [
        {
          branchId: UUID,
          code: 'BLR',
          name: 'Bengaluru',
          city: 'Bengaluru',
          colourToken: 'brand.blue',
          roles: ['doctor_ip'],
        },
      ],
    };
    expect(loginChallengeSchema.safeParse(withBranches).success).toBe(true);
    expect(
      loginChallengeSchema.safeParse({
        ...withBranches,
        branches: [
          {
            branchId: 'BLR',
            code: 'BLR',
            name: 'Bengaluru',
            city: null,
            colourToken: 'brand.blue',
            roles: [],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('models a forced password change and names why', () => {
    expect(
      loginChallengeSchema.safeParse({
        status: 'password_change_required',
        challengeToken: 'ct_3',
        reason: 'first_login',
      }).success,
    ).toBe(true);
    expect(
      loginChallengeSchema.safeParse({
        status: 'password_change_required',
        challengeToken: 'ct_3',
        reason: 'because',
      }).success,
    ).toBe(false);
  });

  it('models the authenticated result, and never returns a refresh token in the body', () => {
    // The refresh token is an httpOnly cookie only; a body field would be
    // readable by any script on the page.
    const authenticated = {
      status: 'authenticated',
      accessToken: 'at_1',
      expiresInSeconds: 900,
      session: {
        sessionId: UUID,
        hospitalId: UUID_2,
        branchId: null,
        homeWorkspace: 'clinical',
        availableWorkspaces: [{ workspace: 'clinical', roleKey: 'doctor_ip', roleName: 'Doctor (IP)' }],
      },
    };
    const parsed = loginChallengeSchema.parse(authenticated);
    expect(Object.hasOwn(parsed, 'refreshToken')).toBe(false);
    expect(loginChallengeSchema.safeParse({ ...authenticated, expiresInSeconds: 0 }).success).toBe(false);
  });

  it('models the force-SSO redirect rather than an error', () => {
    expect(
      loginChallengeSchema.safeParse({
        status: 'use_sso',
        providerKey: 'azure',
        providerName: 'Hospital SSO',
      }).success,
    ).toBe(true);
  });

  it('rejects a status the client has no branch for', () => {
    // An unknown status would fall through every `switch` in the login screen.
    expect(loginChallengeSchema.safeParse({ status: 'ok', accessToken: 'at_1' }).success).toBe(false);
    expect(loginChallengeSchema.safeParse({ accessToken: 'at_1' }).success).toBe(false);
  });
});

describe('MFA and step-up', () => {
  it('accepts a recovery code at verification but never at enrolment', () => {
    // A recovery code is a break-glass credential; enrolling *with* one would
    // make it a second factor rather than a fallback.
    expect(
      mfaVerifyRequestSchema.safeParse({ challengeToken: 'ct', method: 'recovery_code', code: 'abcd-efgh' })
        .success,
    ).toBe(true);
    expect(mfaEnrolRequestSchema.safeParse({ method: 'recovery_code' }).success).toBe(false);
    expect(mfaEnrolRequestSchema.safeParse({ method: 'sms' }).success).toBe(false);
    expect(mfaEnrolRequestSchema.safeParse({ method: 'totp' }).success).toBe(true);
  });

  it('defaults device remembering off at MFA verification too', () => {
    expect(
      mfaVerifyRequestSchema.parse({ challengeToken: 'ct', method: 'totp', code: '123456' }).rememberDevice,
    ).toBe(false);
  });

  it('returns the provisioning material as optional, because it is shown exactly once', () => {
    // EN-007 §4: only hashes of the recovery codes are stored, so a second read
    // of this response legitimately has nothing to return.
    expect(mfaEnrolResponseSchema.safeParse({ method: 'totp' }).success).toBe(true);
    expect(
      mfaEnrolResponseSchema.safeParse({
        method: 'totp',
        provisioningUri: 'otpauth://totp/VimsHMS:a.menon',
        secretMasked: '····ABCD',
        recoveryCodes: ['aaaa-bbbb'],
      }).success,
    ).toBe(true);
    expect(mfaConfirmRequestSchema.safeParse({ method: 'totp', code: '123456' }).success).toBe(true);
    expect(mfaConfirmRequestSchema.safeParse({ method: 'totp', code: '123' }).success).toBe(false);
  });

  it('requires both the challenge token and a real branch id at branch selection', () => {
    expect(branchSelectRequestSchema.safeParse({ challengeToken: 'ct', branchId: UUID }).success).toBe(true);
    expect(branchSelectRequestSchema.safeParse({ challengeToken: '', branchId: UUID }).success).toBe(false);
    expect(branchSelectRequestSchema.safeParse({ challengeToken: 'ct', branchId: 'BLR' }).success).toBe(
      false,
    );
  });

  it('names the action a step-up is being demanded for', () => {
    // EN-025 §3.6: step-up is per action, not per session, so the key is required.
    expect(stepUpRequestSchema.safeParse({ actionKey: 'bill.discount.approve' }).success).toBe(true);
    expect(stepUpRequestSchema.safeParse({ actionKey: 'ab' }).success).toBe(false);
    expect(
      stepUpChallengeSchema.safeParse({
        satisfied: false,
        requiredAcr: 'urn:acr:mfa',
        maxAgeSeconds: 300,
        availableMethods: ['totp', 'pin'],
        challengeToken: 'ct',
      }).success,
    ).toBe(true);
    // A step-up with no age bound would be satisfied by a login from last week.
    expect(
      stepUpChallengeSchema.safeParse({
        satisfied: true,
        requiredAcr: 'urn:acr:mfa',
        maxAgeSeconds: 0,
        availableMethods: [],
        challengeToken: null,
      }).success,
    ).toBe(false);
    expect(
      stepUpVerifyRequestSchema.safeParse({ challengeToken: 'ct', method: 'pin', code: '1234' }).success,
    ).toBe(true);
    expect(
      stepUpVerifyRequestSchema.safeParse({ challengeToken: 'ct', method: 'sms', code: '1234' }).success,
    ).toBe(false);
  });
});

describe('password change and reset', () => {
  const strong = 'correct horse battery';

  it('requires the two new passwords to match, and says which field is wrong', () => {
    const result = passwordChangeRequestSchema.safeParse({
      currentPassword: 'old password here',
      newPassword: strong,
      confirmPassword: 'something else entirely',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['confirmPassword']);
  });

  it('requires either the current password or a challenge token, never neither', () => {
    // Without one of the two, anyone holding a session could rotate the password
    // of the user whose screen they walked up to.
    expect(
      passwordChangeRequestSchema.safeParse({ newPassword: strong, confirmPassword: strong }).success,
    ).toBe(false);
    expect(
      passwordChangeRequestSchema.safeParse({
        currentPassword: 'old password here',
        newPassword: strong,
        confirmPassword: strong,
      }).success,
    ).toBe(true);
    expect(
      passwordChangeRequestSchema.safeParse({
        challengeToken: 'ct',
        newPassword: strong,
        confirmPassword: strong,
      }).success,
    ).toBe(true);
  });

  it('applies the password policy to the new password, not to the old one', () => {
    expect(
      passwordChangeRequestSchema.safeParse({
        currentPassword: 'x',
        newPassword: 'short',
        confirmPassword: 'short',
      }).success,
    ).toBe(false);
  });

  it('accepts only a bounded reset token, and still checks the confirmation', () => {
    const token = 't'.repeat(32);
    expect(
      passwordResetRequestSchema.safeParse({ token, newPassword: strong, confirmPassword: strong }).success,
    ).toBe(true);
    expect(
      passwordResetRequestSchema.safeParse({ token: 'short', newPassword: strong, confirmPassword: strong })
        .success,
    ).toBe(false);
    expect(
      passwordResetRequestSchema.safeParse({ token, newPassword: strong, confirmPassword: 'other' }).success,
    ).toBe(false);
  });

  it('takes any identifier shape for a forgotten password, to avoid enumeration', () => {
    expect(passwordForgotRequestSchema.safeParse({ identifier: 'a.menon@example.com' }).success).toBe(true);
    expect(passwordForgotRequestSchema.safeParse({ identifier: '' }).success).toBe(false);
  });
});

describe('patient OTP and staff PIN', () => {
  it('defaults an OTP request to patient login and normalises the mobile', () => {
    const parsed = otpRequestSchema.parse({ mobile: '+91 98765 43210' });
    expect(parsed.mobile).toBe('9876543210');
    expect(parsed.purpose).toBe('patient_login');
    expect(otpRequestSchema.safeParse({ mobile: '9876543210', purpose: 'marketing' }).success).toBe(false);
  });

  it('verifies an OTP only against a valid mobile and a numeric code', () => {
    expect(otpVerifyRequestSchema.safeParse({ mobile: '9876543210', code: '123456' }).success).toBe(true);
    expect(otpVerifyRequestSchema.safeParse({ mobile: '9876543210', code: 'abcdef' }).success).toBe(false);
    expect(otpVerifyRequestSchema.safeParse({ mobile: '1234567890', code: '123456' }).success).toBe(false);
  });

  it('re-authenticates a quick unlock with a PIN alone', () => {
    expect(pinVerifyRequestSchema.safeParse({ pin: '4821' }).success).toBe(true);
    expect(pinVerifyRequestSchema.safeParse({ pin: '48' }).success).toBe(false);
  });

  it('demands the full password before a PIN may be set', () => {
    // EN-007 §3.4.6: a PIN is a shortcut for an already-proven identity.
    expect(pinSetRequestSchema.safeParse({ pin: '4821', confirmPin: '4821' }).success).toBe(false);
    expect(
      pinSetRequestSchema.safeParse({
        pin: '4821',
        confirmPin: '4821',
        currentPassword: 'correct horse battery',
      }).success,
    ).toBe(true);
  });

  it('refuses a PIN made of one repeated digit', () => {
    const result = pinSetRequestSchema.safeParse({ pin: '1111', confirmPin: '1111', currentPassword: 'pw' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path[0] === 'pin')).toBe(true);
  });

  it('refuses the PINs everyone tries first', () => {
    for (const pin of ['1234', '12345', '123456', '0000']) {
      expect(
        pinSetRequestSchema.safeParse({ pin, confirmPin: pin, currentPassword: 'pw' }).success,
        pin,
      ).toBe(false);
    }
  });

  it('requires the two PIN entries to match', () => {
    const result = pinSetRequestSchema.safeParse({ pin: '4821', confirmPin: '4822', currentPassword: 'pw' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['confirmPin']);
  });
});

describe('second-person authorisation', () => {
  it('carries the second person’s own identifier, credential and the action co-signed', () => {
    // docs/06 §6.9 level 6: "the same user can never be both". The identifier is
    // therefore mandatory — a bare credential could be the first user's own.
    expect(
      secondPersonAuthSchema.safeParse({
        identifier: 'r.iyer',
        credential: '482193',
        credentialKind: 'totp',
        actionKey: 'blood.unit.issue',
      }).success,
    ).toBe(true);
    expect(
      secondPersonAuthSchema.safeParse({
        credential: '482193',
        credentialKind: 'totp',
        actionKey: 'blood.unit.issue',
      }).success,
    ).toBe(false);
    expect(
      secondPersonAuthSchema.safeParse({ identifier: 'r.iyer', credential: '482193', credentialKind: 'totp' })
        .success,
    ).toBe(false);
    expect(
      secondPersonAuthSchema.safeParse({
        identifier: 'r.iyer',
        credential: '482193',
        credentialKind: 'fingerprint',
        actionKey: 'blood.unit.issue',
      }).success,
    ).toBe(false);
  });
});

describe('session and identity responses', () => {
  const session = {
    sessionId: UUID,
    current: true,
    deviceLabel: 'Ward 4B tablet',
    userAgent: null,
    location: 'Bengaluru, KA',
    method: 'password',
    createdAt: '2026-08-17T10:00:00.000Z',
    lastSeenAt: '2026-08-17T10:05:00.000Z',
    expiresAt: '2026-08-17T22:00:00.000Z',
  };

  it('accepts a session summary with coarse location only', () => {
    expect(sessionSummarySchema.safeParse(session).success).toBe(true);
    expect(sessionSummarySchema.safeParse({ ...session, location: null }).success).toBe(true);
  });

  it('requires offset-bearing timestamps, never a naive local time', () => {
    // docs/03 §Table rules: timestamptz only. "10:05" in whose timezone?
    expect(sessionSummarySchema.safeParse({ ...session, lastSeenAt: '2026-08-17 10:05:00' }).success).toBe(
      false,
    );
    expect(sessionSummarySchema.safeParse({ ...session, expiresAt: '17/08/2026' }).success).toBe(false);
  });

  it('records how the session was authenticated, including impersonation and break-glass', () => {
    for (const method of ['password', 'sso', 'otp', 'device', 'impersonation', 'break_glass']) {
      expect(sessionSummarySchema.safeParse({ ...session, method }).success, method).toBe(true);
    }
    expect(sessionSummarySchema.safeParse({ ...session, method: 'guest' }).success).toBe(false);
  });

  const me = {
    userId: UUID,
    username: 'a.menon',
    displayName: 'Dr Anita Menon',
    email: null,
    photoUrl: null,
    hospital: {
      hospitalId: UUID_2,
      name: 'Vim’s Demo Hospital',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      locale: 'en-IN',
      enabledLocales: ['en-IN', 'hi'],
      fiscalYearStartMonth: 4,
    },
    branch: {
      branchId: UUID,
      code: 'BLR',
      name: 'Bengaluru',
      colourToken: 'brand.blue',
      timezone: 'Asia/Kolkata',
    },
    grantedBranches: [{ branchId: UUID, code: 'BLR', name: 'Bengaluru', colourToken: 'brand.blue' }],
    scope: 'branch',
    roles: [{ roleId: UUID_2, key: 'doctor_ip', name: 'Doctor (IP)', branchId: UUID }],
    permissions: ['org.patient.break_glass'],
    homeWorkspace: 'clinical',
    availableWorkspaces: [{ workspace: 'clinical', roleKey: 'doctor_ip', roleName: 'Doctor (IP)' }],
    preferences: { locale: 'en-IN', theme: 'light', density: 'default', highContrast: false, fontScale: 1 },
    mfa: { enabled: true, methods: ['totp'], mandatory: true, graceDaysRemaining: null },
    pinSet: true,
    impersonation: null,
    licence: { status: 'active', degradeTier: 0, expiresAt: null, bannerMessage: null },
    readOnlyMode: { active: false, since: null, reason: null },
  };

  it('accepts a fully populated identity response', () => {
    expect(meResponseSchema.safeParse(me).success).toBe(true);
  });

  it('carries the flat permission set the left nav is generated from', () => {
    // docs/06 §4.1: "never render an item the user cannot use".
    const { permissions: _p, ...withoutPermissions } = me;
    expect(meResponseSchema.safeParse(withoutPermissions).success).toBe(false);
  });

  it('always states the licence degradation tier, inside the 0–4 ladder', () => {
    // EN-040 §8: the shell renders the degradation banner from exactly this.
    expect(meResponseSchema.safeParse({ ...me, licence: { ...me.licence, degradeTier: 4 } }).success).toBe(
      true,
    );
    expect(meResponseSchema.safeParse({ ...me, licence: { ...me.licence, degradeTier: 5 } }).success).toBe(
      false,
    );
    expect(meResponseSchema.safeParse({ ...me, licence: { ...me.licence, degradeTier: -1 } }).success).toBe(
      false,
    );
  });

  it('always states whether an impersonation banner must be shown', () => {
    // EN-007 §3.8: the banner cannot be hidden, so the field cannot be absent.
    const { impersonation: _i, ...withoutImpersonation } = me;
    expect(meResponseSchema.safeParse(withoutImpersonation).success).toBe(false);
    expect(
      meResponseSchema.safeParse({
        ...me,
        impersonation: {
          impersonatorName: 'IT Support',
          mode: 'read',
          expiresAt: '2026-08-17T10:30:00.000Z',
        },
      }).success,
    ).toBe(true);
    expect(
      meResponseSchema.safeParse({
        ...me,
        impersonation: { impersonatorName: 'IT Support', mode: 'delete', expiresAt: 'x' },
      }).success,
    ).toBe(false);
  });

  it('always states whether the system is in read-only mode', () => {
    // docs/06 §6.7: the degraded-mode banner is not optional during a failover.
    const { readOnlyMode: _r, ...withoutReadOnly } = me;
    expect(meResponseSchema.safeParse(withoutReadOnly).success).toBe(false);
  });

  it('bounds the fiscal-year start to a real month', () => {
    // The FY drives every gapless invoice series (docs/03 §Numbering series).
    expect(
      meResponseSchema.safeParse({ ...me, hospital: { ...me.hospital, fiscalYearStartMonth: 13 } }).success,
    ).toBe(false);
    expect(
      meResponseSchema.safeParse({ ...me, hospital: { ...me.hospital, fiscalYearStartMonth: 0 } }).success,
    ).toBe(false);
  });

  it('offers only the three themes and three densities the design system defines', () => {
    // docs/06 §6.3.
    expect(
      meResponseSchema.safeParse({ ...me, preferences: { ...me.preferences, theme: 'sepia' } }).success,
    ).toBe(false);
    expect(
      meResponseSchema.safeParse({ ...me, preferences: { ...me.preferences, density: 'cosy' } }).success,
    ).toBe(false);
    expect(meResponseSchema.safeParse({ ...me, scope: 'planet' }).success).toBe(false);
  });

  it('allows a group-scope user with no single active branch', () => {
    // EN-041: a group admin legitimately has no one branch.
    expect(meResponseSchema.safeParse({ ...me, branch: null, scope: 'group' }).success).toBe(true);
  });
});
