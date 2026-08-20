import type { AuditEntry as AuditDiffEntry, AuditFieldChange } from '@vims/ui';
import type { AuditRow } from '../api/types';
import { formatTimestamp, humaniseFieldName, renderAuditValue } from './format';

/**
 * Turns one stored audit row into the before/after diff `AuditDiffViewer` renders.
 *
 * Pure, and separated from the screen, because this is where an investigation
 * actually happens: a DPO asking "who changed this and to what" is reading the
 * output of this function. Two decisions in it are load-bearing.
 *
 * **`changed_fields` is trusted when present, and reconstructed when it is not.**
 * The writer computes it; a row from an older writer, or a `create`/`delete`
 * action where every field changed, can arrive with it empty. Falling back to the
 * union of the two documents' keys means such a row still shows its contents
 * instead of an empty table that reads as "nothing changed".
 *
 * **A field whose value is unchanged is still listed if the writer named it.**
 * The audit log is evidence; silently dropping a row's own account of what it
 * touched would be editing the evidence.
 */
export function auditFieldChanges(row: AuditRow): readonly AuditFieldChange[] {
  const before = asRecord(row.before);
  const after = asRecord(row.after);

  const fields =
    row.changed_fields.length > 0
      ? [...row.changed_fields]
      : [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

  return fields.map((field) => ({
    field: humaniseFieldName(field),
    before: renderAuditValue(before[field]),
    after: renderAuditValue(after[field]),
  }));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export interface AuditDiffOptions {
  readonly timeZone?: string;
  /** Resolves an actor id to a name where the console already knows one. */
  readonly resolveActor?: (userId: string) => string | undefined;
}

export function toAuditDiffEntry(row: AuditRow, options: AuditDiffOptions = {}): AuditDiffEntry {
  const actorId = row.actor_user_id;
  const actorName = actorId === null ? 'System' : (options.resolveActor?.(actorId) ?? actorId);

  const reason = row.reason_text ?? row.reason_code;

  return {
    id: row.id,
    actorName,
    actorRole: row.actor_role ?? 'unknown role',
    at: formatTimestamp(row.occurred_at, options.timeZone),
    changes: auditFieldChanges(row),
    // `sealed_at` is set by the chain sealer once the row has been folded into
    // the hash chain. It is evidence that the row is tamper-evident, not a live
    // re-verification, and the labels the viewer is given say exactly that.
    hashChainVerified: row.sealed_at !== null,
    ...(reason === null ? {} : { reason }),
    // `ipAddress` and `device` are deliberately left unset. The API does not
    // return either on this row, and filling them with the trace id or the route
    // — which it does return — would put a value under a label that means
    // something else on a screen whose entire purpose is evidence. Both are
    // rendered beside the viewer, under their own names.
  };
}

/** Whether a row records a refusal — rendered with a danger chip, never colour alone. */
export function isDenial(row: AuditRow): boolean {
  return row.result !== 'success';
}
