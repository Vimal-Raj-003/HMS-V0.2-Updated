import { describe, expect, it } from 'vitest';
import {
  AUDIT_CHAIN_GENESIS_HASH,
  AUDIT_CHAIN_HASHED_FIELDS,
  DEFAULT_AUDIT_FIELD_POLICIES,
  LEGAL_HOLD_REASONS,
  REASON_REQUIRED_ACTIONS,
  REDACTION_PLACEHOLDER,
  RETENTION_FLOORS,
  actorTypeSchema,
  auditActionSchema,
  auditResultSchema,
  breakGlassReasonCodeSchema,
  dataClassSchema,
  retentionFloorFor,
  sensitivitySchema,
} from './types.js';

/**
 * `EN-024 §5`: "**No audit, no mutation.**" The audit table is the one table
 * nobody can go back and clean up, so the invariants below are about what must
 * never reach it (secrets, full identifiers) and what must never be missing from
 * it (the hashed field list, the retention floors).
 */

describe('audit vocabulary', () => {
  it('covers every action EN-024 §4 enumerates', () => {
    for (const action of [
      'insert',
      'update',
      'delete',
      'read_phi',
      'export',
      'print',
      'login',
      'logout',
      'approve',
      'reject',
      'sign',
      'override',
      'break_glass',
      'config_change',
    ]) {
      expect(auditActionSchema.safeParse(action).success, `${action} must be an audit action`).toBe(true);
    }
    expect(auditActionSchema.safeParse('view').success).toBe(false);
    expect(auditActionSchema.safeParse('READ_PHI').success).toBe(false);
  });

  it('knows every kind of actor that can mutate a record, including non-humans', () => {
    // An audit row with no resolvable actor fails docs/09 §9 invariant 9.
    for (const actor of ['user', 'service', 'device', 'system', 'patient', 'external_app']) {
      expect(actorTypeSchema.safeParse(actor).success, actor).toBe(true);
    }
    expect(actorTypeSchema.safeParse('anonymous').success).toBe(false);
  });

  it('classifies data and outcomes with closed vocabularies', () => {
    expect(dataClassSchema.options).toEqual(['phi', 'financial', 'hr', 'operational']);
    expect(sensitivitySchema.options).toEqual(['normal', 'sensitive', 'vip']);
    expect(auditResultSchema.options).toEqual(['success', 'denied', 'error']);
    // A denied attempt is audited too — that is the IDOR evidence trail.
    expect(auditResultSchema.safeParse('denied').success).toBe(true);
  });

  it('demands a reason for break-glass, export, deletion and override', () => {
    // EN-024 §5 makes these reason-mandatory.
    for (const action of ['break_glass', 'export', 'delete', 'override']) {
      expect(REASON_REQUIRED_ACTIONS, `${action} must require a reason`).toContain(action);
    }
  });

  it('names only real actions in the reason-required list', () => {
    for (const action of REASON_REQUIRED_ACTIONS) {
      expect(auditActionSchema.safeParse(action).success, `${action} is not an audit action`).toBe(true);
    }
    expect(new Set(REASON_REQUIRED_ACTIONS).size).toBe(REASON_REQUIRED_ACTIONS.length);
  });

  it('offers structured break-glass reason codes rather than free text alone', () => {
    // A free-text-only register cannot be reviewed at volume (EN-024 §3.2.2).
    for (const code of [
      'emergency_cross_cover',
      'on_call_consult',
      'code_blue',
      'patient_request',
      'second_opinion',
      'quality_review',
      'medico_legal',
      'other',
    ]) {
      expect(breakGlassReasonCodeSchema.safeParse(code).success, code).toBe(true);
    }
    expect(breakGlassReasonCodeSchema.safeParse('curiosity').success).toBe(false);
  });
});

describe('audit field masking policy', () => {
  it('declares each column exactly once', () => {
    const keys = DEFAULT_AUDIT_FIELD_POLICIES.map((p) => `${p.entity}.${p.column}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never records a secret, not even masked', () => {
    // EN-024 §3.1.4: "passwords, tokens, API keys → «redacted»". A secret that
    // reached the audit table could never be rotated out of it.
    const secretColumns = [
      'password_hash',
      'pin_hash',
      'recovery_codes_hash',
      'token_hash',
      'refresh_token',
      'client_secret',
      'private_key',
      'api_key',
    ];
    for (const column of secretColumns) {
      const policy = DEFAULT_AUDIT_FIELD_POLICIES.find((p) => p.column === column);
      expect(policy, `${column} has no masking policy`).toBeDefined();
      expect(policy!.mask, `${column} must be excluded outright`).toBe('exclude');
    }
  });

  it('never records a biometric template at all', () => {
    // EN-024 §3.1.4: "biometric templates never appear at all" — a stolen
    // biometric cannot be reissued the way a password can.
    const policy = DEFAULT_AUDIT_FIELD_POLICIES.find((p) => p.column === 'biometric_template');
    expect(policy?.mask).toBe('exclude');
    expect(policy?.dataClass).toBe('phi');
  });

  it('never stores a full statutory identifier', () => {
    // docs/04 §4: masked last-4 + hash only, never the full Aadhaar.
    for (const column of ['aadhaar', 'aadhaar_last4', 'abha_number', 'bank_account_no']) {
      const policy = DEFAULT_AUDIT_FIELD_POLICIES.find((p) => p.column === column);
      expect(policy, `${column} has no masking policy`).toBeDefined();
      expect(policy!.mask, `${column} must not be recorded in full`).not.toBe('none');
    }
    expect(DEFAULT_AUDIT_FIELD_POLICIES.find((p) => p.column === 'abha_token')?.mask).toBe('redact');
  });

  it('requires a reason before an identifier or account number appears in a diff', () => {
    for (const column of ['aadhaar', 'aadhaar_last4', 'abha_token', 'abha_number', 'bank_account_no']) {
      const policy = DEFAULT_AUDIT_FIELD_POLICIES.find((p) => p.column === column)!;
      expect(policy.reasonRequired, `${column} should be reason-gated`).toBe(true);
    }
  });

  it('applies every seed policy to every table, so a new table inherits it', () => {
    // A policy scoped to one table would leave the next module's table unprotected.
    for (const policy of DEFAULT_AUDIT_FIELD_POLICIES) {
      expect(policy.entity, `${policy.column} should be a wildcard policy`).toBe('*');
      expect(['none', 'redact', 'mask_partial', 'exclude']).toContain(policy.mask);
      expect(['phi', 'financial', 'hr', 'operational']).toContain(policy.dataClass);
    }
  });

  it('uses one visually unmistakable redaction placeholder', () => {
    // A placeholder that could be a real value ("***", "REDACTED") is ambiguous
    // when an investigator reads the diff years later.
    expect(REDACTION_PLACEHOLDER).toBe('«redacted»');
  });
});

describe('audit hash chain', () => {
  it('starts from a 32-byte zero genesis hash', () => {
    expect(AUDIT_CHAIN_GENESIS_HASH).toHaveLength(32);
    expect([...AUDIT_CHAIN_GENESIS_HASH].every((b) => b === 0)).toBe(true);
  });

  it('hashes the fields that make a row identifiable and its change reconstructible', () => {
    // EN-024 §3.4: omitting `before`/`after` would let a value be rewritten
    // without breaking the chain, which is the whole threat model.
    for (const field of [
      'seq',
      'hospital_id',
      'occurred_at',
      'actor_user_id',
      'entity',
      'row_id',
      'action',
      'before',
      'after',
      'reason_code',
      'result',
      'prev_hash',
    ]) {
      expect(AUDIT_CHAIN_HASHED_FIELDS, `${field} must be inside the hash`).toContain(field);
    }
  });

  it('chains each entry to the previous one', () => {
    expect(AUDIT_CHAIN_HASHED_FIELDS).toContain('prev_hash');
    expect(AUDIT_CHAIN_HASHED_FIELDS[AUDIT_CHAIN_HASHED_FIELDS.length - 1]).toBe('prev_hash');
  });

  it('lists each field exactly once, because field order is the wire format', () => {
    // Changing this order invalidates every existing chain, so a duplicate here
    // is not a tidy-up, it is a false tamper alarm across every tenant.
    expect(new Set(AUDIT_CHAIN_HASHED_FIELDS).size).toBe(AUDIT_CHAIN_HASHED_FIELDS.length);
    expect(Object.isFrozen(AUDIT_CHAIN_HASHED_FIELDS)).toBe(true);
  });
});

describe('retention floors', () => {
  it('cites a regulation for every floor', () => {
    // EN-024 §5: "any policy below the statutory floor is rejected with the
    // specific regulation cited" — a floor with no citation cannot be defended.
    for (const floor of RETENTION_FLOORS) {
      expect(floor.floorDays, `${floor.dataClass}/${floor.actionClass} has no floor`).toBeGreaterThan(0);
      expect(floor.regulation.length, `${floor.dataClass}/${floor.actionClass} cites nothing`).toBeGreaterThan(15);
    }
  });

  it('declares each data-class/action-class pair once', () => {
    const keys = RETENTION_FLOORS.map((f) => `${f.dataClass}/${f.actionClass}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps clinical and financial mutations for eight years', () => {
    expect(retentionFloorFor('phi', 'clinical_mutation')?.floorDays).toBe(2920);
    expect(retentionFloorFor('financial', 'financial_mutation')?.floorDays).toBe(2920);
    expect(retentionFloorFor('operational', 'config_change')?.floorDays).toBe(2920);
  });

  it('keeps authentication logs for the 180 days CERT-In requires', () => {
    const floor = retentionFloorFor('operational', 'authentication');
    expect(floor?.floorDays).toBe(180);
    expect(floor?.regulation).toMatch(/CERT-In/);
  });

  it('keeps PHI read trails and breach evidence for three years', () => {
    expect(retentionFloorFor('phi', 'read_phi')?.floorDays).toBe(1095);
    expect(retentionFloorFor('security', 'breach_evidence')?.floorDays).toBe(1095);
  });

  it('returns nothing for a pair that has no declared floor, rather than guessing one', () => {
    // Guessing a floor is how data gets purged early; the caller must handle the miss.
    expect(retentionFloorFor('phi', 'authentication')).toBeUndefined();
    expect(retentionFloorFor('marketing', 'clinical_mutation')).toBeUndefined();
  });
});

describe('legal hold', () => {
  it('covers the reasons that keep a row out of archival compaction', () => {
    // docs/04 §5 / docs/07 §5: the retention job aborts rather than archiving these.
    for (const reason of [
      'mlc',
      'forensic',
      'litigation',
      'consumer_court',
      'open_insurance_dispute',
      'regulator_request',
      'minor_patient',
    ]) {
      expect(LEGAL_HOLD_REASONS, `${reason} must hold a record`).toContain(reason);
    }
  });

  it('lists each reason once', () => {
    expect(new Set(LEGAL_HOLD_REASONS).size).toBe(LEGAL_HOLD_REASONS.length);
  });
});
