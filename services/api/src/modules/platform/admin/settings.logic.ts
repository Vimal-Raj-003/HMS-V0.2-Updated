import { REDACTION_PLACEHOLDER, type SettingDefinition, type SettingScope } from '@vims/contracts';

/**
 * Pure settings logic — resolution, masking and validation.
 *
 * It is separated from the service so it can be tested without a database,
 * because the interesting failures here are not SQL failures. Resolving the
 * wrong precedence silently gives a hospital a different idle timeout from the
 * one its administrator configured, and failing to mask a `secret` writes an SMS
 * gateway key into an audit row that nobody can ever delete.
 */

/**
 * `EN-007 §4`: "Effective value resolution is hierarchical: user → department →
 * branch → hospital → definition default. A NULL at a narrower scope means
 * 'inherit'."
 *
 * Narrowest first. The array order below **is** the precedence, so changing it
 * changes behaviour — which is why it is a named constant rather than a sort
 * comparator somewhere in a query.
 */
export const SETTING_SCOPE_PRECEDENCE: readonly SettingScope[] = Object.freeze([
  'user',
  'department',
  'branch',
  'hospital',
]);

export interface SettingRow {
  readonly key: string;
  readonly branch_id: string | null;
  readonly department_id: string | null;
  readonly user_id: string | null;
  readonly value: unknown;
  readonly updated_at: Date | null;
  readonly updated_by: string | null;
}

export interface ScopeQuery {
  readonly branchId: string | null;
  readonly departmentId: string | null;
  readonly userId: string | null;
}

export function scopeOfRow(row: SettingRow): SettingScope {
  if (row.user_id !== null) return 'user';
  if (row.department_id !== null) return 'department';
  if (row.branch_id !== null) return 'branch';
  return 'hospital';
}

export interface EffectiveSetting {
  readonly key: string;
  readonly module: string;
  readonly label: string;
  readonly description: string;
  readonly scopes: readonly SettingScope[];
  readonly sensitivity: string;
  readonly requiresApproval: boolean;
  readonly dualControl: boolean;
  readonly defaultValue: unknown;
  readonly value: unknown;
  /** Which scope the effective value came from; `default` means nothing is set. */
  readonly source: SettingScope | 'default';
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  /** True when the value shown is a placeholder because the key is a secret. */
  readonly masked: boolean;
}

/**
 * `EN-007 §5`: "sensitive settings (payment keys, SMS keys) stored encrypted and
 * **masked in UI/exports**." The masking happens here, before the value reaches
 * a response body, an audit diff or a log line — not in the UI, where forgetting
 * it once leaks the key.
 */
export function maskIfSecret(
  definition: SettingDefinition,
  value: unknown,
): { value: unknown; masked: boolean } {
  if (definition.sensitivity !== 'secret') return { value, masked: false };
  return { value: value === undefined || value === null ? null : REDACTION_PLACEHOLDER, masked: true };
}

export function resolveEffectiveSetting(
  definition: SettingDefinition,
  rows: readonly SettingRow[],
  query: ScopeQuery,
): EffectiveSetting {
  const relevant = rows.filter(
    (row) =>
      row.key === definition.key &&
      (row.user_id === null || row.user_id === query.userId) &&
      (row.department_id === null || row.department_id === query.departmentId) &&
      (row.branch_id === null || row.branch_id === query.branchId),
  );

  let winner: SettingRow | undefined;
  for (const scope of SETTING_SCOPE_PRECEDENCE) {
    winner = relevant.find((row) => scopeOfRow(row) === scope);
    if (winner !== undefined) break;
  }

  const rawValue = winner === undefined ? definition.defaultValue : winner.value;
  const { value, masked } = maskIfSecret(definition, rawValue);

  return {
    key: definition.key,
    module: definition.module,
    label: definition.label,
    description: definition.description,
    scopes: definition.scopes,
    sensitivity: definition.sensitivity,
    requiresApproval: definition.requiresApproval,
    dualControl: definition.dualControl,
    defaultValue: maskIfSecret(definition, definition.defaultValue).value,
    value,
    source: winner === undefined ? 'default' : scopeOfRow(winner),
    updatedAt: winner?.updated_at?.toISOString() ?? null,
    updatedBy: winner?.updated_by ?? null,
    masked,
  };
}

export type SettingWriteCheck =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: 'unknown_key'; readonly message: string }
  | { readonly ok: false; readonly code: 'scope_not_allowed'; readonly message: string }
  | { readonly ok: false; readonly code: 'invalid_value'; readonly message: string }
  | { readonly ok: false; readonly code: 'needs_approval'; readonly message: string }
  | { readonly ok: false; readonly code: 'reason_required'; readonly message: string };

/**
 * Everything that has to be true before a setting may be written.
 *
 * `requiresApproval` and `dualControl` keys are **refused** rather than applied,
 * because `EN-007 §5` routes them through the approval engine (EN-038) and that
 * is not wired yet. Applying them anyway would quietly delete a control — the
 * session idle timeout is an approval-gated key precisely so one administrator
 * cannot widen it alone.
 */
export function checkSettingWrite(input: {
  readonly definition: SettingDefinition | undefined;
  readonly scope: SettingScope;
  readonly value: unknown;
  readonly reason: string | null;
}): SettingWriteCheck {
  const { definition } = input;
  if (definition === undefined) {
    return {
      ok: false,
      code: 'unknown_key',
      message: 'That setting is not declared in packages/contracts, so nothing reads it.',
    };
  }

  if (!definition.scopes.includes(input.scope)) {
    return {
      ok: false,
      code: 'scope_not_allowed',
      message: `"${definition.key}" may only be set at: ${definition.scopes.join(', ')}.`,
    };
  }

  if (definition.requiresApproval || definition.dualControl) {
    return {
      ok: false,
      code: 'needs_approval',
      message:
        `"${definition.key}" needs approval before it can change (EN-007 §5), and the approval workflow ` +
        'is not available yet. Nothing was changed.',
    };
  }

  const parsed = definition.schema.safeParse(input.value);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_value',
      message: parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '(value)'}: ${issue.message}`)
        .join('; '),
    };
  }

  // A change to a restricted or secret key is a configuration change that
  // EN-024 §5 lists as reason-mandatory.
  if (definition.sensitivity !== 'normal' && (input.reason === null || input.reason.trim().length === 0)) {
    return {
      ok: false,
      code: 'reason_required',
      message: `"${definition.key}" is a sensitive setting; a reason is required and is recorded.`,
    };
  }

  return { ok: true, value: parsed.data };
}
