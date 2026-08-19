import { describe, expect, it } from 'vitest';
import {
  APPROVAL_REQUIRED_SETTING_KEYS,
  DUAL_CONTROL_SETTING_KEYS,
  SECRET_SETTING_KEYS,
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  assertRegisteredSetting,
  getSettingDefinition,
} from './definitions.js';

/**
 * `EN-007 §3.1.2`: settings are "declared by modules in code … rendered in Admin
 * console with validation … changes audited with before/after; some require
 * approval (EN-038) or dual control."
 *
 * The registry is only worth having if every entry is self-consistent, so the
 * central test here is that **every declared default validates against its own
 * schema** — a default that does not is a hospital that cannot open the settings
 * screen without an error it has no way to clear.
 */

describe('settings registry', () => {
  it('registers every key exactly once', () => {
    expect(new Set(SETTING_KEYS).size).toBe(SETTING_KEYS.length);
    expect(SETTING_KEYS).toHaveLength(SETTING_DEFINITIONS.length);
  });

  it('names every key as dotted lower snake segments', () => {
    for (const def of SETTING_DEFINITIONS) {
      expect(def.key, `"${def.key}" is not a valid setting key shape`).toMatch(
        /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/,
      );
    }
  });

  it('validates every declared default against its own schema', () => {
    // This is the invariant the registry exists for. A default of `0` under a
    // `min(5)` schema would break the admin console for every new hospital.
    for (const def of SETTING_DEFINITIONS) {
      const result = def.schema.safeParse(def.defaultValue);
      expect(result.success, `${def.key} default ${JSON.stringify(def.defaultValue)} fails its own schema`).toBe(true);
    }
  });

  it('rejects a value outside the declared range for a numeric setting', () => {
    // Spot-check that the schemas are real constraints rather than z.unknown().
    const idle = getSettingDefinition('session.idle_timeout_min')!;
    expect(idle.schema.safeParse(15).success).toBe(true);
    expect(idle.schema.safeParse(4).success).toBe(false);
    expect(idle.schema.safeParse(61).success).toBe(false);
    expect(idle.schema.safeParse('15').success).toBe(false);
  });

  it('gives every setting a module, a label and an administrator-readable description', () => {
    for (const def of SETTING_DEFINITIONS) {
      expect(def.module, `${def.key} has no owning module`).toMatch(/^EN-\d{3}$/);
      expect(def.label.length, `${def.key} has no label`).toBeGreaterThan(3);
      expect(def.description.length, `${def.key} has no usable description`).toBeGreaterThan(20);
    }
  });

  it('gives every setting at least one scope, drawn from the four that exist', () => {
    // A setting with no scope can never be set at all.
    for (const def of SETTING_DEFINITIONS) {
      expect(def.scopes.length, `${def.key} has no scope`).toBeGreaterThan(0);
      for (const scope of def.scopes) {
        expect(['hospital', 'branch', 'department', 'user'], `${def.key} has scope ${scope}`).toContain(scope);
      }
      expect(new Set(def.scopes).size, `${def.key} repeats a scope`).toBe(def.scopes.length);
    }
  });

  it('marks no setting as one that would weaken a safety hard-stop', () => {
    // docs/09 §10: "New settings keys are diffed against an allow-list so a future
    // 'make it configurable' PR is caught." A hard-stop is never configurable.
    for (const def of SETTING_DEFINITIONS) {
      expect(def.wouldWeakenSafety, `${def.key} claims to weaken a safety stop`).toBe(false);
    }
  });

  it('resolves a registered key and returns nothing for an unregistered one', () => {
    expect(getSettingDefinition('password.min_length')?.module).toBe('EN-007');
    expect(getSettingDefinition('password.min_lenght')).toBeUndefined();
  });

  it('fails loudly, and says where to declare it, when a module reads an unknown key', () => {
    expect(() => assertRegisteredSetting('opd.token.prefix')).toThrow(
      /Unregistered setting "opd\.token\.prefix"/,
    );
    expect(() => assertRegisteredSetting('opd.token.prefix')).toThrow(/settings\/definitions\.ts/);
    expect(assertRegisteredSetting('ui.default_theme').defaultValue).toBe('light');
  });
});

describe('sensitivity, approval and dual control', () => {
  it('lists exactly the secret-marked keys as secrets', () => {
    const expected = SETTING_DEFINITIONS.filter((d) => d.sensitivity === 'secret').map((d) => d.key);
    expect([...SECRET_SETTING_KEYS]).toEqual(expected);
  });

  it('treats the SMTP connection string as a secret, not as a normal setting', () => {
    // EN-007 §5: encrypted at rest, masked in the UI and in every export.
    expect(SECRET_SETTING_KEYS).toContain('email.smtp_url');
    expect(getSettingDefinition('email.smtp_url')?.sensitivity).toBe('secret');
  });

  it('never marks a secret as freely readable', () => {
    for (const key of SECRET_SETTING_KEYS) {
      expect(getSettingDefinition(key)?.sensitivity, `${key} must stay secret`).toBe('secret');
    }
  });

  it('routes every credential and safety-adjacent change through an approval', () => {
    // EN-038: changing a lockout threshold or a retention window is not a
    // preference, it is a control change.
    for (const key of [
      'password.min_length',
      'lockout.max_attempts',
      'audit.hot_partition_months',
      'email.attach_phi_documents',
      'email.smtp_url',
    ]) {
      expect(APPROVAL_REQUIRED_SETTING_KEYS, `${key} must require approval`).toContain(key);
    }
  });

  it('requires two administrators for the changes that cannot be undone', () => {
    // EN-007 §5. A group-unique UHID decision, cross-entity consent and PHI over
    // email are all one-way doors.
    for (const key of [
      'password.min_length',
      'audit.hot_partition_months',
      'impersonation.max_duration_min',
      'org.uhid_group_unique',
      'org.cross_branch_clinical_requires_consent',
      'email.attach_phi_documents',
    ]) {
      expect(DUAL_CONTROL_SETTING_KEYS, `${key} must need dual control`).toContain(key);
    }
  });

  it('derives the approval and dual-control lists from the definitions themselves', () => {
    expect([...APPROVAL_REQUIRED_SETTING_KEYS]).toEqual(
      SETTING_DEFINITIONS.filter((d) => d.requiresApproval).map((d) => d.key),
    );
    expect([...DUAL_CONTROL_SETTING_KEYS]).toEqual(
      SETTING_DEFINITIONS.filter((d) => d.dualControl).map((d) => d.key),
    );
  });
});

describe('settings that encode a safety or statutory rule', () => {
  it('does not let a hospital turn off the immediate VIP-access alert', () => {
    // EN-024 §3.2.4: "Cannot be turned off." A `z.boolean()` here would make that
    // comment false; only `z.literal(true)` enforces it.
    const def = getSettingDefinition('audit.vip_immediate_alert')!;
    expect(def.defaultValue).toBe(true);
    expect(def.schema.safeParse(true).success).toBe(true);
    expect(def.schema.safeParse(false).success).toBe(false);
  });

  it('caps the MFA enrolment grace period at a week', () => {
    // EN-007 §5: "Capped at 7." A hospital cannot grant itself a year of grace.
    const def = getSettingDefinition('mfa.grace_period_days')!;
    expect(def.schema.safeParse(7).success).toBe(true);
    expect(def.schema.safeParse(8).success).toBe(false);
    expect(def.schema.safeParse(0).success).toBe(true);
  });

  it('never lets the password floor drop below twelve characters', () => {
    // docs/04 §2. The setting exists so a hospital can be stricter, not looser.
    const def = getSettingDefinition('password.min_length')!;
    expect(def.schema.safeParse(12).success).toBe(true);
    expect(def.schema.safeParse(8).success).toBe(false);
  });

  it('never lets the idle timeout stretch past an hour', () => {
    const def = getSettingDefinition('session.idle_timeout_min')!;
    expect(def.schema.safeParse(60).success).toBe(true);
    expect(def.schema.safeParse(240).success).toBe(false);
  });

  it('keeps the audit hot window at or above the twelve months D-7 fixed', () => {
    const def = getSettingDefinition('audit.hot_partition_months')!;
    expect(def.schema.safeParse(12).success).toBe(true);
    expect(def.schema.safeParse(11).success).toBe(false);
  });

  it('holds integration payload retention inside the CERT-In window', () => {
    // EN-017 §4: payloads 30 days, metadata 180 (CERT-In).
    const def = getSettingDefinition('ihub.payload_retention_days')!;
    expect(def.defaultValue).toBe(30);
    expect(def.schema.safeParse(180).success).toBe(true);
    expect(def.schema.safeParse(181).success).toBe(false);
    expect(def.schema.safeParse(6).success).toBe(false);
  });

  it('defaults PHI-by-email off, because sending a document is a disclosure', () => {
    // docs/04 §4.
    expect(getSettingDefinition('email.attach_phi_documents')?.defaultValue).toBe(false);
  });

  it('defaults break-glass care-team notification off but keeps the DPO informed', () => {
    // EN-024 §16 Q3 leaves this to the hospital; the recorded default is off.
    expect(getSettingDefinition('audit.notify_care_team_on_break_glass')?.defaultValue).toBe(false);
  });

  it('keeps en-IN in the enabled locales and offers exactly the twelve supported ones', () => {
    // CLAUDE.md §4: 11 non-default locales plus `en-IN`, which is always the fallback.
    const enabled = getSettingDefinition('ui.enabled_locales')!;
    expect(enabled.defaultValue).toContain('en-IN');
    expect(enabled.schema.safeParse([]).success).toBe(false);
    expect(enabled.schema.safeParse(['en-IN', 'hi', 'ta', 'te', 'ml', 'kn', 'mr', 'bn', 'gu', 'or', 'pa', 'ar']).success).toBe(
      true,
    );
    expect(enabled.schema.safeParse(['en-US']).success).toBe(false);

    const fallback = getSettingDefinition('ui.locale_default')!;
    expect(fallback.defaultValue).toBe('en-IN');
    expect(fallback.schema.safeParse('fr').success).toBe(false);
  });

  it('accepts only a 24-hour clock reading for the quiet-hours defaults', () => {
    for (const key of ['notify.default_quiet_hours_start', 'notify.default_quiet_hours_end']) {
      const def = getSettingDefinition(key)!;
      expect(def.schema.safeParse('22:00').success, key).toBe(true);
      expect(def.schema.safeParse('24:00').success, key).toBe(false);
      expect(def.schema.safeParse('10 pm').success, key).toBe(false);
    }
  });

  it('bounds the approval SLA reminder points to real fractions of the SLA', () => {
    // EN-038 §3.4.2: reminders at 50 % and 80 %. A reminder at 0 % or 100 % is
    // either instant noise or too late to be a reminder.
    const def = getSettingDefinition('workflow.reminder_fractions')!;
    expect(def.defaultValue).toEqual([0.5, 0.8]);
    expect(def.schema.safeParse([0.25, 0.5, 0.75, 0.9]).success).toBe(true);
    expect(def.schema.safeParse([0]).success).toBe(false);
    expect(def.schema.safeParse([1]).success).toBe(false);
    expect(def.schema.safeParse([]).success).toBe(false);
    expect(def.schema.safeParse([0.1, 0.2, 0.3, 0.4, 0.5]).success).toBe(false);
  });

  it('watermarks reprints by default, so a copy cannot pass as an original', () => {
    // EN-039 §5.
    expect(getSettingDefinition('print.reprint_watermark_required')?.defaultValue).toBe(true);
  });
});
