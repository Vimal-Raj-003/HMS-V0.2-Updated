/**
 * The custom SQLSTATEs whose messages are written for the person who hit them.
 *
 * Each module's triggers raise its own five-character SQLSTATE with a sentence
 * a clinician or a clerk can act on — "MLC 0003 is not complete: the police
 * intimation dispatched is still outstanding", not "constraint violation". A
 * module's own error mapper passes its own code straight through.
 *
 * ── Why this list is shared ─────────────────────────────────────────────────
 *
 * Because a trigger fires wherever the write happens, not where the rule lives.
 * TR-008's discharge gate sits on `er_dispositions`, so it fires inside
 * **OP-006's** service, whose mapper had never heard of `TR008` — and a blocked
 * discharge came back as HTTP 500 "Something went wrong on our side" instead of
 * the sentence naming exactly what was outstanding. The rule worked perfectly
 * and the person at the desk could not tell.
 *
 * Every mapper consults this set, so a cross-module refusal reaches the caller
 * whichever module's endpoint it happened to arrive through.
 */
export const MODULE_SQLSTATES: ReadonlySet<string> = new Set([
  'RC006', // revenue leakage
  'RC007', // government schemes
  'RC008', // cost estimator
  'NC034', // doctor payouts
  'OP006', // ER intake and dispositions
  'TR001', // triage, trauma activation, scores
  'TR008', // MLC register, evidence chain, discharge gate
  'TR009', // pre-hospital record, pre-alert, handover
  'NC013', // ambulance fleet: dispatch, documents, billing
  'TR002', // fracture registry: laterality, classification, union
  'TR003', // implant traceability: permanence, reuse, recall closure
  'TR005', // cast and traction: laterality, the red flag and its action
  'TR007', // polytrauma board: the sequence, consent, blood, escalation, closure
  'IP001', // beds and admissions: one patient per bed, the cleaning gate, discharge
  'IP003', // the MAR's five rights, the witness, the escalation ladder, risk bands
]);

/**
 * A message safe to show, or `null` when this is not one of ours.
 *
 * Returning the trigger's own text is deliberate: writing a second, friendlier
 * version here would give the codebase two sentences for one rule, and the one
 * next to the rule is the one that stays true.
 */
export function moduleRefusalMessage(code: string, message: string | undefined): string | null {
  if (!MODULE_SQLSTATES.has(code)) return null;
  return message ?? 'This action is not allowed on this record in its current state.';
}
