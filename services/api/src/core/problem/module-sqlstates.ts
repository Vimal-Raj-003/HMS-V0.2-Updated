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
  'IP005', // inpatient billing: charge immutability and the discharge gate
  'IP006', // theatre: the WHO checklist gate, the counts, the sterilisation recall
  'IP007', // blood and the code: the bedside check, the group samples, the cart
  'IP002', // discharge: reconciliation before signature, the immutable summary, the body release
  'SP001', // the specialty console framework: the tab registry, the result lifecycle, the charge intent
  'OP025', // ophthalmology: the acuity ladder, quarter-dioptre steps, the signed prescription, the lens
  'OP010', // procedures and OPD nursing: consent, the time-out, the Aldrete floor, the five rights
  'OP029', // cardiology: the derived QTc, the acknowledged critical ECG, the warfarin grid
  'OP030', // pulmonology: the derived ratio and reversibility, the unsignable grade F, the PAP mode
  'OP028', // ENT: the air-bone gap, the derived four-frequency average, the calibrated booth
  'OP026', // dental: real teeth and their surfaces, the absent tooth, the materialised chart, the fixed price
  'OP027', // dermatology: the derived score, the phototherapy ceiling, the malignant biopsy's follow-up
  'OP015', // therapy: the live plan, the authorisation, the goals a discharge has to close
  'OP017', // wound care: the derived area and trajectory, the wound that heals by closing
  'OP011', // dietetics: totals summed from the meals, and a plan that keeps its own restriction
  'OP035', // speech and swallow: the complete IDDSI order, and the kitchen that has read it
  'OP016', // pain: the derived morphine equivalent, the second reviewer, the agreement, the steroid ceiling
  'OP013', // immunisation: the minimum age and interval, the vial clock, the cold chain hold
  'OP014', // health check-ups: the station sequence, and the report that covers every station
  'OP012', // dialysis: the isolation zone, the machine, the fluid, and the dialyser count
  'OP040', // antenatal: the dating rule, anti-D, PC-PNDT Form F and the MTP gates
  'IP011', // labour room: the action line, the third stage, APGAR and the wristband pair
  'OP031', // oncology: the derived dose, the vinca never-event and the lifetime cap
  'OP032', // psychiatry: presumed capacity, the admission clocks, restraint and ECT
  'OP033', // the two ends of life: the adult ceiling, grams, and the burden
  'IP019', // transplant and ART: the near relative, the panel, and one donation
  'OP018', // the hand-offs: the four telemedicine lists, the referral clock, the pathway variance
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
