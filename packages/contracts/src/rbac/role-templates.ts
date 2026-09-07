/**
 * The 64 system role templates from `docs/05 §System role templates`.
 *
 * `EN-007 §3.3.2`: "**System role templates** (60+ per docs/05) seeded as
 * read-only templates; hospital clones to **custom roles**."
 *
 * A template's permission set is deliberately *thin in Phase 0*. A ward nurse
 * genuinely can do almost nothing yet — there is no MAR, no vitals, no chart —
 * and inflating the list now would produce a role matrix that lies. Each later
 * phase appends the keys its modules register, and `permission-matrix.json`
 * (docs/09 §3.2) turns every such change into a reviewed diff of who can now do
 * what.
 *
 * The home workspace is what `/login` routes to (docs/05 §Login/UX flow).
 */
import type { AbacConditions } from './abac.js';
import { assertRegisteredPermission } from './permissions.js';

export type WorkspaceKey =
  | 'tenant-console'
  | 'admin-console'
  | 'branch-admin'
  | 'clinical-governance'
  | 'department-dashboard'
  | 'doctor-opd'
  | 'ip-rounds'
  | 'er-board'
  | 'ot-schedule'
  | 'anaesthesia-worklist'
  | 'icu-board'
  | 'radiology-reading'
  | 'lab-validation'
  | 'referral-portal'
  | 'vitals-room'
  | 'nursing-station'
  | 'icu-flowsheet'
  | 'triage-board'
  | 'ot-checklist'
  | 'infection-control'
  | 'nursing-command-centre'
  | 'task-list'
  | 'registration'
  | 'call-console'
  | 'cash-counter'
  | 'billing-desk'
  | 'insurance-queue'
  | 'corporate-accounts'
  | 'pharmacy-rx-queue'
  | 'pharmacy-ward-indents'
  | 'pharmacy-admin'
  | 'lab-bench'
  | 'lab-collection'
  | 'lab-qc'
  | 'radiology-modality'
  | 'blood-bank'
  | 'cssd'
  | 'diet-worklist'
  | 'therapy-schedule'
  | 'dialysis-board'
  // Phase 8. A console's home is its own worklist, so the specialty sub-roles
  // land on the lane they run rather than on a generic clinical dashboard.
  | 'ophtha-worklist'
  | 'cardiopulmonary-lab'
  | 'audiology-booth'
  | 'dental-chair'
  | 'counselling-sessions'
  | 'mrd-queue'
  | 'stores'
  | 'procurement'
  | 'finance'
  | 'hr'
  | 'biomedical'
  | 'facility'
  | 'housekeeping'
  | 'gate-console'
  | 'ambulance-dispatch'
  | 'kitchen-board'
  | 'quality'
  | 'crm'
  | 'it-console'
  | 'privacy-dashboard'
  | 'audit-workspace'
  | 'patient-portal'
  | 'family-view'
  | 'corporate-portal'
  | 'payer-portal'
  | 'vendor-portal'
  | 'device-display';

export type RoleCategory =
  | 'saas'
  | 'admin'
  | 'medical'
  | 'nursing'
  | 'diagnostics'
  | 'pharmacy'
  | 'therapy'
  | 'records'
  | 'supply'
  | 'finance'
  | 'facilities'
  | 'governance'
  | 'external'
  | 'device';

export interface RoleTemplate {
  /** Stable key. Referenced by SSO group mappings and seeds; never renamed. */
  readonly key: string;
  /** Row number in docs/05 §System role templates, so the mapping is auditable. */
  readonly docsRow: number;
  readonly name: string;
  readonly description: string;
  readonly category: RoleCategory;
  readonly homeWorkspace: WorkspaceKey;
  readonly permissions: readonly string[];
  readonly abacDefaults: AbacConditions;
  /**
   * `docs/04 §2`: "MFA: TOTP mandatory for Admin, Finance, Pharmacy-narcotics,
   * Blood bank, MRD-export, Privacy Officer"; EN-007 §3.4.2 adds Billing,
   * Insurance and IT.
   */
  readonly mfaMandatory: boolean;
  /** Granting this role needs two approvers (EN-007 §5). */
  readonly sensitiveGrant: boolean;
  /** Resident/intern roles: their clinical output needs a consultant co-sign (docs/05 row 14). */
  readonly requiresCoSign: boolean;
}

// ── composable permission bundles ────────────────────────────────────────────

/** What literally every authenticated staff member can do. */
const BASE_STAFF = [
  'org.read',
  'mdm.read',
  'tpl.form.read',
  'lic.entitlement.read',
  'gateway.status.read',
  'print.job.create',
  'print.job.read',
  'wf.request.create',
  'wf.request.read',
  'wf.delegation.manage',
] as const;

/** Anyone who touches a patient. */
const BASE_CLINICAL = [
  ...BASE_STAFF,
  'barcode.scan',
  'tpl.response.write',
  'tpl.response.read',
  'tpl.render',
  'org.patient.locate',
  'org.patient.cross_access',
] as const;

/** Clinicians who may break glass in an emergency (docs/05 §Login: "any clinician"). */
const BREAK_GLASS = ['org.patient.break_glass'] as const;

/** Anyone who signs a clinical document. */
const SIGNS_DOCUMENTS = ['tpl.response.sign', 'tpl.response.amend'] as const;

/** Anyone who approves things. */
const APPROVER = ['wf.decide', 'wf.report.read'] as const;

/** Department heads. */
const HOD_BASE = [
  ...APPROVER,
  'admin.access.approve',
  'admin.access.review',
  'admin.role.read',
  'audit.user.read',
  'mdm.quality.read',
  'notify.report.read',
] as const;

/** Label/wristband printing roles. */
const LABEL_PRINTER = ['barcode.label.print', 'barcode.label.reprint'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 bundles — Patient & Front Office
//
// Grouped so a grant is made once and reused, rather than repeated as a long
// literal across roles where one entry can silently drift.
// ─────────────────────────────────────────────────────────────────────────────

/** Read-only access to the patient master. Everyone who touches a patient needs it. */
const PATIENT_READ = ['patient.record.read', 'patient.record.list'] as const;

/**
 * The front-office registration grant.
 *
 * Deliberately excludes `patient.merge.execute`, `patient.record.export` and
 * `patient.record.create_override` — OP-001 §12 keeps merge with MRD, export
 * behind an audited grant, and the duplicate override behind its own key, so
 * that bypassing the duplicate check is a decision somebody is named for.
 */
const PATIENT_DESK = [
  ...PATIENT_READ,
  'patient.record.create',
  'patient.record.update',
  'patient.record.print',
  'patient.mobile.verify',
  'patient.alert.manage',
  'consent.capture',
  'consent.read',
  'consent.guardian.manage',
] as const;

const APPOINTMENT_DESK = [
  'appointment.slot.read',
  'appointment.create',
  'appointment.list',
  'appointment.update',
  'appointment.cancel',
  'appointment.waitlist',
] as const;

const VISIT_DESK = ['visit.create', 'visit.list', 'visit.update', 'visit.cancel', 'visit.transfer'] as const;

/** Issue and read tokens. Calling one is a separate grant, held by whoever runs the room. */
const QUEUE_DESK = ['queue.token.issue', 'queue.token.read', 'queue.board.read'] as const;

/** Held by anyone who calls the next patient — scoped to their own queues by ABAC. */
const QUEUE_CALLER = ['queue.token.read', 'queue.token.call', 'queue.board.read'] as const;

const ABHA_DESK = [
  'abdm.abha.create',
  'abdm.abha.verify',
  'abdm.abha.link',
  'abdm.abha.read',
  'abdm.scan_share.manage',
  'abdm.hip.link',
] as const;

/** A cashier's day: open a shift, collect, reprint, close. Refunds and voids are separate keys. */
const CASHIER_BASE = [
  'receipt.shift.open',
  'receipt.shift.read',
  // A cashier cannot find their own open shift without this. `.read` needs an id
  // the cashier has no way to obtain, so the omission did not restrict a
  // sensitive action -- it made the role's first action of the day impossible.
  'receipt.shift.list',
  'receipt.shift.close',
  'receipt.collect',
  'receipt.reprint',
  'receipt.drawer.open',
  'receipt.daybook.read',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 bundles — OPD clinical core
//
// Built the way CASHIER_BASE and PATIENT_DESK are: a grant is made once and
// composed, so "who may sign a prescription" is one line to read rather than
// eleven literals to diff.
// ─────────────────────────────────────────────────────────────────────────────

/** Terminology and drug lookup. Every prescriber, coder and pharmacist needs it. */
const CLINICAL_LOOKUP = ['terminology.read', 'rx.drug.search'] as const;

/**
 * The CDSS safety floor (EN-040 §5, D-9).
 *
 * Held by every role that can put a drug or an order in front of a patient, and
 * kept whole: a clinician who can fire an alert but cannot read or answer it is
 * worse off than one with no CDSS at all, because the order simply stops.
 */
const CDSS_SAFETY_FLOOR = [
  'cdss.evaluate',
  'cdss.alert.read',
  'cdss.alert.respond',
  'cdss.snapshot.read',
  'cdss.score.read',
] as const;

/** Reading a chart without writing to it. */
const CHART_READ = ['opd.encounter.read', 'opd.inbox.read', 'vitals.record.read'] as const;

/** The consultation loop: queue → note → diagnosis → sign. */
const CONSULTATION = [
  ...CHART_READ,
  'opd.queue.read',
  'opd.queue.manage',
  'opd.encounter.create',
  'opd.encounter.update',
  'opd.encounter.sign',
  'opd.encounter.amend',
  'opd.diagnosis.update',
  'opd.allergy.update',
  'opd.result.acknowledge',
  'opd.certificate.create',
  'opd.preferences.manage',
  'opd.template.manage',
  'vitals.alert.acknowledge',
  'vitals.recheck.request',
] as const;

/** Prescribing. Schedule X / NDPS is deliberately not in here. */
const PRESCRIBER = ['rx.create', 'rx.sign', 'rx.amend', 'rx.cancel', 'rx.print'] as const;

/** CPOE. */
const ORDERING = ['order.create', 'order.list', 'order.cancel'] as const;

/** The doctor PWA. `mobile.offline_rx` is a separate grant — OP-019 §12 withholds it from residents. */
const MOBILE_CLINICIAN = ['mobile.sync', 'auth.device.manage'] as const;

/**
 * A consultant-grade doctor's Phase 2 surface.
 *
 * Includes `rx.cosign` (releasing a resident's Rx) and the MRD keys a doctor
 * needs to answer a coder and clear their own record deficiencies — but not
 * `mrd.deficiency.waive`, which is a governance decision, nor
 * `rx.schedule_x.prescribe`, which each role takes explicitly.
 */
/**
 * NC-034 — what a doctor may see and say about their own earnings.
 *
 * Reading the statement and disputing it, and nothing else. A doctor cannot
 * compute, approve or pay one — but "that consultation was mine" has to be
 * sayable by the only person who would know, and a payout system where the
 * earner cannot query the figure is one they have to argue about by email.
 *
 * ABAC scopes the read to their own statements; the permission alone does not.
 */
/**
 * OP-006 — the emergency floor.
 *
 * Held widely on purpose. `er.quickreg` is the key that gets an unconscious
 * patient a tag, a wristband and a bay in under thirty seconds; a permission
 * model that made it hard to reach would be one that killed somebody. The
 * consequential keys — merging an identity, ending an episode — are the ones
 * that carry a reason.
 */
const ER_FLOOR = [
  'er.board.read',
  'er.visit.read',
  'er.quickreg',
  'er.visit.update',
  'er.bay.assign',
  'er.prealert.receive',
] as const;

/**
 * TR-001 — the triage desk.
 *
 * `triage.level.override` sits in the same bundle as the triage itself, not in a
 * senior one. The nurse standing in front of the patient is the person who knows
 * the algorithm is wrong about them, and an override that needs a supervisor is
 * an override that becomes a level nobody corrected.
 */
/**
 * TR-008 — the medico-legal floor.
 *
 * Opening a case, documenting injuries and sealing evidence. Held by everybody
 * who is in the room when an assault victim arrives, because an MLC nobody
 * opened is a case the hospital cannot later prove it saw. Nothing in this
 * bundle discloses, releases or closes anything.
 */
/**
 * NC-013 — the dispatch desk.
 *
 * Assigning a vehicle, following it, closing the trip. Not diverting one, and
 * not overriding a failed check: those two are the decisions somebody has to
 * own by name.
 */
/**
 * TR-002 — anybody who sees the film.
 *
 * Registering a fracture provisionally is held as widely as triaging one, and
 * for the same reason: a fracture nobody entered is a fracture the registry
 * never counts and a follow-up nobody schedules. Confirming the AO code is not
 * in here — that is a treatment decision written as a number.
 */
const FRACTURE_FLOOR = [
  'fracture.record.create',
  'fracture.record.read',
  'fracture.record.list',
  'fracture.record.update',
  'fracture.event.record',
  'fracture.imaging.assess',
  'fracture.complication.record',
] as const;

/** The orthopaedic surgeon: the classification, the plan, and the union call. */
const FRACTURE_SURGEON = [
  ...FRACTURE_FLOOR,
  'fracture.classification.confirm',
  'fracture.plan.set',
  'fracture.union.declare',
  'ortho.episode.create',
  'ortho.episode.read',
  'ortho.exam.record',
  'ortho.followup.schedule',
  'ortho.prom.collect',
] as const;

/** The ortho clinic desk and nursing: exams, schedules, outcomes. */
const ORTHO_CLINIC = [
  'fracture.record.read',
  'fracture.record.list',
  'ortho.episode.read',
  'ortho.exam.record',
  'ortho.followup.schedule',
  'ortho.prom.collect',
] as const;

/**
 * TR-003 — whoever is holding the box.
 *
 * Recording the device is deliberately at the trolley, not at the desk. The
 * failure mode this avoids is the surgeon typing a serial from memory in the
 * evening, which is exactly the record a field safety notice cannot match.
 */
const IMPLANT_AT_THE_TROLLEY = [
  'implant.catalogue.read',
  'implant.stock.read',
  'implant.usage.record',
  'implant.usage.manual',
  'implant.usage.read',
] as const;

/** The surgeon: the same, plus taking one out and saying why. */
const IMPLANT_SURGEON = [...IMPLANT_AT_THE_TROLLEY, 'implant.usage.explant'] as const;

/**
 * Anyone who has to know what is inside a patient before they act.
 *
 * Radiology is the reason this bundle exists separately: a conditional implant
 * in a 3T scanner is a burn, and the conditionality is a property of the
 * catalogue entry, not of anything on the request form.
 */
const IMPLANT_LOOKUP = ['implant.catalogue.read', 'implant.usage.read'] as const;

/**
 * Running a recall.
 *
 * Held by quality rather than by the store, because the store is who bought the
 * device. The person reconciling a field safety notice should not be the person
 * whose purchasing it reflects on.
 */
const IMPLANT_RECALL_OFFICER = [
  'implant.catalogue.read',
  'implant.stock.read',
  'implant.usage.read',
  'implant.recall.manage',
  'implant.recall.read',
  'implant.recall.contact',
  'implant.trace.query',
] as const;

/** The implant store: the catalogue, the shelf, and what a recall means for it. */
const IMPLANT_STORE = [
  'implant.catalogue.read',
  'implant.catalogue.manage',
  'implant.stock.read',
  'implant.stock.receive',
  'implant.stock.adjust',
  'implant.recall.read',
] as const;

/**
 * TR-005 — the plaster room.
 *
 * Applying and checking is routine work and reads that way. `cast.remove` is
 * not in here: a cast off three weeks early is a fracture that displaces in the
 * car park, so it sits with the people who set the plan.
 */
const PLASTER_ROOM = [
  'cast.request.create',
  'cast.request.read',
  'cast.apply',
  'cast.check.record',
  'cast.pinsite.manage',
] as const;

/** The neurovascular check, for anyone at the bedside who is not applying plaster. */
const CAST_WATCH = ['cast.request.read', 'cast.check.record'] as const;

/**
 * TR-007 — everybody who touches the board.
 *
 * Reading it is held widely: the whole point of a coordination board is that
 * the neurosurgeon can see what orthopaedics is planning without asking, and a
 * board only the trauma lead can read is a whiteboard with extra steps.
 */
const POLYTRAUMA_FLOOR = [
  'polytrauma.case.read',
  'polytrauma.case.list',
  'polytrauma.consult.request',
  'polytrauma.consult.respond',
  'polytrauma.task.manage',
  'polytrauma.huddle.record',
  'polytrauma.family.update',
] as const;

/**
 * The surgeons and the trauma lead: the queue itself.
 *
 * `polytrauma.procedure.sequence` is the one key in this module graded `high`.
 * Reordering the queue is the decision the board exists to make visible, and a
 * definitive case moved ahead of a life-saving one is a patient who dies with a
 * beautifully fixed femur — so it takes a reason, and the database refuses the
 * arrangement anyway.
 */
const POLYTRAUMA_SURGICAL = [
  ...POLYTRAUMA_FLOOR,
  'polytrauma.case.open',
  'polytrauma.case.close',
  'polytrauma.procedure.plan',
  'polytrauma.procedure.sequence',
  'polytrauma.procedure.state',
  'polytrauma.consent.record',
  'polytrauma.blood.plan',
  'polytrauma.consult.escalate',
  'polytrauma.team.assign',
] as const;

/**
 * The waiver is separate from recording an ordinary consent.
 *
 * An unconscious patient with no next of kin can lawfully have their bleeding
 * stopped. Deciding that is a consultant's call, not a registrar's, and it is
 * held by the people who can be answerable for it afterwards.
 */
const POLYTRAUMA_WAIVER = ['polytrauma.consent.waive'] as const;

/** Nursing on the board: the tasks, the consults, and what the family were told. */
const POLYTRAUMA_NURSING = [
  ...POLYTRAUMA_FLOOR,
  'polytrauma.consent.record',
  'polytrauma.procedure.state',
] as const;

/**
 * Phase 7A — the bed board, held as widely as the question "where is my patient?"
 *
 * A board only the bed manager can read is a board everybody phones the bed
 * manager about, which is how a hospital ends up with a whiteboard beside the
 * screen and two answers to one question.
 */
const BED_BOARD_READER = ['bed.board.read', 'census.read', 'admission.read', 'admission.list'] as const;

/** The ward: admit, move, and keep the expected discharge honest. */
const WARD_FLOOR = [
  ...BED_BOARD_READER,
  'admission.request',
  'admission.update',
  'transfer.read',
  'transfer.accept',
  'census.discharge.plan',
] as const;

/** The admitting desk and the bed manager: the allocation itself. */
const BED_MANAGEMENT = [
  ...WARD_FLOOR,
  'bed.allocate',
  'bed.hold.create',
  'bed.hold.release',
  'admission.admit',
  'transfer.execute',
  'census.demand.manage',
] as const;

/** Taking a bed out of service, and putting the hospital into surge. */
const BED_COMMAND = [...BED_MANAGEMENT, 'bed.block', 'bed.config.manage', 'census.surge.declare'] as const;

/** Housekeeping's own worklist. */
const HOUSEKEEPING_FLOOR = ['bed.board.read', 'housekeeping.task.read', 'housekeeping.task.accept'] as const;

/**
 * Phase 7B — the bedside.
 *
 * `mar.administer` sits in the widest bundle here, deliberately. The control on
 * a dose is the scan and the witness, both enforced by the database; making the
 * permission scarce would push drug rounds onto one nurse's login, which
 * defeats the witness rule by making one person do everything.
 */
const NURSING_BEDSIDE = [
  'nursing.ward.read',
  'nursing.assessment.record',
  'nursing.note.write',
  'nursing.io.record',
  'mar.read',
  'mar.administer',
  'mar.witness',
  'mar.omit',
  'escalation.read',
  'escalation.acknowledge',
  'infection.device.record',
] as const;

/** The nurse in charge: assignments, the handover, and closing an escalation. */
const NURSING_IN_CHARGE = [
  ...NURSING_BEDSIDE,
  'nursing.assignment.manage',
  'nursing.handover.compose',
  'nursing.handover.sign',
  'escalation.resolve',
  'infection.isolation.manage',
] as const;

/** The prescriber's half of the chart. Not administration — that is the bedside. */
const MAR_PRESCRIBER = [
  'mar.read',
  'mar.order.write',
  'mar.order.discontinue',
  'nursing.ward.read',
  'escalation.read',
  'escalation.acknowledge',
  'escalation.resolve',
] as const;

/** Infection control's own view. */
const INFECTION_CONTROL = [
  'nursing.ward.read',
  'infection.device.record',
  'infection.isolation.manage',
  'infection.hai.read',
  'infection.hai.adjudicate',
] as const;

/** Phase 7C — the inpatient bill, as the ward and the desk see it. */
const IP_BILL_READER = ['ipbill.read', 'ipbill.charge.explain', 'ipbill.clearance.read'] as const;

/** Billing's own: running the job, clearing the gate. */
const IP_BILL_DESK = [...IP_BILL_READER, 'ipbill.charge.run', 'ipbill.clearance.clear'] as const;

/** Phase 7D — the theatre floor. */
const OT_FLOOR = [
  'ot.board.read',
  'ot.case.book',
  'ot.preop.record',
  'ot.checklist.signin',
  'ot.checklist.timeout',
  'ot.checklist.signout',
  'ot.intraop.record',
] as const;

/** The surgeon: the note, and closing the case. */
const OT_SURGEON = [
  ...OT_FLOOR,
  'ot.case.schedule',
  'ot.case.close',
  'ot.note.write',
  'ot.case.bump',
] as const;

/** Sterile supply's own cycle. */
const CSSD_FLOOR = [
  'cssd.set.manage',
  'cssd.load.run',
  'cssd.indicator.record',
  'cssd.load.release',
  'cssd.issue',
] as const;

/** Phase 7E — the intensive care bedside. */
const ICU_BEDSIDE = [
  'icu.flowsheet.read',
  'icu.flowsheet.record',
  'icu.bundle.record',
  'cart.check.record',
  'code.call',
  'code.record',
] as const;

/** Phase 7F — transfusing at the bedside. */
const BLOOD_BEDSIDE = [
  'blood.inventory.read',
  'blood.sample.record',
  'blood.transfuse',
  'blood.reaction.report',
] as const;

/** The blood bank's own counter. */
const BLOOD_BANK = [
  'blood.donor.manage',
  'blood.unit.manage',
  'blood.inventory.read',
  'blood.issue',
  'blood.reaction.report',
] as const;

/** Phase 7G — the doctor's half of a discharge, up to and including signing. */
const DISCHARGE_CLINICAL = [
  'ip.discharge.read',
  'ip.discharge.initiate',
  'ip.discharge.reconcile',
  'ip.discharge.summary.write',
  'ip.discharge.summary.sign',
  'ip.discharge.dama',
] as const;

/**
 * The consultant's two extra keys: countersigning a resident's summary, and
 * issuing a new version of one already signed.
 *
 * A resident holds `DISCHARGE_CLINICAL` and can sign — waiting for a consultant
 * to be free before a patient may go home is how discharges slip to the evening
 * and the bed is lost for a day. What the resident cannot do is close the loop
 * alone: they have no `cosign` key, and the database refuses a countersignature
 * from the person who signed.
 */
const DISCHARGE_CONSULTANT = [
  ...DISCHARGE_CLINICAL,
  'ip.discharge.summary.cosign',
  'ip.discharge.summary.amend',
] as const;

/** The ward's half: watch the worklist, and record that the patient actually left. */
const DISCHARGE_WARD = ['ip.discharge.read', 'ip.discharge.complete'] as const;

/**
 * IP-017 — declaring a death and certifying it.
 *
 * `mortuary.mccd.write` is not in the resident bundle. Every other clinical
 * output a resident produces here is countersigned by a consultant, and a
 * certificate of cause of death is a document with no countersignature slot: it
 * goes to the Registrar under one name. So it is signed by somebody whose
 * signature stands on its own.
 */
const MORTUARY_CLINICAL = ['mortuary.case.read', 'mortuary.case.create', 'mortuary.mccd.write'] as const;

/** The custodian of the register, and the only holder of the release itself. */
const MORTUARY_CUSTODIAN = [
  'mortuary.case.read',
  'mortuary.body.operate',
  'mortuary.pm.write',
  'mortuary.release.manage',
  'mortuary.report.read',
] as const;

/**
 * Phase 8 — what everybody on a specialty console holds.
 *
 * The worklist and the stage clock are the floor: a console whose queue only
 * the doctor can read is a queue everybody phones the doctor about, and a stage
 * only the doctor can advance is a turnaround report that measures nothing.
 */
const CONSOLE_FLOOR = ['console.registry.read', 'console.worklist.read', 'console.stage.record'] as const;

/** The clinician's half of the shared device path: order it, and say you saw it. */
const CONSOLE_CLINICIAN = [
  ...CONSOLE_FLOOR,
  'device.result.order',
  'device.result.review',
  'device.result.cancel',
] as const;

/**
 * The technician's half: perform it and attach it — never review it.
 *
 * The split is the point of the lifecycle. If the person who runs the scanner
 * could also mark it reviewed, "reviewed" would mean "uploaded", and the rail
 * of unseen results — the whole reason the state exists — would always be empty.
 */
const CONSOLE_TECHNICIAN = [...CONSOLE_FLOOR, 'device.result.attach'] as const;

/** Composing a console: who may change what a department sees tomorrow. */
const CONSOLE_ADMIN = [
  'console.registry.read',
  'console.registry.configure',
  'console.device_type.configure',
] as const;

/**
 * OP-025 — the eye clinic.
 *
 * The optometrist's half and the ophthalmologist's half are separated at the
 * signature, not at the measurement: an optometrist records everything and
 * signs nothing unless the hospital has delegated the spectacle prescription
 * to them, which is `OPTOMETRIST_DELEGATED`.
 */
const OPHTHA_OPTOMETRY = ['ophtha.visit.read', 'ophtha.visit.create', 'ophtha.optometry.record'] as const;

const OPHTHA_DOCTOR = [
  ...OPHTHA_OPTOMETRY,
  'ophtha.exam.record',
  'ophtha.exam.sign',
  'ophtha.spectacle_rx.sign',
  'ophtha.spectacle_rx.print',
  'ophtha.surgery.plan',
  'ophtha.surgery.book',
  'ophtha.report.read',
] as const;

/**
 * A resident records and plans, and does not sign.
 *
 * The same line Phase 2 drew for prescriptions and Phase 7 for discharge
 * summaries: a resident's clinical output is countersigned, and an eye visit
 * signed by nobody senior is a document a referring optician relies on.
 */
const OPHTHA_RESIDENT = [...OPHTHA_OPTOMETRY, 'ophtha.exam.record', 'ophtha.surgery.plan'] as const;

/**
 * OP-029, OP-030, OP-028, OP-026, OP-027 — the five device-heavy consoles.
 *
 * Each splits the same way the eye clinic does, and for the same reason: the
 * split is at the signature, not at the measurement. A technician runs the
 * machine and enters everything; the report is a clinical opinion somebody else
 * will act on, so it is signed by whoever the hospital stands behind.
 *
 * The audiologist is the exception, and deliberately so — audiology is a
 * registered profession whose whole scope is producing and interpreting the
 * audiogram, so the signature belongs to them rather than being lent to them.
 */
const CARDIO_TECHNICIAN = ['cardio.ecg.record', 'cardio.ecg.read', 'cardio.stress.conduct'] as const;

const CARDIO_DOCTOR = [
  ...CARDIO_TECHNICIAN,
  'cardio.consult.read',
  'cardio.consult.record',
  'cardio.consult.sign',
  'cardio.ecg.interpret',
  'cardio.ecg.acknowledge_critical',
  'cardio.echo.report',
  'cardio.echo.sign',
  'cardio.anticoag.manage',
  'cardio.report.read',
] as const;

const PULMO_TECHNICIAN = ['pulmo.pft.perform', 'pulmo.sleep.score'] as const;

const PULMO_DOCTOR = [
  ...PULMO_TECHNICIAN,
  'pulmo.consult.read',
  'pulmo.consult.record',
  'pulmo.consult.sign',
  'pulmo.pft.interpret',
  'pulmo.sleep.sign',
  'pulmo.pap.prescribe',
  'pulmo.pap.review_compliance',
  'pulmo.report.read',
] as const;

const ENT_AUDIOLOGY = [
  'ent.audiology.perform',
  'ent.audiology.read',
  'ent.audiology.sign',
  'ent.hearing_aid.dispense',
] as const;

const ENT_DOCTOR = [
  'ent.exam.read',
  'ent.exam.record',
  'ent.exam.sign',
  'ent.audiology.read',
  'ent.report.read',
] as const;

const DENTAL_HYGIENE = ['dental.chart.read', 'dental.chart.record', 'dental.perio.record'] as const;

const DENTAL_DOCTOR = [
  ...DENTAL_HYGIENE,
  'dental.plan.create',
  'dental.plan.present',
  'dental.sitting.record',
  'dental.lab_order.manage',
  'dental.report.read',
] as const;

/**
 * OP-012 and IP-022 — the dialysis floor.
 *
 * The split is not seniority, it is who may touch the *needle*, the *drug* and
 * the *zone*. A technician runs the machines, logs the filters and records the
 * session; a nurse additionally declares an access fit to cannulate and ends a
 * session early; a nephrologist writes the prescription and, with it, the
 * ultrafiltration ceiling every session is then checked against.
 *
 * Nobody on any of these lists can re-zone a machine. `dialysis.machine.rezone`
 * ships unassigned, because the person who decides that a hepatitis machine is
 * now a general machine should be somebody the hospital chose in advance, not
 * whoever was on the afternoon shift when it got busy.
 */
const DIALYSIS_FLOOR = [
  'dialysis.program.read',
  'dialysis.session.schedule',
  'dialysis.session.record',
  'dialysis.machine.manage',
  'dialysis.dialyser.log',
  'dialysis.dialyser.reprocess',
  'dialysis.dialyser.discard',
] as const;

const DIALYSIS_NURSE = [...DIALYSIS_FLOOR, 'dialysis.access.manage', 'dialysis.session.abort'] as const;

const DIALYSIS_DOCTOR = [
  ...DIALYSIS_NURSE,
  'dialysis.program.manage',
  'dialysis.prescription.write',
  'dialysis.report.read',
] as const;

/**
 * OP-040 — the antenatal clinic.
 *
 * The split follows the statutes rather than seniority. Running a clinic is
 * wide: a nurse records the visit, marks the schedule and does the postnatal
 * screen, and the gestational age and warning score are the database's either
 * way. Four keys are not wide, and each for a named reason.
 *
 *   · `obg.edd.override` moves every date in the record, so it belongs to
 *     whoever can defend the judgement in front of a growth chart.
 *   · `obg.mtp.record` and `obg.mtp.read` are the register the MTP Rules
 *     require. The Act names a registered medical practitioner, and so does
 *     this.
 *   · `pcpndt.form_f.sign` goes to radiology, but the *register* — the list
 *     that makes a signature lawful — ships unassigned, because the person who
 *     decides who may sign under the PC-PNDT Act should be chosen in advance
 *     rather than inherited.
 */
const ANC_FLOOR = [
  'obg.pregnancy.read',
  'obg.visit.record',
  'obg.schedule.manage',
  'obg.pnc.record',
] as const;

const ANC_CLINICIAN = [
  ...ANC_FLOOR,
  'obg.pregnancy.register',
  'obg.pregnancy.update',
  'obg.visit.sign',
  'obg.delivery_plan.write',
  'obg.edd.override',
  'obg.mtp.record',
  'obg.mtp.read',
  'obg.report.read',
] as const;

/**
 * IP-011 — the labour room.
 *
 * The split is by who is in the room. A midwife runs the labour, plots the
 * chart, records the birth and the baby, and scans the bands; the decision at
 * the action line is the obstetrician's, because the five things it names —
 * augment, assist, section, refer, continue — are a doctor's to choose; and
 * Form 1 belongs to medical records, because a statutory return to a Registrar
 * is not a clinical note.
 *
 * Nobody holds a key to plot past the action line, because there is none.
 */
const LABOUR_FLOOR = [
  'obs.labour.read',
  'obs.labour.admit',
  'obs.partograph.write',
  'obs.delivery.write',
  'obs.pph.manage',
  'obs.newborn.write',
  'obs.identity.verify',
] as const;

const LABOUR_DOCTOR = [...LABOUR_FLOOR, 'obs.partograph.decide', 'obs.report.read'] as const;

/**
 * OP-031 and IP-023 — oncology.
 *
 * Four holders, in the order a dose passes through them. The oncologist writes
 * the plan and signs the cycle; the pharmacist recomputes it independently and
 * can stop it; two nurses verify it at the chair; a second oncologist signs a
 * cycle whose counts say not to.
 *
 * `onco.pharmacy.verify` is the one worth staring at. It goes to pharmacy and
 * to nobody else — not to the oncologist, not to the day-care nurse. Two people
 * doing the same arithmetic separately is the control that catches a decimal
 * point, and it only works if the second one is a different person who can stop
 * the first.
 */
const ONCO_CHAIR = ['onco.case.read', 'onco.administer', 'onco.toxicity.record'] as const;

const ONCO_DOCTOR = [
  ...ONCO_CHAIR,
  'onco.case.manage',
  'onco.plan.write',
  'onco.cycle.schedule',
  'onco.cycle.sign',
  'onco.cycle.cosign',
  'onco.report.read',
] as const;

const ONCO_PHARMACY = ['onco.case.read', 'onco.pharmacy.verify'] as const;

/**
 * OP-032 — psychiatry.
 *
 * The Act's own divisions, not a hospital's. A counsellor records scales and
 * reads the episode; a psychiatrist assesses capacity, admits under the Act,
 * orders restraint and runs a course of electroconvulsive therapy. Nursing
 * records the observations during a restraint but does not order one — the two
 * are different acts and §97 names which is which.
 */
const PSY_THERAPY = ['psy.episode.read', 'psy.scale.record'] as const;

const PSY_NURSING = [
  ...PSY_THERAPY,
  'psy.restraint.record',
  'psy.admission.record',
  'psy.ect.session.record',
] as const;

const PSY_PSYCHIATRIST = [
  ...PSY_NURSING,
  'psy.episode.manage',
  'psy.capacity.assess',
  'psy.instrument.manage',
  'psy.admission.manage',
  'psy.restraint.order',
  'psy.ect.manage',
  'psy.report.read',
] as const;

const DERM_DELIVERY = ['derm.lesion.read', 'derm.phototherapy.deliver'] as const;

const DERM_DOCTOR = [
  'derm.lesion.read',
  'derm.lesion.record',
  'derm.score.record',
  'derm.photo.capture',
  'derm.biopsy.manage',
  'derm.phototherapy.prescribe',
  'derm.phototherapy.deliver',
  'derm.report.read',
] as const;

/**
 * Every console a hospital's general clinical roles can be pointed at.
 *
 * The keys are held broadly and the *console* is narrowed by two things that
 * are not permissions: the licence (`module.<key>.enabled`) and the department
 * the encounter belongs to. A cardiologist and a dermatologist hold the same
 * template and see different screens, because a hospital that has to mint a
 * role per specialty ends up with sixty roles and grants them by guesswork.
 */
/**
 * OP-016 — the pain clinic.
 *
 * The one console where the split is not clinician-versus-technician but
 * prescriber-versus-reviewer, and it is held apart on purpose: a doctor who can
 * both prescribe at 120 MME and countersign their own prescription has the
 * threshold and none of the control.
 */
const PAIN_CLINIC = [
  'pain.episode.read',
  'pain.episode.create',
  'pain.assessment.record',
  'pain.plan.write',
  'pain.opioid.read',
  'pain.agreement.sign',
  'pain.intervention.perform',
  'pain.report.read',
] as const;

/** Reading a pain episode without prescribing on it. For the wider floor. */
const PAIN_READER = ['pain.episode.read', 'pain.opioid.read'] as const;

/**
 * OP-013 and OP-014 — the programme consoles.
 *
 * Giving a vaccine is nursing work and is held right across the floor, because
 * an immunisation session is run by whoever is in the room. The two keys that
 * are not are the two that change what other people can do: deciding the fate
 * of a breached batch, and striking a dose from a child's record.
 */
const IMMUNISATION_FLOOR = [
  'immunisation.record.read',
  'immunisation.dose.administer',
  'immunisation.plan.manage',
  'immunisation.vial.open',
  'immunisation.vial.discard',
  'immunisation.coldchain.record',
  'immunisation.aefi.report',
  'immunisation.certificate.issue',
] as const;

/** The health check floor: the routing slip, and the stations on it. */
const HEALTHCHECK_FLOOR = [
  'healthcheck.episode.read',
  'healthcheck.episode.checkin',
  'healthcheck.station.record',
] as const;

const HEALTHCHECK_CLINICAL = [
  ...HEALTHCHECK_FLOOR,
  'healthcheck.report.write',
  'healthcheck.report.sign',
  'healthcheck.report.read',
] as const;

/**
 * What a doctor holds across the therapy consoles.
 *
 * Read everything, refer into anything, and sign nothing a therapist signs. A
 * consultant does not write a physiotherapy plan or an IDDSI order — those are
 * the therapist's registered scope, and a doctor overruling one by having the
 * key is how a swallow recommendation gets quietly downgraded.
 */
const THERAPY_REFERRER = [
  'therapy.episode.read',
  'therapy.episode.create',
  'therapy.report.read',
  'wound.read',
  'wound.plan.write',
  'wound.report.read',
  'nutrition.assessment.read',
  'nutrition.ip_order.write',
  'slp.swallow_order.read',
] as const;

const SPECIALTY_CONSOLE_DOCTOR = [
  ...CARDIO_DOCTOR,
  ...PULMO_DOCTOR,
  ...ENT_DOCTOR,
  ...DENTAL_DOCTOR,
  ...DERM_DOCTOR,
  ...THERAPY_REFERRER,
  ...PAIN_CLINIC,
  // A paediatrician gives vaccines. Withholding the key from doctors while
  // giving it to every nurse would be an org chart nobody has.
  ...IMMUNISATION_FLOOR,
  'immunisation.report.read',
  ...HEALTHCHECK_CLINICAL,
  ...DIALYSIS_DOCTOR,
  ...ANC_CLINICIAN,
  ...LABOUR_DOCTOR,
  ...ONCO_DOCTOR,
  ...PSY_PSYCHIATRIST,
] as const;

/** A resident records and plans; the signature and the override keys are not theirs. */
/**
 * OP-015, OP-017, OP-011, OP-035 — the therapy floor.
 *
 * The spine keys are held by every therapist regardless of discipline, because
 * the *episode* carries the discipline and the department carries the
 * therapist. Two keys for one act — `physio.session.record` and
 * `slp.session.record` — would have been a grant matrix nobody could reason
 * about the day somebody works across two clinics.
 */
const THERAPY_FLOOR = [
  'therapy.episode.read',
  'therapy.episode.create',
  'therapy.assessment.record',
  'therapy.goal.manage',
  'therapy.session.record',
] as const;

/** A qualified therapist signs the assessment and writes the plan. */
const THERAPY_QUALIFIED = [
  ...THERAPY_FLOOR,
  'therapy.assessment.sign',
  'therapy.plan.write',
  'therapy.episode.discharge',
  'therapy.report.read',
] as const;

/** The wound clinic. Dressing changes are nursing's; the regime is not. */
const WOUND_BEDSIDE = ['wound.read', 'wound.record', 'wound.photo.capture', 'wound.dressing.record'] as const;
const WOUND_CLINIC = [...WOUND_BEDSIDE, 'wound.plan.write', 'wound.report.read'] as const;

const NUTRITION_CLINIC = [
  'nutrition.assessment.read',
  'nutrition.assessment.record',
  'nutrition.plan.write',
  'nutrition.food.manage',
  'nutrition.ip_order.write',
  'nutrition.report.read',
] as const;

/**
 * The swallow order splits three ways, and the split is the safety rule.
 *
 * The speech therapist writes it and cannot acknowledge it. The kitchen and the
 * ward acknowledge it and cannot write it. Everybody else reads it — a nurse
 * who cannot see what a patient may safely eat is a nurse who will offer them
 * a glass of water.
 */
const SLP_CLINICAL = [
  'slp.assessment.record',
  'slp.assessment.sign',
  'slp.swallow_order.write',
  'slp.swallow_order.read',
  'slp.report.read',
] as const;
const SWALLOW_ACKNOWLEDGER = ['slp.swallow_order.read', 'slp.swallow_order.acknowledge'] as const;

const SPECIALTY_CONSOLE_RESIDENT = [
  ...CARDIO_TECHNICIAN,
  'cardio.consult.read',
  'cardio.consult.record',
  ...PULMO_TECHNICIAN,
  'pulmo.consult.read',
  'pulmo.consult.record',
  'ent.exam.read',
  'ent.exam.record',
  'ent.audiology.read',
  ...DENTAL_HYGIENE,
  'dental.sitting.record',
  'derm.lesion.read',
  'derm.lesion.record',
  'derm.score.record',
  ...PAIN_READER,
  'pain.assessment.record',
] as const;

/**
 * OP-010 — the procedure floor.
 *
 * The time-out key is held as widely as the floor itself, deliberately. It takes
 * two people in the room and it does not matter who they are; a scarce key would
 * mean waiting for a particular person to walk past, and a ritual people wait
 * for is a ritual people skip.
 */
const PROCEDURE_FLOOR = [
  'procedure.order.read',
  'procedure.checklist.record',
  'procedure.timeout.confirm',
  'procedure.consumable.record',
] as const;

/** Whoever does the procedure: order it, do it, sign it, discharge from it. */
const PROCEDURE_OPERATOR = [
  ...PROCEDURE_FLOOR,
  'procedure.order.create',
  'procedure.booking.manage',
  'procedure.checklist.override',
  'procedure.perform',
  'procedure.sign',
  'procedure.recovery.record',
] as const;

/** OP-039 — the injection, dressing and plaster rooms. */
const OPD_NURSING_FLOOR = [
  'opdnursing.task.read',
  'opdnursing.task.manage',
  'opdnursing.administer',
  'opdnursing.administer.verify',
  'opdnursing.dressing.record',
  'procedure.order.read',
  'procedure.checklist.record',
  'procedure.timeout.confirm',
  'procedure.recovery.record',
] as const;

const FLEET_DISPATCH = [
  'fleet.vehicle.read',
  'fleet.request.create',
  'fleet.request.read',
  'fleet.trip.dispatch',
  'fleet.trip.read',
  'fleet.trip.update',
  'fleet.trip.close',
] as const;

/** The crew: the checks, the milestones, and the fuel log. */
const FLEET_CREW = [
  'fleet.vehicle.read',
  'fleet.trip.read',
  'fleet.trip.update',
  'fleet.checklist.record',
  'fleet.fuel.record',
  'fleet.incident.record',
] as const;

/** Whoever runs the fleet: the register, the papers, the workshop, the reports. */
const FLEET_MANAGER = [
  ...FLEET_DISPATCH,
  'fleet.vehicle.manage',
  'fleet.document.manage',
  'fleet.crew.manage',
  'fleet.maintenance.manage',
  'fleet.checklist.override',
  'fleet.trip.divert',
  'fleet.incident.record',
  'fleet.report.read',
] as const;

/**
 * TR-009 — the crew's clinical record.
 *
 * Writing it and raising the pre-alert are both `low`: a crew member who cannot
 * warn the ER is a resus bay nobody prepared, and that is the failure this
 * module exists to prevent.
 */
const PREHOSPITAL_CREW = [
  'prehospital.pcr.write',
  'prehospital.pcr.read',
  'prehospital.pcr.sign',
  'prehospital.prealert.raise',
  'prehospital.prealert.read',
  'prehospital.handover.complete',
] as const;

/** The receiving end: read what is inbound, answer it, hold a bay. */
const PREHOSPITAL_RECEIVER = [
  'prehospital.pcr.read',
  'prehospital.prealert.read',
  'prehospital.prealert.acknowledge',
  'prehospital.handover.complete',
] as const;

const MLC_FLOOR = [
  'mlc.case.create',
  'mlc.case.read',
  'mlc.case.update',
  'mlc.intimation.create',
  'mlc.injury.write',
  'mlc.evidence.capture',
  'mlc.evidence.read',
  'mlc.custody.transfer',
] as const;

/** The designated medico-legal officer: everything the floor has, plus the pen. */
const MLC_OFFICER = [
  ...MLC_FLOOR,
  'mlc.register.read',
  'mlc.intimation.dispatch',
  'mlc.report.create',
  'mlc.report.read',
  'mlc.report.sign',
  'mlc.death.write',
] as const;

/**
 * TR-008 — the records office.
 *
 * Reads the register, issues certified copies, answers requisitions, and holds
 * MRD custody of evidence. Deliberately cannot open a case or write an injury:
 * a coder is not a witness.
 */
const MLC_RECORDS = [
  'mlc.case.read',
  'mlc.register.read',
  'mlc.evidence.read',
  'mlc.custody.transfer',
  'mlc.report.read',
  'mlc.report.export',
  'mlc.request.manage',
] as const;

/**
 * TR-008 — security.
 *
 * Carries the intimation to the station and captures the constable's signature;
 * witnesses a custody transfer; witnesses a handover. Reads nothing clinical.
 */
const MLC_SECURITY = ['mlc.intimation.dispatch', 'mlc.custody.transfer', 'mlc.evidence.handover'] as const;

/**
 * TR-008 — the four keys that only the Medical Superintendent holds.
 *
 * Cancelling a case, letting a patient leave with the set incomplete, reading a
 * sensitive case, and issuing a certified copy. Each carries a reason, and
 * `sensitiveGrant` means granting any of them needs two approvers.
 */
const MLC_OVERSIGHT = [
  'mlc.case.cancel',
  'mlc.discharge.override',
  'mlc.sensitive.read',
  'mlc.report.export',
  'mlc.request.manage',
  'mlc.register.read',
] as const;

const TRIAGE_FLOOR = [
  'triage.record.create',
  'triage.record.read',
  'triage.record.list',
  'triage.level.override',
  'mci.incident.read',
] as const;

/**
 * TR-001 — everyone who answers a trauma page.
 *
 * `trauma.activation.create` is here rather than in the lead bundle for the
 * reason the catalogue gives: under-triage is the failure mode, so calling the
 * team is the easy action and standing it down is the considered one.
 */
const TRAUMA_TEAM = [
  'trauma.activation.create',
  'trauma.activation.read',
  'trauma.activation.list',
  'trauma.page.acknowledge',
  'trauma.survey.record',
  'trauma.survey.read',
  'trauma.injury.record',
  'trauma.score.compute',
  'trauma.score.read',
] as const;

/** The team leader: the one person who can release the team, and sign the score. */
const TRAUMA_LEAD = [...TRAUMA_TEAM, 'trauma.activation.standdown', 'trauma.score.lock'] as const;

/**
 * TR-001 — the trauma registry.
 *
 * Coding and amending, without the floor keys. A registry coder correcting an
 * AIS three weeks later should not also be able to call the team.
 */
const TRAUMA_REGISTRY = [
  'trauma.activation.read',
  'trauma.activation.list',
  'trauma.survey.read',
  'trauma.injury.record',
  'trauma.score.compute',
  'trauma.score.read',
  'trauma.score.lock',
  'trauma.score.amend',
] as const;

/** Declaring an MCI converts the whole hospital. Two roles hold it, not twenty. */
const MCI_COMMAND = ['mci.incident.declare', 'mci.incident.standdown', 'mci.incident.read'] as const;

const PAYOUT_EARNER = ['payout.statement.read', 'payout.statement.list', 'payout.dispute.raise'] as const;

const DOCTOR_CLINICAL = [
  ...CLINICAL_LOOKUP,
  ...CDSS_SAFETY_FLOOR,
  ...CONSULTATION,
  ...PRESCRIBER,
  ...ORDERING,
  ...MOBILE_CLINICIAN,
  'rx.cosign',
  // Phase 4 — the prescriber's half of the pharmacy loop: decide the
  // substitution the counter proposed, and see what was actually dispensed.
  'rx.substitution.approve',
  'pharmacy.substitution.read',
  'pharmacy.substitution.list',
  'pharmacy.dispense.read',
  'pharmacy.dispense.list',
  'order.admission.request',
  'mrd.coding.query.answer',
  'mrd.deficiency.read',
  'mrd.deficiency.resolve',
  'mobile.offline_rx',
] as const;

/**
 * A resident's surface: everything a consultant has minus the signatures.
 *
 * No `rx.sign`, no `opd.encounter.sign`, no `rx.cosign`, no
 * `rx.schedule_x.prescribe` and no `mobile.offline_rx` — docs/05 row 14 and
 * OP-002 §12 ("no schedule_x unless granted", sign per department config) make
 * the resident's output something a consultant puts their name to.
 */
const RESIDENT_CLINICAL = [
  ...CLINICAL_LOOKUP,
  ...CDSS_SAFETY_FLOOR,
  ...CHART_READ,
  ...MOBILE_CLINICIAN,
  'opd.queue.read',
  'opd.encounter.create',
  'opd.encounter.update',
  'opd.diagnosis.update',
  'opd.allergy.update',
  'opd.preferences.manage',
  'opd.template.manage',
  'rx.create',
  'rx.print',
  'order.create',
  'order.list',
  // Sees what the counter dispensed; does not decide a substitution against a
  // prescription they could not sign in the first place (docs/05 row 14).
  'pharmacy.dispense.read',
  'pharmacy.dispense.list',
] as const;

/** A diagnostic consultant (radiologist, pathologist): reads charts and orders, prescribes nothing. */
const DIAGNOSTIC_CLINICIAN = [
  ...CLINICAL_LOOKUP,
  ...CDSS_SAFETY_FLOOR,
  ...CHART_READ,
  ...MOBILE_CLINICIAN,
  'order.list',
] as const;

/** Charting observations. Held by every nurse; recording vitals is never signing an Rx. */
const VITALS_RECORDER = ['vitals.record.create', 'vitals.record.read', 'cdss.score.compute'] as const;

/** MRD's Phase 2 desk: assemble, code, scan, retain. QA and destruction approval sit elsewhere. */
const MRD_DESK = [
  'mrd.record.list',
  'mrd.record.read',
  'mrd.record.close',
  'mrd.record.reopen',
  'mrd.record.export',
  'mrd.search',
  'mrd.deficiency.read',
  'mrd.deficiency.resolve',
  'mrd.coding.list',
  'mrd.coding.assign',
  'mrd.coding.code',
  'mrd.scan.operate',
  'mrd.scan.qa',
  'mrd.retention.manage',
  'mrd.report.read',
  'mrd.configure',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 bundles — Diagnostics
//
// Built the way MRD_DESK and VITALS_RECORDER are: the grant is made once and
// composed, so "who may authorise a result" or "who may sign a radiology
// report" is one line to read rather than thirty literals to diff.
//
// The separations these bundles encode come from docs/05 §Segregation of duties
// and the §5 rules of OP-004, OP-008, EN-004 and EN-031, and are asserted in
// `phase3-grants.spec.ts`:
//   • the bench enters and technically verifies; only the pathologist authorises;
//   • whoever runs QC never authorises release past their own out-of-control run;
//   • the technologist who made the exposure never signs the report;
//   • a resident drafts and never finalises anything that needs a co-signature.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What any clinician needs to see what came back. Read-only: no order is placed
 * and no result is changed from here.
 *
 * `rad.image.view` and `rad.study.read` are care-team-scoped by ABAC, not by the
 * key — holding them is necessary and never sufficient (EN-008 §5).
 */
const DIAGNOSTIC_RESULTS_READER = [
  'lab.order.list',
  'lab.order.read',
  'lab.result.read',
  'lab.report.read',
  'lab.critical.read',
  'rad.order.read',
  'rad.order.list',
  'rad.study.read',
  'rad.image.view',
  'rad.report.read',
  'rad.critical.read',
  'rad.dose.read',
  'invest.report.read',
  'invest.media.read',
] as const;

/** The ordering clinician's full diagnostics surface. Cancellation carries a reason. */
const DIAGNOSTIC_ORDERING = [
  ...DIAGNOSTIC_RESULTS_READER,
  'lab.order.create',
  'lab.order.addon',
  'lab.order.cancel',
  'rad.order.create',
  'rad.order.cancel',
] as const;

/**
 * A ward or OPD nurse's diagnostics surface: see the order, see the result, see
 * the critical alert. Sample collection is deliberately not here — OP-004 §12
 * gives `lab.sample.*` to the phlebotomy role, and a hospital that draws bloods
 * on the ward grants it to its nursing clone explicitly rather than by default.
 */
const WARD_DIAGNOSTICS = [
  'lab.order.list',
  'lab.order.read',
  'lab.result.read',
  'lab.report.read',
  'lab.critical.read',
  'rad.order.read',
  'rad.order.list',
  'rad.report.read',
  'rad.critical.read',
  'invest.report.read',
] as const;

/** The front desk: raise a walk-in order, book a slot, hand a report over. No results. */
const DIAGNOSTIC_FRONT_DESK = [
  'lab.order.create',
  'lab.order.list',
  'lab.order.read',
  'lab.report.print',
  'lab.report.deliver',
  'rad.order.create',
  'rad.order.read',
  'rad.order.list',
  'rad.schedule.manage',
  'invest.schedule.manage',
] as const;

/** Phlebotomy: the pre-analytical loop, from label to accession. */
const LAB_COLLECTION = [
  'lab.order.list',
  'lab.order.read',
  'lab.sample.label',
  'lab.sample.collect',
  'lab.sample.reject',
  'lab.sample.receive',
  'lab.sample.custody',
] as const;

/**
 * The bench. Enters and technically verifies; never authorises.
 *
 * `lab.result.validate` is absent by construction (docs/05: enterer ≠ validator),
 * and so are `labq.qc.approve` and `labq.qc.release_override` — the technician
 * who ran the control is the last person who should decide that results may go
 * out despite it (EN-031 §5).
 */
const LAB_BENCH = [
  ...LAB_COLLECTION,
  'lab.sample.update',
  'lab.result.enter',
  'lab.result.verify',
  'lab.result.read',
  'lab.report.read',
  'lab.critical.read',
  'lab.outsource.manage',
  'lab.qc.read',
  'lab.qc.record',
  'lab.instrument.downtime.record',
  'lab.interface.errors.resolve',
  'integration.lab.read',
  'labq.qc.read',
  'labq.qc.enter',
  'labq.qc.action',
] as const;

/**
 * The pathologist / Lab Director: authorisation, the critical-value loop, and
 * the Director-only decisions EN-031 §5 reserves — QC target approval, method
 * validation approval, the monthly review signature and the release override.
 */
const LAB_VALIDATION = [
  'lab.order.list',
  'lab.order.read',
  'lab.result.read',
  'lab.result.validate',
  'lab.result.amend',
  'lab.result.sensitive.read',
  'lab.critical.notify',
  'lab.critical.read',
  'lab.report.generate',
  'lab.report.print',
  'lab.report.deliver',
  'lab.report.read',
  'lab.master.configure',
  'lab.qc.read',
  'lab.qc.unlock',
  'lab.autoval.sign',
  'labq.qc.read',
  'labq.qc.approve',
  'labq.qc.release_override',
  'labq.validation.approve',
  'labq.competency.manage',
  'labq.review.sign',
  'labq.indicator.review',
  'labq.report.read',
] as const;

/**
 * The Lab Quality Manager: the accreditation system and the rules the bench
 * runs under. Authors auto-validation rule sets but never signs them into
 * service (EN-004 §5), and never enters a QC run.
 */
const LAB_QUALITY = [
  'lab.order.list',
  'lab.order.read',
  'lab.report.read',
  'lab.master.configure',
  'lab.outsource.manage',
  'lab.instrument.manage',
  'lab.qc.read',
  'lab.qc.configure',
  'lab.qc.unlock',
  'lab.autoval.configure',
  'lab.autoval.approve',
  'integration.lab.read',
  'integration.lab.configure',
  'labq.qc.read',
  'labq.qc.manage',
  'labq.qc.void',
  'labq.qc.action',
  'labq.eqa.manage',
  'labq.validation.manage',
  'labq.equipment.manage',
  'labq.environment.manage',
  'labq.checklist.manage',
  'labq.accreditation.manage',
  'labq.indicator.review',
  'labq.nc.manage',
  'labq.auditpack.generate',
  'labq.report.read',
] as const;

/**
 * The radiographer's console. Holds `rad.study.complete`, and therefore may
 * never hold `rad.report.sign` — OP-008 §5 admits only a registered radiologist,
 * and the person who chose the exposure is not an independent reader of it.
 */
const RADIOLOGY_MODALITY = [
  'rad.order.read',
  'rad.order.list',
  'rad.order.update',
  'rad.schedule.manage',
  'rad.mwl.manage',
  'rad.mwl.read',
  'rad.study.read',
  'rad.study.complete',
  'rad.study.reconcile',
  'rad.dose.record',
  'rad.image.view',
  'rad.image.upload',
] as const;

/**
 * The reading room. Adds to `DIAGNOSTIC_RESULTS_READER`, which already carries
 * the read-only half.
 *
 * `rad.telerad.read` sits here because docs/05 fixes the template set at 64 rows
 * and none of them is "external tele-radiologist": a hospital clones the
 * radiologist template for a partner account, and ABAC narrows it to assigned
 * studies only (EN-008 §5).
 */
const RADIOLOGY_READING = [
  'rad.order.update',
  'rad.mwl.read',
  'rad.image.annotate',
  'rad.image.share',
  'rad.report.create',
  'rad.report.preliminary',
  'rad.report.sign',
  'rad.report.amend',
  'rad.report.deliver',
  'rad.report.print',
  'rad.critical.notify',
  'rad.peer_review.create',
  'rad.peer_review.read',
  'rad.pnpdt.manage',
  'rad.mlc.read',
  'rad.ai.read',
  'rad.telerad.manage',
  'rad.telerad.read',
] as const;

/** The investigation console technician: run the study, capture the media, annotate. */
const INVESTIGATION_TECH = [
  'invest.worklist.read',
  'invest.schedule.manage',
  'invest.study.manage',
  'invest.media.create',
  'invest.media.read',
  'invest.media.annotate',
] as const;

/**
 * The reporting doctor on the investigation console. `invest.report.cosign` is
 * here and deliberately absent from the resident grant — a co-signature that the
 * author can supply is not a co-signature (OP-022 §5).
 */
const INVESTIGATION_REPORTER = [
  'invest.worklist.read',
  'invest.media.read',
  'invest.media.manage',
  'invest.media.annotate',
  'invest.report.create',
  'invest.report.update',
  'invest.report.read',
  'invest.report.sign',
  'invest.report.cosign',
  'invest.report.amend',
  'invest.report.critical',
  'invest.report.deliver',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 bundles — Pharmacy, Stores & Supply Chain
//
// Built the way LAB_BENCH and CASHIER_BASE are: a grant is made once and
// composed, so "who may approve a purchase order" is one line to read rather
// than five literals to diff.
//
// Two rules shape every bundle below, and both have cost a phase before:
//
//  1. **A `.read` is useless without its `.list`.** `CASHIER_BASE` carries the
//     comment: `receipt.shift.list` was omitted once and the cashier could not
//     find their own open shift, because `.read` needs an id the cashier had no
//     way to obtain. That is not a restriction, it is a role that cannot start
//     its day. `phase4-grants.spec.ts` now asserts the property for every
//     template rather than trusting anybody to remember it.
//
//  2. **A second-person key is granted, never decorated.** The four
//     `pharmacy.narcotic.*` co-signed keys appear in the grants below because a
//     pharmacist must hold them to be a valid first *or* second signature — but
//     the route they are exercised through is decorated with
//     `pharmacy.narcotic.prepare` or `pharmacy.dispense.create`. See the note
//     above the Phase-4 block in `permissions.ts`.
//
// And the separations these bundles encode come from `docs/04 §3`,
// `docs/05 §Segregation of duties`, NC-005 §12 and NC-021 §12:
//   • the buyer raises the order and never approves it;
//   • whoever posts the receipt never releases the invoice for payment;
//   • whoever counts the shelf never approves their own variance;
//   • whoever onboards a vendor never approves it, and never its bank account.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What anybody who touches stock needs: find an item, find a store, see what is
 * on the shelf. Read-only and held by every supply, pharmacy and sub-store role.
 */
const STOCK_LOOKUP = [
  'inventory.item.read',
  'inventory.item.list',
  'inventory.store.read',
  'inventory.store.list',
  'inventory.stock.read',
  'inventory.stock.list',
  'inventory.batch.read',
  'inventory.batch.list',
] as const;

/**
 * A ward, theatre, laboratory or kitchen sub-store: indent from the main store,
 * receive what arrives, return what is unused, record what was consumed and
 * count the shelf. Deliberately no adjustment, no approval and no write-off —
 * those belong to the store in-charge.
 */
const SUB_STORE_CUSTODIAN = [
  ...STOCK_LOOKUP,
  'inventory.store_indent.create',
  'inventory.store_indent.read',
  'inventory.store_indent.list',
  'inventory.issue.receive',
  'inventory.issue.read',
  'inventory.issue.list',
  'inventory.return.create',
  'inventory.return.read',
  'inventory.return.list',
  'inventory.count.count',
  'inventory.count.read',
  'inventory.count.list',
  'inventory.consumption.record',
  'inventory.consumption.read',
  'inventory.consumption.list',
  'inventory.consumption.reverse',
  'inventory.label.print',
] as const;

/**
 * The main store: receive, put away, pick, issue, transfer, count.
 *
 * Holds `inventory.grn.post` and therefore may never hold
 * `inventory.invoice.approve` — NC-005 §12, and the pair is a blocking
 * segregation rule. Holds `inventory.count.count` and therefore never
 * `inventory.count.approve`. Raises adjustments and never approves them.
 */
const STORES_DESK = [
  ...STOCK_LOOKUP,
  'inventory.item.params.configure',
  'inventory.item.gtin.map',
  'inventory.ledger.read',
  'inventory.ledger.list',
  'inventory.stock.putaway',
  'inventory.store_indent.read',
  'inventory.store_indent.list',
  'inventory.store_indent.approve',
  'inventory.issue.pick',
  'inventory.issue.create',
  'inventory.issue.read',
  'inventory.issue.list',
  'inventory.issue.emergency.create',
  'inventory.return.read',
  'inventory.return.list',
  'inventory.return.inspect',
  'inventory.transfer.create',
  'inventory.transfer.read',
  'inventory.transfer.list',
  'inventory.transfer.dispatch',
  'inventory.transfer.receive',
  'inventory.adjustment.create',
  'inventory.adjustment.read',
  'inventory.adjustment.list',
  'inventory.batch.quarantine',
  'inventory.batch.trace',
  'inventory.expiry.read',
  'inventory.coldchain.read',
  'inventory.coldchain.decide',
  'inventory.reorder.read',
  'inventory.reorder.manage',
  'inventory.count.plan',
  'inventory.count.count',
  'inventory.count.read',
  'inventory.count.list',
  'inventory.analysis.read',
  'inventory.label.print',
  'inventory.report.read',
  'inventory.fefo.override',
  'inventory.grn.create',
  'inventory.grn.qc',
  'inventory.grn.post',
  // Reversing a receipt the dock itself posted, with a reason and compensating
  // ledger entries. NC-005 §5 refuses it once the stock has been issued, which
  // is what keeps "I mis-keyed the batch" apart from "make the shortage go away".
  'inventory.grn.reverse',
  // The emergency that has to stay countable: goods that arrive with no order
  // behind them. Its own key, its own reason, its own report line.
  'inventory.grn.without_po.create',
  'inventory.grn.read',
  'inventory.grn.list',
  'inventory.analysis.run',
  'inventory.consumption.read',
  'inventory.consumption.list',
  'inventory.indent.create',
  'inventory.indent.read',
  'inventory.indent.list',
] as const;

/**
 * The buyer's desk: indent to order, and the vendor register behind it.
 *
 * `inventory.po.create` without `inventory.po.approve` is the whole point —
 * `docs/04 §3` puts maker and checker on different people for a purchase order,
 * and the value bands in EN-038 decide who the checker is. Likewise
 * `vendor.master.manage` without `vendor.master.approve` or
 * `vendor.bank.approve`.
 */
const PROCUREMENT_DESK = [
  ...STOCK_LOOKUP,
  'inventory.indent.read',
  'inventory.indent.list',
  'inventory.indent.cancel',
  'inventory.rfq.create',
  'inventory.rfq.send',
  'inventory.rfq.read',
  'inventory.rfq.list',
  'inventory.quotation.enter',
  'inventory.quotation.read',
  'inventory.quotation.list',
  'inventory.comparative.compare',
  'inventory.comparative.read',
  'inventory.comparative.list',
  'inventory.rate_contract.read',
  'inventory.rate_contract.list',
  'inventory.rate_contract.manage',
  'inventory.po.create',
  'inventory.po.read',
  'inventory.po.list',
  'inventory.po.send',
  'inventory.po.amend',
  'inventory.po.cancel',
  'inventory.po.short_close',
  'inventory.grn.read',
  'inventory.grn.list',
  'inventory.purchase_return.manage',
  'inventory.purchase_return.read',
  'inventory.purchase_return.list',
  'inventory.invoice.capture',
  'inventory.invoice.match',
  'inventory.invoice.read',
  'inventory.invoice.list',
  'inventory.purchase.emergency.create',
  'inventory.purchase.report.read',
  'inventory.report.read',
  'vendor.master.read',
  'vendor.master.list',
  'vendor.master.manage',
  'vendor.item.read',
  'vendor.item.manage',
  'vendor.contract.read',
  'vendor.contract.list',
  'vendor.contract.manage',
  'vendor.score.read',
  'vendor.report.read',
  // Proposes a sanction; NC-021 §5 puts the approval with the administrator,
  // after a show-cause notice and a response window.
  'vendor.action.propose',
  'inventory.consignment.agreement.manage',
] as const;

/**
 * The consignment coordinator: the vendor's stock on our shelves, and the
 * paperwork that turns a used implant into an invoice.
 *
 * `inventory.consignment.sign` is deliberately not here — NC-007 §12 keeps the
 * reconciliation signature away from whoever scanned the usages being
 * reconciled, and the coordinator is usually both scanner and counter.
 */
/**
 * RC-003 — reading a price.
 *
 * Granted widely and on purpose: `tariff.rate.resolve` is what every bill line,
 * estimate and pre-auth calls, and a biller who cannot resolve a rate cannot
 * bill. Nothing in this bundle changes a price.
 */
const TARIFF_READ = [
  'tariff.rate.resolve',
  'tariff.rate.explain',
  'tariff.plan.list',
  'tariff.plan.read',
  'tariff.item.list',
  'tariff.package.read',
] as const;

/**
 * RC-003 — maintaining the price list.
 *
 * Deliberately excludes `tariff.version.publish` and `tariff.version.withdraw`.
 * RC-003 §5's approval matrix is "requester ≠ approver, always", and a bundle
 * that held both halves would make that sentence decorative: the finance
 * manager who builds a revision submits it, and somebody else publishes it.
 */
const TARIFF_DESK = [
  ...TARIFF_READ,
  'tariff.plan.configure',
  'tariff.version.list',
  'tariff.version.read',
  'tariff.version.create',
  'tariff.version.update',
  'tariff.version.simulate',
  'tariff.version.submit',
  'tariff.item.update',
  'tariff.bulk.revise',
  'tariff.package.update',
  'tariff.payer_sheet.upload',
  'tariff.payer_sheet.map',
  'tariff.scheme.import',
  'tariff.missing.read',
  'tariff.missing.resolve',
  'tariff.report.compare',
  'tariff.audit.read',
  'tariff.export',
] as const;

/**
 * OP-005 — working a bill.
 *
 * Deliberately excludes `bill.discount.approve`, `bill.cancel` and
 * `invoice.credit_note`. A biller assembles, finalises and collects; undoing any
 * of that is somebody else's key, which is what makes the discount register and
 * the credit-note register worth reading.
 */
const BILLING_DESK = [
  'bill.read',
  'bill.list',
  'bill.create',
  'bill.item.post',
  'bill.item.remove',
  'bill.finalize',
  'bill.discount.request',
  'invoice.read',
  'invoice.issue',
  'invoice.reprint',
  'billing.exception.read',
] as const;

/** The other half of the maker-checker pair, plus the reversal keys. */
const BILLING_APPROVER = [
  'bill.read',
  'bill.list',
  'bill.discount.approve',
  'bill.cancel',
  'invoice.read',
  'invoice.credit_note',
  'invoice.cancel',
  'billing.report.read',
  'billing.exception.read',
] as const;

/** EN-010 — taking money. Excludes approving a refund, on purpose. */
const PAYMENT_DESK = [
  'pay.intent.read',
  'pay.intent.list',
  'pay.intent.create',
  'pay.intent.cancel',
  'pay.payment.read',
  'pay.payment.list',
  'pay.refund.request',
] as const;

/** The checker half, plus reconciliation — finance, not the counter. */
const PAYMENT_FINANCE = [
  'pay.intent.read',
  'pay.intent.list',
  'pay.payment.read',
  'pay.payment.list',
  'pay.refund.approve',
  'pay.settlement.read',
  'pay.settlement.reconcile',
  'pay.recon.read',
  'pay.recon.resolve',
  'pay.dispute.read',
  'pay.dispute.respond',
] as const;

/** OP-023 — selling and running a package. Not deciding who pays an overrun. */
const PACKAGE_DESK = [
  'pkg.read',
  'pkg.list',
  'pkg.booking.read',
  'pkg.booking.list',
  'pkg.booking.create',
  'pkg.activate',
  'pkg.activation.read',
  'pkg.variance.request',
] as const;

/**
 * EN-002 / RC-002 — the insurance desk.
 *
 * Assembles and submits; never records the payer's decision. That key belongs
 * to finance, because an invented approval is a credit limit billing honours.
 */
const INSURANCE_DESK = [
  'ins.payer.read',
  'ins.payer.list',
  'ins.empanelment.read',
  'ins.policy.read',
  'ins.policy.manage',
  'ins.policy.verify',
  'ins.case.read',
  'ins.case.list',
  'ins.case.manage',
  'ins.nonpayable.read',
  'preauth.read',
  'preauth.list',
  'preauth.create',
  'preauth.update',
  'preauth.submit',
  'preauth.query.reply',
  'preauth.document.manage',
  'preauth.sla.read',
] as const;

/**
 * RC-007 — the scheme desk.
 *
 * Verifies the card and works the case and the claim. It does not hold
 * `scheme.claim.decision.record` or `scheme.shortfall.writeoff.approve`: the
 * person chasing the money is not the person who confirms it arrived, or who
 * agrees it never will.
 */
/**
 * RC-008 — the estimating desk.
 *
 * Front office and the billing desk both quote. Neither holds
 * `est.template.manage` or `est.variance.read`: the standing line sets are how
 * two desks quote a procedure the same way, and measuring the estimator against
 * its own bills is not the job of the people writing the quotes.
 */
/**
 * RC-006 — the leakage worklist.
 *
 * Finance holds all of it including `leak.finding.accept`, because §5.7's "never
 * auto-post" only means anything if the person accepting is accountable for the
 * charge that follows. The billing desk gets the read side: they are the ones who
 * will raise the charge once it is accepted, and a worklist they cannot see is a
 * worklist they cannot work.
 */
/**
 * NC-034 — the payout run.
 *
 * Finance computes and pays; the hospital admin approves. That split is the
 * `block` rule made real: a payout statement is an outbound payment authorised
 * on a calculation nobody else has checked, so the person who ran it does not
 * also release it.
 */
const PAYOUT_FINANCE = [
  'payout.contract.read',
  'payout.period.read',
  'payout.period.manage',
  'payout.statement.read',
  'payout.statement.list',
  'payout.statement.compute',
  'payout.statement.pay',
  'payout.dispute.resolve',
  'payout.tds.read',
] as const;

const LEAKAGE_FINANCE = [
  'leak.rule.read',
  'leak.rule.manage',
  'leak.scan.run',
  'leak.scan.read',
  'leak.finding.read',
  'leak.finding.list',
  'leak.finding.accept',
  'leak.finding.dismiss',
  'leak.recovery.record',
  'leak.discharge.check',
  'leak.discharge.override',
  'leak.report.read',
] as const;

const LEAKAGE_DESK = [
  'leak.scan.read',
  'leak.finding.read',
  'leak.finding.list',
  'leak.discharge.check',
] as const;

const ESTIMATE_DESK = [
  'est.read',
  'est.list',
  'est.create',
  'est.update',
  'est.issue',
  'est.share',
  'est.outcome.record',
  'est.template.read',
] as const;

const SCHEME_DESK = [
  'scheme.read',
  'scheme.list',
  'scheme.package.read',
  'scheme.beneficiary.read',
  'scheme.beneficiary.capture',
  'scheme.beneficiary.verify',
  'scheme.case.read',
  'scheme.case.list',
  'scheme.case.open',
  'scheme.case.manage',
  'scheme.cash.attempt.read',
  'scheme.claim.read',
  'scheme.claim.list',
  'scheme.claim.assemble',
  'scheme.claim.submit',
  'scheme.shortfall.read',
  'scheme.shortfall.appeal',
] as const;

/**
 * RC-007 — the finance half. Records what the authority decided and paid,
 * closes the case, and approves a write-off.
 */
const SCHEME_FINANCE = [
  'scheme.read',
  'scheme.list',
  'scheme.configure',
  'scheme.package.read',
  'scheme.package.manage',
  'scheme.package.publish',
  'scheme.beneficiary.read',
  'scheme.case.read',
  'scheme.case.list',
  'scheme.case.close',
  'scheme.cash.attempt.read',
  'scheme.claim.read',
  'scheme.claim.list',
  'scheme.claim.decision.record',
  'scheme.shortfall.read',
  'scheme.shortfall.writeoff.approve',
  'scheme.recon.manage',
] as const;

const CONSIGNMENT_DESK = [
  'inventory.consignment.agreement.read',
  'inventory.consignment.agreement.list',
  'inventory.consignment.kit.manage',
  'inventory.consignment.receive',
  'inventory.consignment.stock.read',
  'inventory.consignment.use',
  'inventory.consignment.usage.read',
  'inventory.consignment.usage.list',
  'inventory.consignment.po.read',
  'inventory.consignment.po.list',
  'inventory.consignment.return.manage',
  'inventory.consignment.count',
  'inventory.consignment.report.read',
] as const;

/**
 * Reading what came back from the counter, for a clinician. `pharmacy.*` reads
 * only — nothing here dispenses, prices or adjusts.
 */
const PHARMACY_READER = [
  'pharmacy.dispense.read',
  'pharmacy.dispense.list',
  'pharmacy.substitution.read',
  'pharmacy.substitution.list',
] as const;

/**
 * The dispensing counter.
 *
 * Holds all four `pharmacy.narcotic.*` co-signed keys, because a pharmacist has
 * to be a valid signature on either side of a two-person controlled-drug
 * transaction — and holds `pharmacy.narcotic.prepare`, which is the key the
 * route is actually decorated with. Deliberately excludes
 * `pharmacy.return.approve`, `pharmacy.expiry.manage`, `pharmacy.price.update`
 * and `pharmacy.recall.manage`: OP-003 §12 keeps all four with the in-charge.
 */
const PHARMACY_COUNTER = [
  ...STOCK_LOOKUP,
  ...PHARMACY_READER,
  'pharmacy.queue.read',
  'pharmacy.queue.list',
  'pharmacy.queue.manage',
  'pharmacy.dispense.create',
  'pharmacy.dispense.complete',
  'pharmacy.dispense.bill',
  'pharmacy.dispense.cancel',
  'pharmacy.substitution.request',
  'pharmacy.batch.override',
  'pharmacy.label.print',
  'pharmacy.label.reprint',
  'pharmacy.otc.sell',
  'pharmacy.return.create',
  'pharmacy.return.read',
  'pharmacy.return.list',
  'pharmacy.stock.read',
  'pharmacy.stock.list',
  'pharmacy.indent.create',
  'pharmacy.expiry.read',
  'pharmacy.recall.read',
  'pharmacy.recall.list',
  'pharmacy.narcotic.read',
  'pharmacy.narcotic.list',
  'pharmacy.narcotic.prepare',
  'pharmacy.narcotic.dispense',
  'pharmacy.narcotic.issue',
  'pharmacy.narcotic.custody',
  'pharmacy.narcotic.destroy',
  'pharmacy.coldchain.record',
  'pharmacy.intervention.record',
  'pharmacy.intervention.read',
  'pharmacy.intervention.list',
  'pharmacy.day_close.read',
  'pharmacy.day_close.list',
  'pharmacy.day_close.complete',
  'inventory.store_indent.create',
  'inventory.store_indent.read',
  'inventory.store_indent.list',
  'inventory.issue.receive',
  'inventory.count.count',
  'inventory.count.read',
  'inventory.count.list',
  'inventory.batch.trace',
] as const;

/**
 * Pharmacy administration on top of the counter: pricing, expiry decisions,
 * recalls, the statutory registers and the drug side of purchasing.
 *
 * `pharmacy.discount.apply` is here and not on the counter because OP-003 §3
 * caps a pharmacist's discount and sends the rest to the in-charge.
 */
const PHARMACY_ADMIN = [
  'pharmacy.return.approve',
  'pharmacy.stock.adjust',
  'pharmacy.indent.approve',
  'pharmacy.expiry.manage',
  'pharmacy.recall.manage',
  'pharmacy.recall.trace',
  'pharmacy.coldchain.decide',
  'pharmacy.price.update',
  'pharmacy.discount.apply',
  'pharmacy.report.read',
  'pharmacy.report.export',
  'pharmacy.configure',
  'inventory.item.create',
  'inventory.item.update',
  'inventory.item.params.configure',
  'inventory.item.gtin.map',
  'inventory.ledger.read',
  'inventory.ledger.list',
  'inventory.adjustment.create',
  'inventory.adjustment.read',
  'inventory.adjustment.list',
  'inventory.batch.quarantine',
  'inventory.batch.release',
  'inventory.expiry.read',
  'inventory.expiry.manage',
  'inventory.coldchain.read',
  'inventory.reorder.read',
  'inventory.reorder.manage',
  'inventory.count.plan',
  'inventory.analysis.read',
  'inventory.report.read',
  'inventory.indent.create',
  'inventory.indent.read',
  'inventory.indent.list',
  'inventory.grn.read',
  'inventory.grn.list',
  'inventory.po.read',
  'inventory.po.list',
  'vendor.master.read',
  'vendor.master.list',
  'vendor.item.read',
] as const;

/** Read-only reach across the whole supply chain, for an auditor or a drug inspector. */
const SUPPLY_CHAIN_AUDIT = [
  'inventory.item.read',
  'inventory.item.list',
  'inventory.store.read',
  'inventory.store.list',
  'inventory.stock.read',
  'inventory.stock.list',
  'inventory.batch.read',
  'inventory.batch.list',
  'inventory.ledger.read',
  'inventory.ledger.list',
  'inventory.adjustment.read',
  'inventory.adjustment.list',
  'inventory.count.read',
  'inventory.count.list',
  'inventory.valuation.read',
  'inventory.analysis.read',
  'inventory.report.read',
  'inventory.export',
  'inventory.indent.read',
  'inventory.indent.list',
  'inventory.rfq.read',
  'inventory.rfq.list',
  'inventory.quotation.read',
  'inventory.quotation.list',
  'inventory.rate_contract.read',
  'inventory.rate_contract.list',
  'inventory.po.read',
  'inventory.po.list',
  'inventory.grn.read',
  'inventory.grn.list',
  'inventory.purchase_return.read',
  'inventory.purchase_return.list',
  'inventory.invoice.read',
  'inventory.invoice.list',
  'inventory.purchase.report.read',
  'inventory.purchase.export',
  'inventory.consignment.agreement.read',
  'inventory.consignment.agreement.list',
  'inventory.consignment.stock.read',
  'inventory.consignment.po.read',
  'inventory.consignment.po.list',
  'inventory.consignment.report.read',
  'inventory.consumption.report.read',
  'inventory.consumption.variance.read',
  'finance.costcentre.read',
  'finance.costcentre.list',
  'vendor.master.read',
  'vendor.master.list',
  'vendor.item.read',
  'vendor.contract.read',
  'vendor.contract.list',
  'vendor.score.read',
  'vendor.report.read',
  'vendor.export',
  'pharmacy.report.read',
  'pharmacy.report.export',
  'pharmacy.day_close.read',
  'pharmacy.day_close.list',
  'pharmacy.narcotic.read',
  'pharmacy.narcotic.list',
] as const;

// ── the 64 templates ─────────────────────────────────────────────────────────

const templates: readonly RoleTemplate[] = [
  {
    key: 'super_admin',
    docsRow: 1,
    name: 'Super Admin (SaaS operator)',
    description:
      'The SaaS operator. Manages tenants, plans, licence keys and global masters. Impersonation is time-boxed, read-only by default and audited under both identities.',
    category: 'saas',
    homeWorkspace: 'tenant-console',
    permissions: [
      ...BASE_STAFF,
      'admin.hospital.configure',
      'admin.settings.read',
      'admin.settings.configure',
      'admin.impersonate',
      'admin.status.read',
      'admin.report.read',
      'admin.flags.configure',
      'lic.plan.manage',
      'lic.subscription.manage',
      'lic.subscription.read',
      'lic.override.manage',
      'lic.billing.manage',
      'lic.key.issue',
      'lic.usage.admin',
      'lic.report.admin',
      'dr.status.fleet',
      'security.posture.fleet',
      'ihub.package.manage',
      'tpl.bundle.manage',
      'gateway.product.manage',
    ],
    abacDefaults: { deviceBound: true },
    mfaMandatory: true,
    sensitiveGrant: true,
    requiresCoSign: false,
  },
  {
    key: 'hospital_admin',
    docsRow: 2,
    name: 'Hospital Admin / Group Admin',
    description:
      'Owns the tenant control plane: users, roles, settings, masters, branches, feature flags and the audit viewer.',
    category: 'admin',
    homeWorkspace: 'admin-console',
    permissions: [
      ...CONSOLE_ADMIN,
      'ot.board.read',
      'ot.case.schedule',
      'cssd.recall.run',
      ...IP_BILL_DESK,
      'ipbill.policy.manage',
      'ipbill.clearance.override',
      ...BED_COMMAND,
      ...FLEET_MANAGER,
      'mlc.configure',
      ...MCI_COMMAND,
      // Phase 5 — RC-003. Holds the *publish* half only. The finance manager
      // builds and submits a revision; making it live is a second pair of
      // hands, which is what RC-003 §5's "requester ≠ approver" means in
      // practice rather than on paper.
      ...TARIFF_READ,
      'tariff.version.list',
      'tariff.version.read',
      'tariff.version.publish',
      'tariff.version.withdraw',
      'tariff.ratecard.publish',
      'tariff.payer_sheet.publish',
      'tariff.audit.read',
      'tariff.missing.read',

      // Phase 5 — NC-034. The checker half of the payout pair, and the same
      // reasoning: finance computes what each doctor earned, and somebody else
      // decides the money may leave. Also the payout contracts themselves,
      // because what a doctor is engaged on is a hospital-level agreement.
      'payout.contract.read',
      'payout.contract.manage',
      'payout.period.read',
      'payout.statement.read',
      'payout.statement.list',
      'payout.statement.approve',
      'payout.dispute.resolve',

      'labq.assessor.grant',
      'rad.pacs.retention',
      'rad.configure',
      'rad.telerad.manage',
      'invest.configure',

      'schedule.publish',
      'queue.config.manage',
      'queue.overview.read',
      'queue.analytics.read',
      'messaging.template.approve',
      'messaging.campaign.approve',
      'consent.type.configure',
      'receipt.counter.configure',
      'receipt.daybook.read',
      'mrd.configure',
      'mrd.report.read',
      'vitals.configure',
      'cdss.governance.read',
      'cdss.report.read',

      ...BASE_STAFF,
      ...APPROVER,
      'admin.hospital.configure',
      'admin.settings.read',
      'admin.settings.configure',
      'admin.calendar.configure',
      'admin.numbering.configure',
      'admin.user.read',
      'admin.user.create',
      'admin.user.update',
      'admin.user.deactivate',
      'admin.user.reset',
      'admin.role.read',
      'admin.role.configure',
      'admin.role.assign',
      'admin.access.approve',
      'admin.access.review',
      'admin.security.configure',
      'admin.session.manage',
      'admin.device.manage',
      'admin.audit.read',
      'admin.flags.configure',
      'admin.licence.read',
      'admin.status.read',
      'admin.report.read',
      'audit.read',
      'audit.user.read',
      'audit.report.read',
      'audit.retention.configure',
      'org.branch.manage',
      'org.branch.onboard',
      'org.registration.manage',
      'org.policy.manage',
      'org.access.manage',
      'org.report.read',
      'org.transfer.manage',
      'wf.matrix.manage',
      'wf.matrix.publish',
      'wf.process.manage',
      'wf.calendar.manage',
      'wf.delegation.admin',
      'wf.bypass',
      'notify.policy.manage',
      'notify.type.manage',
      'notify.admin.read',
      'notify.report.read',
      'mdm.org.propose',
      'mdm.org.approve',
      'mdm.quality.read',
      'mdm.review.manage',
      'mdm.report.read',
      'mdm.sync.manage',
      'tpl.print.publish',
      'tpl.form.publish',
      'tpl.branding.manage',
      'tpl.bundle.manage',
      'lic.subscription.read',
      'lic.subscription.request',
      'lic.usage.read',
      'lic.invoice.read',
      'dr.policy.configure',
      'dr.status.read',
      'dr.restore.approve',
      'dr.downtime.manage',
      'dr.drill.read',
      'sso.breakglass.manage',
      'sso.stepup.configure',
      'sso.report.read',
      'security.posture.read',
      'security.report.read',
      'gateway.client.manage',
      'admin.print.configure',
      'admin.print.read',

      // Phase 4 — the configuration and the top approval tier. Deliberately no
      // `vendor.master.manage`, no `inventory.po.create` and no
      // `vendor.action.propose`: the administrator approves what somebody else
      // raised, and every one of those pairs is a blocking segregation rule.
      'inventory.store.configure',
      'inventory.item.read',
      'inventory.item.list',
      'inventory.item.import',
      'inventory.purchase.configure',
      'inventory.purchase.emergency.approve',
      'inventory.purchase.report.read',
      'inventory.po.read',
      'inventory.po.list',
      'inventory.po.approve',
      'inventory.comparative.approve',
      'inventory.rate_contract.read',
      'inventory.rate_contract.list',
      'inventory.rate_contract.approve',
      'inventory.transfer.read',
      'inventory.transfer.list',
      'inventory.transfer.approve',
      'inventory.adjustment.read',
      'inventory.adjustment.list',
      'inventory.adjustment.approve',
      'inventory.count.read',
      'inventory.count.list',
      'inventory.count.approve',
      'inventory.valuation.read',
      'inventory.report.read',
      'inventory.export',
      'inventory.negative_stock.override',
      'inventory.consignment.agreement.read',
      'inventory.consignment.agreement.list',
      'inventory.consignment.agreement.approve',
      'inventory.consignment.approve',
      'inventory.consignment.configure',
      'inventory.consignment.report.read',
      'inventory.consumption.configure',
      'inventory.consumption.report.read',
      'finance.costcentre.read',
      'finance.costcentre.list',
      'finance.costcentre.manage',
      'vendor.master.read',
      'vendor.master.list',
      'vendor.master.approve',
      'vendor.contract.read',
      'vendor.contract.list',
      'vendor.contract.approve',
      'vendor.action.approve',
      'vendor.score.manage',
      'vendor.score.read',
      'vendor.report.read',
      'vendor.configure',
      'pharmacy.configure',
      'pharmacy.report.read',
      'pharmacy.day_close.read',
      'pharmacy.day_close.list',
    ],
    // No narrowing: a Hospital Admin's reach is set by their branch grants in
    // `org_user_branch_access`, not by an ABAC default (EN-041 §3.7).
    abacDefaults: {},
    mfaMandatory: true,
    sensitiveGrant: true,
    requiresCoSign: false,
  },
  {
    key: 'branch_admin',
    docsRow: 3,
    name: 'Branch Admin',
    description: 'Runs one branch: its configuration, counters, wards and staff. Cannot see another branch.',
    category: 'admin',
    homeWorkspace: 'branch-admin',
    permissions: [
      'procedure.room.configure',
      ...CONSOLE_ADMIN,
      ...IP_BILL_DESK,
      'ipbill.policy.manage',
      'ipbill.clearance.override',
      ...BED_COMMAND,
      'schedule.publish',
      'schedule.configure',
      'frontoffice.counter.configure',
      'frontoffice.dashboard.read',
      'queue.config.manage',
      'queue.counter.manage',
      'queue.overview.read',
      'queue.analytics.read',
      'receipt.counter.configure',
      'vitals.configure',
      'vitals.report.read',

      ...BASE_STAFF,
      ...APPROVER,
      'admin.settings.read',
      'admin.settings.configure',
      'admin.calendar.configure',
      'admin.user.read',
      'admin.user.create',
      'admin.user.update',
      'admin.role.read',
      'admin.role.assign',
      'admin.access.approve',
      'admin.device.manage',
      'admin.status.read',
      'admin.report.read',
      'org.registration.manage',
      'org.master.override',
      'org.transfer.manage',
      'mdm.org.propose',
      'tpl.branding.manage',
      'lic.usage.read',
      'admin.print.configure',
      'admin.print.read',
      'barcode.scheme.configure',

      // Phase 4 — the same surface as the hospital administrator, narrowed to
      // one branch by ABAC rather than by the key.
      'inventory.store.configure',
      'inventory.item.read',
      'inventory.item.list',
      'inventory.po.read',
      'inventory.po.list',
      'inventory.po.approve',
      'inventory.transfer.read',
      'inventory.transfer.list',
      'inventory.transfer.approve',
      'inventory.adjustment.read',
      'inventory.adjustment.list',
      'inventory.adjustment.approve',
      'inventory.count.read',
      'inventory.count.list',
      'inventory.count.approve',
      'inventory.valuation.read',
      'inventory.report.read',
      'inventory.consumption.report.read',
      'finance.costcentre.read',
      'finance.costcentre.list',
      'vendor.master.read',
      'vendor.master.list',
      'vendor.report.read',
      'pharmacy.report.read',
      'pharmacy.day_close.read',
      'pharmacy.day_close.list',
    ],
    abacDefaults: {},
    mfaMandatory: true,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'medical_superintendent',
    docsRow: 4,
    name: 'Medical Superintendent / Medical Director',
    description:
      'Clinical governance: all clinical read, quality, MLC, mortality review, break-glass review and the final rung of every clinical escalation ladder.',
    category: 'governance',
    homeWorkspace: 'clinical-governance',
    permissions: [
      'ophtha.visit.read',
      'ophtha.report.read',
      ...CONSOLE_CLINICIAN,
      ...CONSOLE_ADMIN,
      ...DISCHARGE_CONSULTANT,
      ...MORTUARY_CLINICAL,
      'mortuary.release.manage',
      'mortuary.report.read',
      'mortuary.body.operate',
      'mortuary.pm.write',
      'icu.flowsheet.read',
      'code.close',
      'blood.inventory.read',
      'ot.board.read',
      'ot.case.bump',
      'cssd.recall.run',
      ...IP_BILL_READER,
      'ipbill.clearance.override',
      'nursing.ward.read',
      'escalation.read',
      'escalation.resolve',
      'infection.hai.read',
      ...BED_COMMAND,
      'transfer.out',
      ...POLYTRAUMA_FLOOR,
      'polytrauma.consult.escalate',
      'polytrauma.case.close',
      'fleet.trip.read',
      'fleet.report.read',
      ...MLC_OVERSIGHT,
      'mlc.case.read',
      'mlc.report.read',
      'mlc.evidence.read',
      ...MCI_COMMAND,
      ...DIAGNOSTIC_RESULTS_READER,
      'rad.peer_review.read',
      'rad.mlc.read',
      'labq.report.read',

      'consent.override.review',
      'consent.template.approve',
      'patient.record.export',

      // Clinical governance over Phase 2. The Medical Superintendent publishes
      // rules but never authors them, approves destruction runs but never
      // proposes them, and QAs coding but never codes — every one of those pairs
      // is a blocking SoD rule in the catalogue.
      'opd.encounter.read',
      'opd.inbox.read',
      'opd.audit.read',
      'opd.department.view',
      'order.list',
      'terminology.read',
      'vitals.record.read',
      'vitals.report.read',
      'cdss.alert.read',
      'cdss.alert.replay',
      'cdss.snapshot.read',
      'cdss.score.read',
      'cdss.rule.read',
      'cdss.rule.publish',
      'cdss.governance.read',
      'cdss.governance.manage',
      'cdss.report.read',
      'cdss.emergency.declare',
      'mrd.record.list',
      'mrd.record.read',
      'mrd.record.reopen',
      'mrd.search',
      'mrd.deficiency.read',
      'mrd.deficiency.waive',
      'mrd.coding.qa',
      'mrd.legal_hold.set',
      'mrd.legal_hold.release',
      'mrd.destruction.approve',
      'mrd.report.read',

      ...BASE_CLINICAL,
      ...BREAK_GLASS,
      ...APPROVER,
      'audit.read',
      'audit.patient.read',
      'audit.breakglass.review',
      'audit.report.read',
      'admin.role.read',
      'admin.report.read',
      'notify.escalation.read',
      'notify.admin.manage',
      'notify.policy.manage',
      'notify.type.manage',
      'notify.report.read',
      'wf.bypass',
      'wf.audit.read',
      'tpl.form.publish',
      'mdm.clinical.approve',
      'mdm.pharmacy.approve',
      'mdm.emergency_change',
      'org.report.read',
      'security.incident.read',
      'dr.status.read',

      // Phase 4 — medication-safety governance. Sees the interventions, the
      // recalls and the controlled-drug registers; dispenses nothing.
      'pharmacy.recall.read',
      'pharmacy.recall.list',
      'pharmacy.recall.manage',
      'pharmacy.intervention.read',
      'pharmacy.intervention.list',
      'pharmacy.narcotic.read',
      'pharmacy.narcotic.list',
      'pharmacy.report.read',
      'inventory.batch.read',
      'inventory.batch.list',
      'inventory.batch.trace',
    ],
    abacDefaults: {},
    mfaMandatory: true,
    sensitiveGrant: true,
    requiresCoSign: false,
  },
  {
    key: 'hod',
    docsRow: 5,
    name: 'HOD (Head of Department)',
    description: 'Department scheduling, approvals and KPIs, scoped to their own department.',
    category: 'medical',
    homeWorkspace: 'department-dashboard',
    permissions: [
      ...PROCEDURE_OPERATOR,
      ...OPHTHA_DOCTOR,
      ...SPECIALTY_CONSOLE_DOCTOR,
      ...CONSOLE_CLINICIAN,
      ...DISCHARGE_CONSULTANT,
      ...MORTUARY_CLINICAL,
      ...DIAGNOSTIC_ORDERING,

      'appointment.overbook',
      'schedule.publish',
      'consent.override.review',
      ...DOCTOR_CLINICAL,
      ...PAYOUT_EARNER,
      'rx.schedule_x.prescribe',
      'opd.department.view',
      'opd.template.publish',
      'opd.audit.read',
      'vitals.queue.read',
      'vitals.report.read',
      'cdss.rule.read',
      'cdss.governance.read',
      'cdss.report.read',
      'mrd.report.read',
      ...BASE_CLINICAL,
      ...BREAK_GLASS,
      ...SIGNS_DOCUMENTS,
      ...HOD_BASE,
      'tpl.form.manage',
      // Phase 4 — the department head's supply-chain surface: approve what the
      // department asks for, and answer for what it consumed. No ordering, no
      // receipt, no adjustment.
      'inventory.store_indent.read',
      'inventory.store_indent.list',
      'inventory.store_indent.approve',
      'inventory.indent.create',
      'inventory.indent.read',
      'inventory.indent.list',
      'inventory.indent.approve',
      'inventory.item.read',
      'inventory.item.list',
      'inventory.stock.read',
      'inventory.stock.list',
      'inventory.consumption.read',
      'inventory.consumption.list',
      'inventory.consumption.report.read',
      'inventory.consumption.variance.read',
      'inventory.consumption.variance.explain',
      'inventory.report.read',
      'finance.costcentre.read',
      'finance.costcentre.list',
    ],
    abacDefaults: { ownDepartmentOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'doctor_consultant_opd',
    docsRow: 6,
    name: 'Doctor — Consultant (OPD)',
    description: 'Outpatient consultation, e-prescribing, orders, results, referrals and own earnings.',
    category: 'medical',
    homeWorkspace: 'doctor-opd',
    permissions: [
      ...PROCEDURE_OPERATOR,
      ...OPHTHA_DOCTOR,
      ...SPECIALTY_CONSOLE_DOCTOR,
      ...CONSOLE_CLINICIAN,
      ...MAR_PRESCRIBER,
      ...WARD_FLOOR,
      'transfer.execute',
      ...POLYTRAUMA_FLOOR,
      'polytrauma.consult.escalate',
      ...IMPLANT_LOOKUP,
      ...PLASTER_ROOM,
      'cast.remove',
      ...FRACTURE_SURGEON,
      'mlc.case.read',
      ...DIAGNOSTIC_ORDERING,
      ...INVESTIGATION_REPORTER,

      ...PATIENT_READ,
      'schedule.configure',
      ...QUEUE_CALLER,
      'queue.doctor.status',
      'visit.list',
      'visit.update',
      'consent.request',
      'consent.read',
      ...DOCTOR_CLINICAL,
      ...PAYOUT_EARNER,
      'rx.schedule_x.prescribe',
      ...BASE_CLINICAL,
      ...BREAK_GLASS,
      ...SIGNS_DOCUMENTS,
      'notify.escalation.read',
    ],
    abacDefaults: { ownPatientsOnly: false, careTeamOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'doctor_ip',
    docsRow: 7,
    name: 'Doctor — Inpatient / Ward',
    description: 'Ward rounds, inpatient orders, notes, discharge and transfers.',
    category: 'medical',
    homeWorkspace: 'ip-rounds',
    permissions: [
      ...ONCO_DOCTOR,
      ...LABOUR_DOCTOR,
      ...PROCEDURE_OPERATOR,
      ...CONSOLE_CLINICIAN,
      ...DISCHARGE_CONSULTANT,
      ...MORTUARY_CLINICAL,
      'icu.flowsheet.read',
      'icu.bundle.record',
      'code.call',
      'code.record',
      'code.close',
      'blood.request.create',
      'blood.inventory.read',
      'blood.reaction.report',
      'ipbill.clearance.read',
      ...MAR_PRESCRIBER,
      'nursing.assessment.record',
      'nursing.note.write',
      'infection.isolation.manage',
      'infection.device.record',
      ...WARD_FLOOR,
      'admission.admit',
      'transfer.execute',
      'transfer.out',
      'transfer.leave',
      ...POLYTRAUMA_FLOOR,
      'polytrauma.consent.record',
      ...IMPLANT_LOOKUP,
      ...CAST_WATCH,
      ...FRACTURE_FLOOR,
      'fleet.request.create',
      'fleet.request.read',
      'mlc.case.read',
      'mlc.injury.write',
      ...DIAGNOSTIC_ORDERING,

      ...DOCTOR_CLINICAL,
      ...PAYOUT_EARNER,
      'rx.schedule_x.prescribe',
      ...BASE_CLINICAL,
      ...BREAK_GLASS,
      ...SIGNS_DOCUMENTS,
      'notify.escalation.read',
    ],
    abacDefaults: { careTeamOnly: true, assignedWardOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'doctor_emergency',
    docsRow: 8,
    name: 'Doctor — Emergency Physician',
    description: 'Emergency department: triage view, ER orders, MLC registration and admission decisions.',
    category: 'medical',
    homeWorkspace: 'er-board',
    permissions: [
      ...PROCEDURE_OPERATOR,
      ...CONSOLE_CLINICIAN,
      ...DISCHARGE_CONSULTANT,
      ...MORTUARY_CLINICAL,
      ...ICU_BEDSIDE,
      'icu.score.compute',
      'code.close',
      'blood.request.create',
      'blood.inventory.read',
      ...OT_FLOOR,
      'ot.case.bump',
      ...MAR_PRESCRIBER,
      ...WARD_FLOOR,
      'bed.hold.create',
      'admission.admit',
      'transfer.execute',
      ...POLYTRAUMA_SURGICAL,
      ...POLYTRAUMA_WAIVER,
      ...IMPLANT_LOOKUP,
      ...PLASTER_ROOM,
      ...FRACTURE_FLOOR,
      ...PREHOSPITAL_RECEIVER,
      'prehospital.prealert.divert',
      ...MLC_OFFICER,
      // Both halves, not just the write. A clinician who may record the MoHFW
      // protocol but not read it back is a clinician examining a survivor
      // blind, and would be re-taking a history the survivor has already
      // given once. The restriction that matters is that this is a separate,
      // reason-required, two-approver key that the rest of the floor does not
      // hold — not that the examiner cannot see their own examination.
      'mlc.sensitive.write',
      'mlc.sensitive.read',
      ...ER_FLOOR,
      ...TRIAGE_FLOOR,
      ...TRAUMA_LEAD,
      ...MCI_COMMAND,
      'er.disposition.decide',
      'er.identity.merge',
      ...DIAGNOSTIC_ORDERING,
      'rad.mlc.read',

      'consent.emergency_override',
      'patient.record.create_override',

      ...DOCTOR_CLINICAL,
      ...PAYOUT_EARNER,
      'rx.schedule_x.prescribe',
      'cdss.emergency.declare',
      'vitals.escalate.er',
      'vitals.queue.read',

      ...BASE_CLINICAL,
      ...BREAK_GLASS,
      ...SIGNS_DOCUMENTS,
      'notify.escalation.read',
      'barcode.wristband.issue',
      ...LABEL_PRINTER,
    ],
    // Emergency physicians deliberately have no care-team restriction: an ER
    // patient has no care team yet (docs/04 §7, EN-041 §3.4.2 break-glass).
    abacDefaults: {},
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'surgeon',
    docsRow: 9,
    name: 'Surgeon',
    description: 'OT booking, operation notes, implant capture and surgical consent.',
    category: 'medical',
    homeWorkspace: 'ot-schedule',
    permissions: [
      ...PROCEDURE_OPERATOR,
      ...OPHTHA_DOCTOR,
      ...SPECIALTY_CONSOLE_DOCTOR,
      ...CONSOLE_CLINICIAN,
      ...DISCHARGE_CONSULTANT,
      ...MORTUARY_CLINICAL,
      'icu.flowsheet.read',
      'code.call',
      'blood.request.create',
      'blood.inventory.read',
      ...OT_SURGEON,
      'cssd.issue',
      ...MAR_PRESCRIBER,
      'infection.hai.read',
      ...WARD_FLOOR,
      'admission.admit',
      'transfer.execute',
      ...POLYTRAUMA_SURGICAL,
      ...POLYTRAUMA_WAIVER,
      ...IMPLANT_SURGEON,
      ...PLASTER_ROOM,
      'cast.remove',
      ...FRACTURE_SURGEON,
      'mlc.case.read',
      'mlc.injury.write',
      ...TRAUMA_TEAM,
      ...DIAGNOSTIC_ORDERING,

      ...DOCTOR_CLINICAL,
      ...PAYOUT_EARNER,
      'rx.schedule_x.prescribe',
      ...BASE_CLINICAL,
      ...BREAK_GLASS,
      ...SIGNS_DOCUMENTS,
      'barcode.verify.implant',

      // Phase 4 — implants. The surgeon records what went into the patient and
      // reads the traceability afterwards; the coordinator does the paperwork.
      'inventory.consignment.stock.read',
      'inventory.consignment.use',
      'inventory.consignment.usage.read',
      'inventory.consignment.usage.list',
      'inventory.item.read',
      'inventory.item.list',
    ],
    abacDefaults: { careTeamOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'anaesthetist',
    docsRow: 10,
    name: 'Anaesthetist',
    description: 'Pre-anaesthetic checkup, intra-operative record and PACU.',
    category: 'medical',
    homeWorkspace: 'anaesthesia-worklist',
    permissions: [
      ...PROCEDURE_OPERATOR,
      ...CONSOLE_CLINICIAN,
      ...ICU_BEDSIDE,
      'icu.score.compute',
      'code.close',
      'blood.request.create',
      'blood.inventory.read',
      ...OT_FLOOR,
      'ot.case.close',
      'ot.note.write',
      'mar.read',
      'mar.order.write',
      'nursing.ward.read',
      'escalation.read',
      ...POLYTRAUMA_FLOOR,
      'polytrauma.procedure.state',
      'polytrauma.blood.plan',
      'polytrauma.consent.record',
      ...IMPLANT_LOOKUP,
      ...TRAUMA_TEAM,
      ...DIAGNOSTIC_ORDERING,

      ...DOCTOR_CLINICAL,
      ...PAYOUT_EARNER,
      'rx.schedule_x.prescribe',
      ...BASE_CLINICAL,
      ...BREAK_GLASS,
      ...SIGNS_DOCUMENTS,
    ],
    abacDefaults: { careTeamOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'intensivist',
    docsRow: 11,
    name: 'Intensivist',
    description: 'ICU flowsheet, ventilator management and severity scores.',
    category: 'medical',
    homeWorkspace: 'icu-board',
    permissions: [
      ...CONSOLE_CLINICIAN,
      ...DISCHARGE_CONSULTANT,
      ...MORTUARY_CLINICAL,
      ...ICU_BEDSIDE,
      'icu.score.compute',
      'code.close',
      'blood.request.create',
      'blood.inventory.read',
      'blood.reaction.report',
      'ot.board.read',
      'ot.intraop.record',
      ...MAR_PRESCRIBER,
      'infection.isolation.manage',
      'infection.device.record',
      'infection.hai.read',
      ...WARD_FLOOR,
      'admission.admit',
      'transfer.execute',
      'transfer.out',
      'bed.hold.create',
      ...POLYTRAUMA_SURGICAL,
      ...POLYTRAUMA_WAIVER,
      ...IMPLANT_LOOKUP,
      ...CAST_WATCH,
      'mlc.case.read',
      'mlc.injury.write',
      ...TRAUMA_TEAM,
      ...DIAGNOSTIC_ORDERING,

      ...DOCTOR_CLINICAL,
      ...PAYOUT_EARNER,
      'rx.schedule_x.prescribe',
      ...BASE_CLINICAL,
      ...BREAK_GLASS,
      ...SIGNS_DOCUMENTS,
      'notify.escalation.read',
    ],
    abacDefaults: { assignedWardOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'radiologist',
    docsRow: 12,
    name: 'Radiologist',
    description: 'Reading worklist, PACS viewer, structured reporting and sign-off.',
    category: 'diagnostics',
    homeWorkspace: 'radiology-reading',
    permissions: [
      'pcpndt.form_f.write',
      'pcpndt.form_f.sign',
      ...CONSOLE_CLINICIAN,
      'polytrauma.case.read',
      'polytrauma.case.list',
      'polytrauma.consult.respond',
      ...IMPLANT_LOOKUP,
      'fracture.record.read',
      'fracture.record.list',
      'fracture.imaging.assess',
      ...DIAGNOSTIC_RESULTS_READER,
      ...RADIOLOGY_READING,
      ...INVESTIGATION_REPORTER,

      ...DIAGNOSTIC_CLINICIAN,
      ...BASE_CLINICAL,
      ...BREAK_GLASS,
      ...SIGNS_DOCUMENTS,
      'mdm.radiology.propose',
    ],
    abacDefaults: {},
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'pathologist',
    docsRow: 13,
    name: 'Pathologist / Lab Director',
    description: 'Result validation, quality control, sign-off and external quality assessment.',
    category: 'diagnostics',
    homeWorkspace: 'lab-validation',
    permissions: [
      ...CONSOLE_CLINICIAN,
      'mortuary.case.read',
      'mortuary.pm.write',
      'mortuary.report.read',
      ...LAB_VALIDATION,

      ...DIAGNOSTIC_CLINICIAN,
      ...BASE_CLINICAL,
      ...BREAK_GLASS,
      ...SIGNS_DOCUMENTS,
      'mdm.lab.propose',
      'mdm.lab.approve',
    ],
    abacDefaults: {},
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'resident_doctor',
    docsRow: 14,
    name: 'Resident / Junior Doctor / Intern',
    description:
      'Same clinical surface as a doctor but output requires consultant co-signature, and safety overrides are unavailable.',
    category: 'medical',
    homeWorkspace: 'doctor-opd',
    // Deliberately NOT granted break-glass or any `*.override` key: docs/06 §5.2 #16
    // says the allergy hard-stop "disables for roles without `override` (residents)".
    permissions: [
      ...PROCEDURE_FLOOR,
      'procedure.order.create',
      'procedure.perform',
      ...OPHTHA_RESIDENT,
      ...SPECIALTY_CONSOLE_RESIDENT,
      ...CONSOLE_CLINICIAN,
      ...DISCHARGE_CLINICAL,
      'mortuary.case.read',
      'mortuary.case.create',
      ...ICU_BEDSIDE,
      'blood.request.create',
      'blood.inventory.read',
      ...OT_FLOOR,
      ...MAR_PRESCRIBER,
      ...WARD_FLOOR,
      ...POLYTRAUMA_FLOOR,
      'polytrauma.consent.record',
      'polytrauma.procedure.plan',
      ...IMPLANT_LOOKUP,
      ...PLASTER_ROOM,
      ...FRACTURE_FLOOR,
      ...TRAUMA_TEAM,
      ...DIAGNOSTIC_RESULTS_READER,
      'lab.order.create',
      'rad.order.create',
      'rad.report.create',
      'rad.report.preliminary',
      'invest.worklist.read',
      'invest.report.create',
      'invest.report.update',
      ...RESIDENT_CLINICAL,
      ...BASE_CLINICAL,
    ],
    abacDefaults: { careTeamOnly: true, ownDepartmentOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: true,
  },
  {
    key: 'referring_doctor',
    docsRow: 15,
    name: 'Visiting / Referring Doctor',
    description:
      'External clinician with read access to the patients they referred, through the referral portal.',
    category: 'external',
    homeWorkspace: 'referral-portal',
    permissions: [
      'rad.study.read',
      'rad.image.view',
      'rad.report.read',
      'lab.report.read',
      'invest.report.read',
      'org.read',
      'mdm.read',
      'tpl.form.read',
      'tpl.response.read',
      'org.patient.locate',
    ],
    abacDefaults: { ownPatientsOnly: true, dataClassMasks: ['aadhaar', 'address'] },
    mfaMandatory: true,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'nurse_opd',
    docsRow: 16,
    name: 'Nurse — OPD / Vitals',
    description: 'Vitals room, injections and dressings.',
    category: 'nursing',
    homeWorkspace: 'vitals-room',
    permissions: [
      ...PSY_NURSING,
      ...ONCO_CHAIR,
      ...IMMUNISATION_FLOOR,
      ...HEALTHCHECK_FLOOR,
      ...ANC_FLOOR,
      ...WOUND_BEDSIDE,
      'slp.swallow_order.read',
      ...OPD_NURSING_FLOOR,
      ...OPHTHA_OPTOMETRY,
      // The phototherapy cabin is an OPD treatment room, and the person under
      // the lamps is looked after by the nurse who runs it. Delivering a
      // session is theirs; moving the ceiling that stops a burn is not.
      ...DERM_DELIVERY,
      ...CONSOLE_TECHNICIAN,
      'nursing.ward.read',
      'mar.read',
      'nursing.assessment.record',
      ...BED_BOARD_READER,
      'admission.request',
      ...PLASTER_ROOM,
      ...ORTHO_CLINIC,
      ...WARD_DIAGNOSTICS,

      ...PATIENT_READ,
      ...QUEUE_CALLER,
      'visit.list',
      'visit.update',
      'consent.capture',

      // OP-007 §12 defaults. The nurse runs the vitals room, records and
      // corrects observations and can send a deteriorating patient to the ER --
      // and prints an Rx, but never creates or signs one.
      ...VITALS_RECORDER,
      ...CDSS_SAFETY_FLOOR,
      'vitals.queue.read',
      'vitals.queue.manage',
      'vitals.record.correct',
      'vitals.escalate.er',
      'opd.encounter.read',
      'opd.allergy.update',
      'terminology.read',
      'rx.print',

      ...BASE_CLINICAL,
      ...LABEL_PRINTER,
      'barcode.verify.sample',
    ],
    abacDefaults: { ownDepartmentOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'nurse_ward',
    docsRow: 17,
    name: 'Nurse — Ward',
    description: 'Nursing station: vitals, medication administration, notes, handover and ward indents.',
    category: 'nursing',
    homeWorkspace: 'nursing-station',
    permissions: [
      ...PSY_NURSING,
      ...ONCO_CHAIR,
      ...LABOUR_FLOOR,
      ...IMMUNISATION_FLOOR,
      ...DIALYSIS_NURSE,
      ...WOUND_BEDSIDE,
      // The ward half of the swallow acknowledgement. A ward that has not read
      // the order is a ward still working from the last one.
      ...SWALLOW_ACKNOWLEDGER,
      ...OPD_NURSING_FLOOR,
      ...CONSOLE_TECHNICIAN,
      ...DISCHARGE_WARD,
      'mortuary.case.read',
      'mortuary.body.operate',
      ...BLOOD_BEDSIDE,
      'code.call',
      'code.record',
      'cart.check.record',
      'icu.flowsheet.read',
      ...NURSING_BEDSIDE,
      ...WARD_FLOOR,
      'housekeeping.task.read',
      ...POLYTRAUMA_FLOOR,
      ...CAST_WATCH,
      'fleet.request.create',
      'fleet.request.read',
      ...WARD_DIAGNOSTICS,

      ...VITALS_RECORDER,
      ...CDSS_SAFETY_FLOOR,
      'opd.encounter.read',
      'order.list',

      ...BASE_CLINICAL,
      ...LABEL_PRINTER,
      'barcode.wristband.issue',
      'barcode.verify.mar',
      'barcode.verify.sample',
      'notify.escalation.read',

      // Phase 4 — the ward or unit is a sub-store: indent, receive, return,
      // count the shelf and record what was used. No adjustment and no
      // approval; those are the store in-charge's (NC-006 §12).
      ...SUB_STORE_CUSTODIAN,
    ],
    abacDefaults: { assignedWardOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'nurse_icu',
    docsRow: 18,
    name: 'Nurse — ICU',
    description: 'Hourly charting, ventilator observations and infusion management.',
    category: 'nursing',
    homeWorkspace: 'icu-flowsheet',
    permissions: [
      ...DIALYSIS_NURSE,
      ...WOUND_BEDSIDE,
      ...SWALLOW_ACKNOWLEDGER,
      ...CONSOLE_TECHNICIAN,
      ...DISCHARGE_WARD,
      'mortuary.case.read',
      'mortuary.body.operate',
      ...ICU_BEDSIDE,
      ...BLOOD_BEDSIDE,
      'icu.score.compute',
      'cart.reseal',
      ...NURSING_BEDSIDE,
      'infection.isolation.manage',
      ...WARD_FLOOR,
      'housekeeping.task.read',
      ...POLYTRAUMA_NURSING,
      'fleet.request.create',
      'fleet.request.read',
      ...WARD_DIAGNOSTICS,

      ...VITALS_RECORDER,
      ...CDSS_SAFETY_FLOOR,
      'opd.encounter.read',
      'order.list',

      ...BASE_CLINICAL,
      ...LABEL_PRINTER,
      'barcode.verify.mar',
      'barcode.verify.sample',
      'barcode.verify.blood',
      'notify.escalation.read',

      // Phase 4 — the ward or unit is a sub-store: indent, receive, return,
      // count the shelf and record what was used. No adjustment and no
      // approval; those are the store in-charge's (NC-006 §12).
      ...SUB_STORE_CUSTODIAN,
    ],
    abacDefaults: { assignedWardOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'nurse_er_triage',
    docsRow: 19,
    name: 'Nurse — ER / Triage',
    description: 'Triage board and emergency nursing.',
    category: 'nursing',
    homeWorkspace: 'triage-board',
    permissions: [
      ...OPD_NURSING_FLOOR,
      ...CONSOLE_TECHNICIAN,
      ...ICU_BEDSIDE,
      ...BLOOD_BEDSIDE,
      'cart.reseal',
      ...NURSING_BEDSIDE,
      ...BED_BOARD_READER,
      'admission.request',
      'bed.hold.create',
      ...POLYTRAUMA_NURSING,
      ...PLASTER_ROOM,
      ...PREHOSPITAL_RECEIVER,
      ...MLC_FLOOR,
      ...ER_FLOOR,
      ...TRIAGE_FLOOR,
      ...TRAUMA_TEAM,
      'er.disposition.decide',
      ...WARD_DIAGNOSTICS,

      'receipt.collect.night',

      ...VITALS_RECORDER,
      ...CDSS_SAFETY_FLOOR,
      'vitals.escalate.er',
      'vitals.queue.read',
      'opd.encounter.read',
      'order.list',

      ...BASE_CLINICAL,
      ...LABEL_PRINTER,
      'barcode.wristband.issue',
      'barcode.verify.mar',
      'barcode.verify.sample',
      'notify.escalation.read',

      // Phase 4 — the ward or unit is a sub-store: indent, receive, return,
      // count the shelf and record what was used. No adjustment and no
      // approval; those are the store in-charge's (NC-006 §12).
      ...SUB_STORE_CUSTODIAN,
    ],
    abacDefaults: {},
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'nurse_ot_scrub',
    docsRow: 20,
    name: 'Nurse — OT / Scrub',
    description: 'OT checklist, instrument and swab counts, consumables and implant capture.',
    category: 'nursing',
    homeWorkspace: 'ot-checklist',
    permissions: [
      ...LABOUR_FLOOR,
      ...PROCEDURE_FLOOR,
      ...BLOOD_BEDSIDE,
      'code.call',
      'code.record',
      ...OT_FLOOR,
      'cssd.issue',
      ...NURSING_BEDSIDE,
      ...POLYTRAUMA_NURSING,
      ...IMPLANT_AT_THE_TROLLEY,
      ...BASE_CLINICAL,
      ...LABEL_PRINTER,
      'barcode.verify.implant',
      'barcode.verify.cssd',
      // Phase 4 — the ward or unit is a sub-store: indent, receive, return,
      // count the shelf and record what was used. No adjustment and no
      // approval; those are the store in-charge's (NC-006 §12).
      ...SUB_STORE_CUSTODIAN,
    ],
    abacDefaults: {},
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'infection_control_nurse',
    docsRow: 21,
    name: 'Nurse — Infection Control Officer',
    description: 'Healthcare-associated infection surveillance and isolation management.',
    category: 'nursing',
    homeWorkspace: 'infection-control',
    permissions: [
      'ot.board.read',
      'cssd.recall.run',
      ...INFECTION_CONTROL,
      ...BED_BOARD_READER,
      'transfer.read',
      'bed.block',
      ...BASE_CLINICAL,
      ...BREAK_GLASS,
      'audit.report.read',
      'notify.report.read',
    ],
    abacDefaults: {},
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'nurse_supervisor',
    docsRow: 22,
    name: 'Nurse Supervisor / Matron',
    description: 'Nursing command centre: roster, nurse-patient ratios, audits and the escalation board.',
    category: 'nursing',
    homeWorkspace: 'nursing-command-centre',
    permissions: [
      ...WOUND_CLINIC,
      ...OPD_NURSING_FLOOR,
      'procedure.room.configure',
      ...DISCHARGE_WARD,
      'mortuary.case.read',
      'mortuary.report.read',
      ...ICU_BEDSIDE,
      'cart.reseal',
      'code.close',
      'ot.board.read',
      'ot.case.schedule',
      ...IP_BILL_READER,
      ...NURSING_IN_CHARGE,
      ...BED_MANAGEMENT,
      'bed.block',
      'housekeeping.task.inspect',
      'housekeeping.override',
      ...POLYTRAUMA_FLOOR,
      'polytrauma.team.assign',
      'polytrauma.consult.escalate',
      ...WARD_DIAGNOSTICS,

      'queue.token.manage',
      'patient.record.create_override',

      // OP-007 §12: the supervisor corrects any nurse's observation, configures
      // the stations and reads the room's throughput. She does not chart in it.
      'vitals.queue.read',
      'vitals.queue.manage',
      'vitals.record.read',
      'vitals.record.correct',
      'vitals.configure',
      'vitals.report.read',

      ...BASE_CLINICAL,
      ...BREAK_GLASS,
      ...APPROVER,
      'notify.escalation.read',
      'notify.admin.manage',
      'notify.report.read',
      'admin.access.approve',
      'org.transfer.manage',
      'barcode.verify.override',
      'barcode.report.read',

      // Phase 4 — the nursing command centre owns the ward stores. Approves the
      // par-level override NC-006 §5 allows on a ward (`allow_with_approval`)
      // and the manual consignment entry NC-007 §5 requires a supervisor for.
      'inventory.item.read',
      'inventory.item.list',
      'inventory.store.read',
      'inventory.store.list',
      'inventory.stock.read',
      'inventory.stock.list',
      'inventory.store_indent.read',
      'inventory.store_indent.list',
      'inventory.store_indent.approve',
      'inventory.consumption.read',
      'inventory.consumption.list',
      'inventory.consumption.supervise',
      'inventory.consumption.report.read',
      'inventory.count.read',
      'inventory.count.list',
      'inventory.report.read',
      'inventory.negative_stock.override',
      'inventory.consignment.approve',
    ],
    abacDefaults: {},
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'ward_attendant',
    docsRow: 23,
    name: 'Ward Boy / Attendant / Transport',
    description: 'Mobile task list for patient transport and bed status updates.',
    category: 'facilities',
    homeWorkspace: 'task-list',
    permissions: [
      'mortuary.body.operate',
      'nursing.ward.read',
      ...HOUSEKEEPING_FLOOR,
      'transfer.accept',
      'org.read',
      'mdm.read',
      'tpl.form.read',
      'barcode.scan',
      'print.job.create',
      'print.job.read',
    ],
    abacDefaults: { assignedWardOnly: true, dataClassMasks: ['aadhaar', 'address', 'mobile', 'diagnosis'] },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'receptionist',
    docsRow: 24,
    name: 'Receptionist / Front Office',
    description: 'Patient registration, appointments, token issue and ABHA linkage.',
    category: 'admin',
    homeWorkspace: 'registration',
    permissions: [
      'healthcheck.booking.create',
      ...HEALTHCHECK_FLOOR,
      ...CONSOLE_FLOOR,
      ...BED_MANAGEMENT,
      'admission.cancel',
      'fleet.request.create',
      'fleet.request.read',
      ...ER_FLOOR,
      'er.identity.merge',
      ...DIAGNOSTIC_FRONT_DESK,

      ...PATIENT_DESK,
      ...APPOINTMENT_DESK,
      ...VISIT_DESK,
      ...QUEUE_DESK,
      ...ABHA_DESK,
      'frontoffice.dashboard.read',
      'messaging.message.send',
      'messaging.optin.manage',
      'vitals.queue.read',

      ...BASE_STAFF,
      'barcode.scan',
      ...LABEL_PRINTER,
      'barcode.wristband.issue',
      'org.patient.locate',
      'tpl.render',
      'tpl.response.write',
      'tpl.response.read',
      'email.verify.send',
    ],
    abacDefaults: { dataClassMasks: ['diagnosis'] },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'call_centre_agent',
    docsRow: 25,
    name: 'Call Centre Agent',
    description: 'Appointments, enquiries and follow-up calls.',
    category: 'admin',
    homeWorkspace: 'call-console',
    permissions: [
      ...FLEET_DISPATCH,
      ...PATIENT_READ,
      ...APPOINTMENT_DESK,
      'messaging.message.send',
      'messaging.inbox.read',
      'messaging.inbox.reply',
      'queue.virtual.join',
      ...BASE_STAFF,
      'org.patient.locate',
      'tpl.render',
    ],
    abacDefaults: { dataClassMasks: ['aadhaar', 'diagnosis'] },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'cashier',
    docsRow: 26,
    name: 'Cashier',
    description: 'Cash counter: receipts, shift open/close and limited refunds.',
    category: 'finance',
    homeWorkspace: 'cash-counter',
    permissions: [
      ...IP_BILL_READER,
      'admission.read',
      'admission.list',
      ...PATIENT_READ,
      ...CASHIER_BASE,
      ...QUEUE_CALLER,
      ...BASE_STAFF,
      'barcode.scan',
      'tpl.render',
      'print.job.reprint',
    ],
    abacDefaults: { amountLimit: { maxAmount: '2000.00', combine: 'whichever_is_lower' } },
    mfaMandatory: true,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'billing_executive',
    docsRow: 27,
    name: 'Billing Executive (OP/IP)',
    description: 'Bills, interim bills and discounts within a configured ceiling.',
    category: 'finance',
    homeWorkspace: 'billing-desk',
    permissions: [
      'ip.discharge.read',
      'ot.board.read',
      ...IP_BILL_DESK,
      ...BED_BOARD_READER,
      'transfer.read',
      ...PATIENT_READ,
      ...CASHIER_BASE,
      ...TARIFF_READ,
      // Phase 5 — OP-005. Assembles, finalises and invoices. Approving a
      // discount and raising a credit note are the accountant's keys, so the
      // person who gave the discount is never the person who allowed it.
      ...BILLING_DESK,
      ...PAYMENT_DESK,
      ...PACKAGE_DESK,
      // Phase 5 — RC-008. The billing desk quotes as well as bills; the price a
      // family is given and the bill they get should come from one set of hands
      // that can see both.
      ...ESTIMATE_DESK,
      // RC-006 — the read side. They raise the charge once finance accepts a
      // finding, and they run the pre-discharge check.
      ...LEAKAGE_DESK,
      'receipt.refund.pay',
      ...BASE_STAFF,
      'barcode.scan',
      'tpl.render',
      'print.job.reprint',
      'email.message.resend',
    ],
    // docs/05 §ABAC gives the worked example: "amount_limit (discount ≤ 10 %)".
    abacDefaults: { amountLimit: { maxPercent: '10', maxAmount: '5000.00', combine: 'whichever_is_lower' } },
    mfaMandatory: true,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'insurance_desk',
    docsRow: 28,
    name: 'Insurance / TPA Desk',
    description: 'Pre-authorisation, claims and supporting documents.',
    category: 'finance',
    homeWorkspace: 'insurance-queue',
    permissions: [
      // The eleventh session of a package of ten. The therapist asks; the desk
      // that owns the authorisation is the one that can extend it.
      'therapy.authorisation.extend',
      'therapy.episode.read',
      ...IP_BILL_READER,
      ...BED_BOARD_READER,
      'transfer.read',
      ...BASE_STAFF,
      // Phase 5 — EN-002 / RC-002. Assembles and submits; recording the payer's
      // decision is finance's key, so an approval nobody received cannot be
      // typed in by the person waiting for it.
      ...INSURANCE_DESK,
      // Phase 5 — RC-007. The same counter works government schemes: the desk
      // verifies the card, opens the case and submits the claim, but never
      // records what the authority paid.
      ...SCHEME_DESK,
      ...PATIENT_READ,
      ...TARIFF_READ,
      'bill.read',
      'bill.list',
      'tpl.render',
      'tpl.response.read',
      'org.patient.locate',
      'mdm.payer.propose',
    ],
    abacDefaults: {},
    mfaMandatory: true,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'corporate_billing',
    docsRow: 29,
    name: 'Corporate / B2B Billing',
    description: 'Corporate accounts, invoices and statements of account.',
    category: 'finance',
    homeWorkspace: 'corporate-accounts',
    permissions: [...BASE_STAFF, 'tpl.render', 'email.send', 'email.message.read'],
    abacDefaults: {},
    mfaMandatory: true,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'pharmacist_op',
    docsRow: 30,
    name: 'Pharmacist (OP)',
    description:
      'Outpatient dispensing, over-the-counter sales and returns. The second safety net on every prescription: the CDSS re-check at the counter is theirs, not the prescriber’s.',
    category: 'pharmacy',
    homeWorkspace: 'pharmacy-rx-queue',
    permissions: [
      ...CDSS_SAFETY_FLOOR,
      'rx.drug.search',
      'cdss.kb.read',
      ...BASE_CLINICAL,
      ...LABEL_PRINTER,
      'mdm.pharmacy.propose',
      ...PHARMACY_COUNTER,
    ],
    // No `requiresSecondPerson` here, deliberately.
    //
    // It used to sit on this role, meaning to say "this pharmacist is a valid
    // co-signer on a controlled-drug transaction". That is not what the flag
    // does. In `evaluateConditions` it means "this actor must supply a
    // co-signer *for every request they make*", and `PolicyGuard` never
    // supplies one — so the pharmacist could not read the item list, let alone
    // dispense. Being a valid co-signer is a property of holding the key, not
    // of a role-level condition; two-person verification is a property of an
    // action, and `requiresSecondPerson` on the permission already expresses
    // it. docs/04 §2 still mandates 2FA for anybody who can touch the narcotic
    // register, which is why MFA stays true.
    abacDefaults: {},
    mfaMandatory: true,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'pharmacist_ip',
    docsRow: 31,
    name: 'Pharmacist (IP / Ward stock)',
    description:
      'Ward indents, unit-dose dispensing and returns, scoped by ABAC to the wards the pharmacist covers.',
    category: 'pharmacy',
    homeWorkspace: 'pharmacy-ward-indents',
    permissions: [
      ...ONCO_PHARMACY,
      'ip.discharge.read',
      'ip.discharge.reconcile',
      'mar.read',
      'mar.order.verify',
      'nursing.ward.read',
      ...CDSS_SAFETY_FLOOR,
      'rx.drug.search',
      'cdss.kb.read',
      ...BASE_CLINICAL,
      ...LABEL_PRINTER,
      'mdm.pharmacy.propose',
      ...PHARMACY_COUNTER,
      // Ward stock is a sub-store, so the IP pharmacist also works the issue,
      // return and consumption side that the OP counter does not.
      'inventory.issue.pick',
      'inventory.issue.create',
      'inventory.issue.read',
      'inventory.issue.list',
      'inventory.return.read',
      'inventory.return.list',
      'inventory.return.inspect',
      'inventory.consumption.record',
      'inventory.consumption.read',
      'inventory.consumption.list',
      'inventory.consumption.reverse',
    ],
    abacDefaults: { assignedWardOnly: true },
    mfaMandatory: true,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'pharmacy_incharge',
    docsRow: 32,
    name: 'Pharmacy In-charge',
    description:
      'Pharmacy administration: purchasing, pricing, and narcotics under two-person authorisation.',
    category: 'pharmacy',
    homeWorkspace: 'pharmacy-admin',
    permissions: [
      ...ONCO_PHARMACY,
      'mar.read',
      'mar.order.verify',
      'nursing.ward.read',
      'receipt.petty.manage',

      'rx.drug.search',
      'cdss.rule.read',
      'cdss.rule.manage',
      'cdss.rule.test',
      'cdss.kb.read',
      'cdss.kb.manage',
      'cdss.report.read',

      ...BASE_CLINICAL,
      ...LABEL_PRINTER,
      ...APPROVER,
      'mdm.pharmacy.propose',
      'mdm.pharmacy.approve',
      'mdm.inventory.propose',
      'barcode.verify.override',
      'barcode.report.read',
      ...PHARMACY_COUNTER,
      ...PHARMACY_ADMIN,
      // The drug side of purchasing: NC-005 §3 gives the pharmacy in-charge the
      // indent and the receipt for scheduled drugs, and NC-021 §5 requires their
      // sign-off on a drug vendor. Raising a purchase order and approving one
      // are both deliberately absent — that is the purchase officer and the
      // finance approver, and `docs/04 §3` keeps them apart.
      'inventory.grn.create',
      'inventory.grn.qc',
      'inventory.grn.post',
      'inventory.transfer.create',
      'inventory.transfer.read',
      'inventory.transfer.list',
      'inventory.transfer.dispatch',
      'inventory.transfer.receive',
      'inventory.count.plan',
      // Not `inventory.count.approve`: PHARMACY_COUNTER already carries
      // `inventory.count.count`, and NC-006 §5 keeps counting and approving the
      // variance apart. The pharmacy's count variance is approved by stores or
      // finance, which is what makes the count evidence rather than assertion.
      'inventory.consumption.read',
      'inventory.consumption.list',
      'inventory.consumption.supervise',
    ],
    abacDefaults: {},
    mfaMandatory: true,
    sensitiveGrant: true,
    requiresCoSign: false,
  },
  {
    key: 'lab_technician',
    docsRow: 33,
    name: 'Lab Technician',
    description: 'Bench worklist and result entry. Deliberately cannot validate — that is the pathologist.',
    category: 'diagnostics',
    homeWorkspace: 'lab-bench',
    permissions: [
      ...CONSOLE_TECHNICIAN,
      'blood.inventory.read',
      'blood.unit.manage',
      ...LAB_BENCH,
      ...BASE_CLINICAL,
      ...LABEL_PRINTER,
      'barcode.verify.sample',
      // Phase 4 — the department store: reagents, films, packs and consumables
      // are indented, received and consumed here (NC-006 §12 sub-store custodians).
      ...SUB_STORE_CUSTODIAN,
    ],
    abacDefaults: {},
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'phlebotomist',
    docsRow: 34,
    name: 'Phlebotomist / Sample Collector',
    description: 'Collection list, sample collection, rejection and label printing.',
    category: 'diagnostics',
    homeWorkspace: 'lab-collection',
    permissions: [...LAB_COLLECTION, ...BASE_CLINICAL, ...LABEL_PRINTER, 'barcode.verify.sample'],
    abacDefaults: {},
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'lab_quality_manager',
    docsRow: 35,
    name: 'Lab Quality Manager',
    description: 'Internal quality control, external quality assessment and NABL documentation.',
    category: 'diagnostics',
    homeWorkspace: 'lab-qc',
    permissions: [
      ...LAB_QUALITY,

      ...BASE_CLINICAL,
      'mdm.lab.propose',
      'mdm.lab.approve',
      'mdm.quality.read',
      'audit.report.read',
    ],
    abacDefaults: {},
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'radiology_technician',
    docsRow: 36,
    name: 'Radiology Technician',
    description: 'Modality worklist, scheduling and acquisition status.',
    category: 'diagnostics',
    homeWorkspace: 'radiology-modality',
    permissions: [
      ...CONSOLE_TECHNICIAN,
      ...IMPLANT_LOOKUP,
      ...RADIOLOGY_MODALITY,
      ...INVESTIGATION_TECH,
      ...BASE_CLINICAL,
      ...LABEL_PRINTER,
      // Phase 4 — the department store: reagents, films, packs and consumables
      // are indented, received and consumed here (NC-006 §12 sub-store custodians).
      ...SUB_STORE_CUSTODIAN,
    ],
    abacDefaults: {},
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'blood_bank_officer',
    docsRow: 37,
    name: 'Blood Bank Technician / Officer',
    description: 'Donors, components, cross-match and issue under two-person verification.',
    category: 'diagnostics',
    homeWorkspace: 'blood-bank',
    permissions: [
      ...BLOOD_BANK,
      'polytrauma.case.read',
      'polytrauma.case.list',
      'polytrauma.blood.plan',
      ...BASE_CLINICAL,
      ...LABEL_PRINTER,
      'barcode.verify.blood',
    ],
    abacDefaults: {},
    mfaMandatory: true,
    sensitiveGrant: true,
    requiresCoSign: false,
  },
  {
    key: 'cssd_technician',
    docsRow: 38,
    name: 'CSSD Technician / In-charge',
    description: 'Tray assembly, sterilisation cycles, issue and return, and recall.',
    category: 'supply',
    homeWorkspace: 'cssd',
    permissions: [
      ...CSSD_FLOOR,
      'ot.board.read',
      ...BASE_STAFF,
      'barcode.scan',
      ...LABEL_PRINTER,
      'barcode.verify.cssd',
      // Phase 4 — the department store: reagents, films, packs and consumables
      // are indented, received and consumed here (NC-006 §12 sub-store custodians).
      ...SUB_STORE_CUSTODIAN,
    ],
    abacDefaults: {},
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'dietician',
    docsRow: 39,
    name: 'Dietician',
    description: 'Nutritional assessment and diet orders.',
    category: 'therapy',
    homeWorkspace: 'diet-worklist',
    permissions: [
      ...CONSOLE_TECHNICIAN,
      ...THERAPY_FLOOR,
      ...NUTRITION_CLINIC,
      // The dietician reads the swallow order and never writes one: the texture
      // a patient can manage is the speech therapist's finding, and a diet plan
      // that contradicts it is the aspiration.
      'slp.swallow_order.read',
      'nursing.ward.read',
      'nursing.assessment.record',
      'nursing.note.write',
      ...BED_BOARD_READER,
      ...BASE_CLINICAL,
      ...SIGNS_DOCUMENTS,
    ],
    abacDefaults: { careTeamOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'therapist',
    docsRow: 40,
    name: 'Physiotherapist / Occupational / Speech Therapist',
    description: 'Therapy assessments and session records.',
    category: 'therapy',
    homeWorkspace: 'therapy-schedule',
    permissions: [
      ...CONSOLE_TECHNICIAN,
      ...THERAPY_QUALIFIED,
      // A physiotherapist manages wounds in a rehabilitation setting and a
      // speech therapist writes swallow orders; both are this template in most
      // hospitals, and the department scopes which console they actually open.
      ...WOUND_BEDSIDE,
      ...SLP_CLINICAL,
      'nursing.ward.read',
      'nursing.note.write',
      'nursing.assessment.record',
      ...BED_BOARD_READER,
      ...CAST_WATCH,
      ...BASE_CLINICAL,
      ...SIGNS_DOCUMENTS,
      'fracture.record.read',
      'fracture.record.list',
      'ortho.episode.read',
      'ortho.exam.record',
      'ortho.prom.collect',
    ],
    abacDefaults: { careTeamOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'dialysis_technician',
    docsRow: 41,
    name: 'Dialysis Technician',
    description:
      'Runs the floor: books the chair, sets the machine up, logs and reprocesses the filters, records the session. Cannot write a prescription, mark an access ready to cannulate, or move a machine between isolation zones.',
    category: 'therapy',
    homeWorkspace: 'dialysis-board',
    permissions: [
      ...DIALYSIS_FLOOR,
      ...CONSOLE_TECHNICIAN,
      ...BASE_CLINICAL,
      ...LABEL_PRINTER,
      // Phase 4 — the ward or unit is a sub-store: indent, receive, return,
      // count the shelf and record what was used. No adjustment and no
      // approval; those are the store in-charge's (NC-006 §12).
      ...SUB_STORE_CUSTODIAN,
    ],
    abacDefaults: {},
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'counsellor',
    docsRow: 42,
    name: 'Counsellor / Psychologist',
    description:
      'Session notes with restricted visibility. Mental-health records are excluded from cross-branch sharing by default (EN-041 §3.4.3).',
    category: 'therapy',
    homeWorkspace: 'counselling-sessions',
    permissions: [
      ...PSY_THERAPY,
      ...CONSOLE_FLOOR,
      'polytrauma.case.list',
      'polytrauma.case.read',
      'polytrauma.family.update',
      ...BASE_CLINICAL,
      ...SIGNS_DOCUMENTS,
    ],
    abacDefaults: { ownPatientsOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'mrd_officer',
    docsRow: 43,
    name: 'MRD Officer / Coder',
    description: 'Coding, deficiency management, record retrieval and retention.',
    category: 'records',
    homeWorkspace: 'mrd-queue',
    permissions: [
      'obs.labour.read',
      'obs.birth.report',
      ...MORTUARY_CUSTODIAN,
      'ip.discharge.read',
      'ipbill.clearance.read',
      'admission.read',
      'admission.list',
      'transfer.read',
      'census.read',
      'fracture.record.list',
      'fracture.registry.export',
      ...MLC_RECORDS,
      ...TRAUMA_REGISTRY,
      'lab.report.read',
      'lab.report.export',
      'rad.report.read',
      'rad.image.share',
      'rad.image.export',
      'rad.mlc.read',
      'invest.report.read',
      'invest.media.export',

      'abdm.abha.delink',
      'consent.template.manage',

      ...PATIENT_READ,
      'patient.record.update',
      'patient.merge.review',
      'patient.merge.execute',
      'patient.record.export',
      'abdm.hip.link',
      'consent.ledger.read',

      // NC-003 §12. The coder codes and never QAs; proposes a destruction run
      // and never approves it; may place a legal hold but not lift one -- the
      // protective direction is the safe one to delegate.
      ...MRD_DESK,
      'mrd.legal_hold.set',
      'opd.encounter.read',
      'opd.diagnosis.update',
      'terminology.read',

      ...BASE_CLINICAL,
      'audit.patient.read',
      'audit.read',
      'audit.report.read',
      'mdm.clinical.propose',
      'mdm.terminology.manage',
      'mdm.map.manage',
      'mdm.valueset.manage',
      'tpl.print.manage',
      'tpl.governance.read',
      'tpl.reprint.override',
      'email.message.resend',
    ],
    abacDefaults: {},
    mfaMandatory: true,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'stores_keeper',
    docsRow: 44,
    name: 'Stores Keeper / Store In-charge',
    description:
      'Goods receipt, issues, transfers and stock counts. Posts the receipt and therefore never releases the invoice for payment, and counts the shelf and therefore never approves its own variance.',
    category: 'supply',
    homeWorkspace: 'stores',
    permissions: [
      ...IMPLANT_STORE,
      ...BASE_STAFF,
      'barcode.scan',
      ...LABEL_PRINTER,
      'mdm.inventory.propose',
      'org.transfer.manage',
      ...STORES_DESK,
      ...CONSIGNMENT_DESK,
      'inventory.consignment.receive',
      'vendor.master.read',
      'vendor.master.list',
      'vendor.item.read',
    ],
    abacDefaults: { ownDepartmentOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'purchase_officer',
    docsRow: 45,
    name: 'Purchase Officer',
    description:
      'Indents, requests for quotation, comparatives and purchase orders. Raises the order and never approves it — `docs/04 §3` puts maker and checker on different people for a PO, and the value bands decide who the checker is.',
    category: 'supply',
    homeWorkspace: 'procurement',
    permissions: [
      ...IMPLANT_STORE,
      ...BASE_STAFF,
      ...APPROVER,
      'wf.decide.bulk',
      'mdm.inventory.propose',
      'mdm.inventory.approve',
      'tpl.render',
      'email.send',
      ...PROCUREMENT_DESK,
      'inventory.indent.approve',
      'inventory.consignment.agreement.read',
      'inventory.consignment.agreement.list',
      'inventory.consignment.po.read',
      'inventory.consignment.po.list',
      'inventory.consignment.po.close',
    ],
    abacDefaults: { amountLimit: { maxAmount: '50000.00', combine: 'whichever_is_lower' } },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'accountant',
    docsRow: 46,
    name: 'Accountant / Finance Manager',
    description: 'General ledger, accounts payable and receivable, banking and financial reports.',
    category: 'finance',
    homeWorkspace: 'finance',
    permissions: [
      ...IP_BILL_READER,
      'ipbill.charge.run',
      'receipt.shift.open_any',
      'receipt.shift.force_close',
      'receipt.void',
      'receipt.night.reconcile',
      'receipt.forex.configure',
      'receipt.forex.collect',
      'receipt.export',
      'receipt.petty.manage',

      'receipt.report.read',
      'receipt.daybook.read',
      'receipt.daybook.close',
      'receipt.shift.list',
      'receipt.shift.variance.approve',
      'receipt.handover.accept',
      'messaging.cost.read',

      ...BASE_STAFF,
      ...APPROVER,
      'wf.decide.bulk',
      'wf.matrix.manage',
      'wf.matrix.publish',
      'mdm.finance.propose',
      'mdm.finance.approve',
      'tpl.render',
      'tpl.print.manage',
      'org.finance.read',
      'lic.invoice.read',
      'lic.invoice.pay',
      'lic.subscription.read',
      'audit.report.read',
      'email.send',

      // Phase 4 — accounts payable. Releases the invoice for payment and
      // therefore never posts the goods receipt (NC-005 §12), and approves a
      // vendor's bank change but never maintains the vendor record that
      // proposed it (NC-021 §5).
      // Phase 5 — RC-003. Builds the price list and submits it. Publishing is
      // the hospital admin's key, so the person who revises a rate is never the
      // person who makes it live (RC-003 §5).
      ...TARIFF_DESK,
      // Phase 5 — OP-005, the checker half of the maker-checker pair.
      ...BILLING_APPROVER,
      ...PAYMENT_FINANCE,
      // OP-023's checker half: deciding who pays an overrun on a fixed-price
      // promise is finance's call, never the desk that sold the package.
      'pkg.read',
      'pkg.list',
      'pkg.configure',
      'pkg.version.publish',
      'pkg.price.update',
      'pkg.booking.read',
      'pkg.booking.list',
      'pkg.booking.cancel',
      'pkg.activation.read',
      'pkg.activation.close',
      'pkg.variance.approve',
      'pkg.report.read',

      // EN-002 / RC-002 — the checker half. Finance records what the payer
      // decided and owns the empanelment contracts behind it. Deliberately not
      // `preauth.submit`: the desk assembles, finance records the answer.
      'ins.payer.read',
      'ins.payer.list',
      'ins.payer.configure',
      'ins.empanelment.read',
      'ins.empanelment.manage',
      'ins.case.read',
      'ins.case.list',
      'preauth.read',
      'preauth.list',
      'preauth.decision.record',
      'preauth.withdraw',
      'preauth.sla.read',

      // RC-007 — the checker half again. Finance records what the authority
      // paid, closes the case (which lifts the cash block), and is the second
      // pair of hands on a write-off.
      ...SCHEME_FINANCE,

      // RC-008 — finance owns the standing line sets and the measurement.
      // Reading estimate-versus-actual is how a hospital learns its quotes run
      // light, which is not something to leave with the people writing them.
      'est.read',
      'est.list',
      'est.template.read',
      'est.template.manage',
      'est.variance.read',
      'est.variance.record',

      // RC-006 — the whole audit. "Never auto-post" only means something if the
      // person accepting a finding is accountable for the charge that follows.
      ...LEAKAGE_FINANCE,

      // NC-034 — finance computes and pays. Approving is the hospital admin's,
      // so the calculation and its release are never the same hands.
      ...PAYOUT_FINANCE,

      'billing.gst.configure',
      'billing.discount_matrix.configure',

      'inventory.invoice.capture',
      'inventory.invoice.match',
      'inventory.invoice.approve',
      'inventory.invoice.read',
      'inventory.invoice.list',
      'inventory.po.read',
      'inventory.po.list',
      'inventory.po.approve',
      'inventory.comparative.read',
      'inventory.comparative.list',
      'inventory.comparative.approve',
      'inventory.grn.read',
      'inventory.grn.list',
      'inventory.purchase_return.read',
      'inventory.purchase_return.list',
      'inventory.purchase.emergency.approve',
      'inventory.purchase.report.read',
      'inventory.purchase.export',
      'inventory.purchase.configure',
      'inventory.valuation.read',
      'inventory.valuation.close',
      'inventory.adjustment.read',
      'inventory.adjustment.list',
      'inventory.adjustment.approve',
      'inventory.count.read',
      'inventory.count.list',
      'inventory.count.approve',
      'inventory.report.read',
      'inventory.export',
      'inventory.consignment.reconcile',
      'inventory.consignment.sign',
      'inventory.consignment.dispute.manage',
      'inventory.consignment.report.read',
      'inventory.consumption.report.read',
      'inventory.consumption.variance.read',
      'inventory.consumption.export',
      'finance.costcentre.read',
      'finance.costcentre.list',
      'finance.costcentre.manage',
      'finance.allocation.run',
      'finance.allocation.post',
      'vendor.master.read',
      'vendor.master.list',
      'vendor.kyc.verify',
      'vendor.bank.approve',
      'vendor.contract.read',
      'vendor.contract.list',
      'vendor.score.read',
      'vendor.report.read',
      'vendor.export',
      'pharmacy.report.read',
      'pharmacy.report.export',
      'pharmacy.day_close.read',
      'pharmacy.day_close.list',
    ],
    abacDefaults: {},
    mfaMandatory: true,
    sensitiveGrant: true,
    requiresCoSign: false,
  },
  {
    key: 'hr_executive',
    docsRow: 47,
    name: 'HR Executive / HR Manager',
    description: 'Employee master, leave and payroll.',
    category: 'admin',
    homeWorkspace: 'hr',
    permissions: [
      'labq.competency.manage',

      ...BASE_STAFF,
      ...APPROVER,
      'wf.decide.bulk',
      'wf.delegation.admin',
      'wf.matrix.manage',
      'admin.user.read',
      'admin.user.create',
      'admin.user.update',
      'admin.user.deactivate',
      'sso.reconcile',
      'tpl.render',
      'security.awareness.manage',
    ],
    abacDefaults: {},
    mfaMandatory: true,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'biomedical_engineer',
    docsRow: 48,
    name: 'Biomedical Engineer',
    description: 'Equipment registry, calibration, breakdowns and AERB compliance.',
    category: 'facilities',
    homeWorkspace: 'biomedical',
    permissions: [
      'implant.catalogue.read',
      'implant.stock.read',
      'implant.recall.read',
      'fleet.vehicle.read',
      'fleet.maintenance.manage',
      'labq.equipment.manage',
      'lab.instrument.downtime.record',
      'rad.configure',
      'rad.dose.read',

      ...BASE_STAFF,
      'barcode.scan',
      ...LABEL_PRINTER,
      'vitals.configure',
      'vitals.report.read',
      'security.patch.manage',
      'admin.status.read',

      // Phase 4 — spares and engineering consumables. Indents them, receives
      // them, records what a repair consumed.
      'inventory.item.read',
      'inventory.item.list',
      'inventory.store.read',
      'inventory.store.list',
      'inventory.stock.read',
      'inventory.stock.list',
      'inventory.store_indent.create',
      'inventory.store_indent.read',
      'inventory.store_indent.list',
      'inventory.issue.receive',
      'inventory.issue.read',
      'inventory.issue.list',
      'inventory.consumption.record',
      'inventory.consumption.read',
      'inventory.consumption.list',
      'inventory.indent.create',
      'inventory.indent.read',
      'inventory.indent.list',
      'vendor.master.read',
      'vendor.master.list',
      'vendor.item.read',
    ],
    abacDefaults: {},
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'facility_maintenance',
    docsRow: 49,
    name: 'Facility / Maintenance',
    description: 'Work orders and preventive maintenance.',
    category: 'facilities',
    homeWorkspace: 'facility',
    permissions: ['bed.board.read', 'housekeeping.task.read', ...BASE_STAFF, 'barcode.scan'],
    abacDefaults: {},
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'housekeeping',
    docsRow: 50,
    name: 'Housekeeping Supervisor / Staff',
    description: 'Mobile task list for room turnover and bio-medical waste rounds.',
    category: 'facilities',
    homeWorkspace: 'housekeeping',
    permissions: [
      ...HOUSEKEEPING_FLOOR,
      'housekeeping.task.inspect',
      'org.read',
      'mdm.read',
      'tpl.form.read',
      'barcode.scan',
      'print.job.create',
      'print.job.read',

      // Phase 4 — a non-clinical sub-store: indent and receive, nothing more.
      // Deliberately no `inventory.consumption.record`, which can be
      // patient-linked and would sit oddly against this role's identifier masks.
      'inventory.item.read',
      'inventory.item.list',
      'inventory.store.read',
      'inventory.store.list',
      'inventory.stock.read',
      'inventory.stock.list',
      'inventory.store_indent.create',
      'inventory.store_indent.read',
      'inventory.store_indent.list',
      'inventory.issue.receive',
      'inventory.issue.read',
      'inventory.issue.list',
      'inventory.return.create',
      'inventory.return.read',
      'inventory.return.list',
    ],
    abacDefaults: { dataClassMasks: ['aadhaar', 'address', 'mobile', 'diagnosis', 'full_name'] },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'security_officer',
    docsRow: 51,
    name: 'Security Officer / Guard',
    description: 'Gate console: visitors, passes and incident logging.',
    category: 'facilities',
    homeWorkspace: 'gate-console',
    permissions: [...BASE_STAFF, 'barcode.scan', ...LABEL_PRINTER, ...MLC_SECURITY],
    abacDefaults: { dataClassMasks: ['aadhaar', 'diagnosis'] },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'ambulance_crew',
    docsRow: 52,
    name: 'Ambulance Dispatcher / Driver / EMT',
    description: 'Dispatch board and trip app with GPS and pre-hospital vitals.',
    category: 'facilities',
    homeWorkspace: 'ambulance-dispatch',
    permissions: [...BASE_CLINICAL, 'notify.escalation.read', ...FLEET_CREW, ...PREHOSPITAL_CREW],
    abacDefaults: { dataClassMasks: ['aadhaar'] },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'kitchen_staff',
    docsRow: 53,
    name: 'Canteen / Kitchen Staff',
    description: 'Kitchen board: diet dispatch and canteen point of sale.',
    category: 'facilities',
    homeWorkspace: 'kitchen-board',
    permissions: [
      // The kitchen half of the swallow acknowledgement. Not a clinical grant:
      // it is the only way the tray changes, and it is the only clinical key
      // this role holds.
      ...SWALLOW_ACKNOWLEDGER,
      'org.read',
      'mdm.read',
      'tpl.form.read',
      'barcode.scan',
      'print.job.create',
      'print.job.read',

      // Phase 4 — a non-clinical sub-store: indent and receive, nothing more.
      // Deliberately no `inventory.consumption.record`, which can be
      // patient-linked and would sit oddly against this role's identifier masks.
      'inventory.item.read',
      'inventory.item.list',
      'inventory.store.read',
      'inventory.store.list',
      'inventory.stock.read',
      'inventory.stock.list',
      'inventory.store_indent.create',
      'inventory.store_indent.read',
      'inventory.store_indent.list',
      'inventory.issue.receive',
      'inventory.issue.read',
      'inventory.issue.list',
      'inventory.return.create',
      'inventory.return.read',
      'inventory.return.list',
    ],
    abacDefaults: { dataClassMasks: ['aadhaar', 'address', 'mobile', 'diagnosis'] },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'quality_manager',
    docsRow: 54,
    name: 'Quality Manager (NABH)',
    description: 'Quality indicators, audits, incident reporting and corrective/preventive action.',
    category: 'governance',
    homeWorkspace: 'quality',
    permissions: [
      'icu.flowsheet.read',
      'blood.inventory.read',
      'ot.board.read',
      'cssd.recall.run',
      'infection.hai.read',
      'nursing.ward.read',
      ...IMPLANT_RECALL_OFFICER,
      'fracture.record.list',
      'fleet.report.read',
      'mlc.register.read',
      'trauma.activation.read',
      'trauma.activation.list',
      'trauma.survey.read',
      'trauma.score.read',
      'mci.incident.read',
      'lab.report.read',
      'labq.checklist.manage',
      'labq.accreditation.manage',
      'labq.indicator.review',
      'labq.nc.manage',
      'labq.auditpack.generate',
      'labq.report.read',

      'consent.report.read',
      'consent.template.manage',

      'mrd.coding.qa',
      'mrd.coding.list',
      'mrd.record.list',
      'mrd.deficiency.read',
      'mrd.report.read',
      'opd.audit.read',
      'vitals.report.read',
      'cdss.rule.read',
      'cdss.governance.read',
      'cdss.governance.manage',
      'cdss.report.read',

      ...BASE_STAFF,
      'audit.read',
      'audit.report.read',
      'audit.breakglass.review',
      'mdm.quality.read',
      'mdm.review.manage',
      'tpl.governance.read',
      'notify.report.read',
      'wf.report.read',
      'org.report.read',
      'dr.drill.manage',
      'dr.drill.read',
      'security.report.read',
      'barcode.report.read',

      // Phase 4 — NABH evidence: recalls, cold chain, expiry loss, narcotic
      // registers and vendor audits. Read-only throughout.
      'inventory.report.read',
      'inventory.analysis.read',
      'inventory.batch.read',
      'inventory.batch.list',
      'inventory.batch.trace',
      'inventory.coldchain.read',
      'inventory.expiry.read',
      'inventory.count.read',
      'inventory.count.list',
      'pharmacy.recall.read',
      'pharmacy.recall.list',
      'pharmacy.intervention.read',
      'pharmacy.intervention.list',
      'pharmacy.report.read',
      'vendor.audit.manage',
      'vendor.score.read',
      'vendor.report.read',
    ],
    abacDefaults: {},
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'marketing_crm',
    docsRow: 55,
    name: 'Marketing / CRM Executive',
    description: 'Leads, campaigns and outreach. Health content requires DPO approval.',
    category: 'admin',
    homeWorkspace: 'crm',
    permissions: [
      'messaging.campaign.manage',
      'messaging.template.configure',
      'messaging.inbox.read',
      'messaging.optin.read',

      ...BASE_STAFF,
      'email.campaign.manage',
      'email.campaign.send',
      'email.suppression.manage',
      'email.report.read',
      'tpl.branding.manage',
      'tpl.print.manage',
    ],
    abacDefaults: { dataClassMasks: ['aadhaar', 'diagnosis'] },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'it_admin',
    docsRow: 56,
    name: 'IT Admin / Helpdesk',
    description: 'Tickets, devices, printers, integrations and security operations.',
    category: 'admin',
    homeWorkspace: 'it-console',
    permissions: [
      ...CONSOLE_ADMIN,
      'lab.instrument.manage',
      'integration.lab.configure',
      'integration.lab.read',
      'integration.lab.raw.read',
      'integration.lab.replay',
      'rad.pacs.configure',
      'rad.pacs.read',
      'rad.pacs.retention',
      'rad.mwl.read',

      'messaging.message.read',
      'abdm.registry.manage',

      'messaging.provider.configure',
      'messaging.provider.read',
      'messaging.template.configure',
      'messaging.trigger.configure',
      'integration.abdm.configure',
      'integration.abdm.read',

      'cdss.rule.read',
      'cdss.rule.publish',
      'cdss.kb.read',
      'cdss.kb.manage',
      'cdss.snapshot.read',
      'vitals.configure',

      ...BASE_STAFF,
      'admin.user.read',
      'admin.user.reset',
      'admin.session.manage',
      'admin.device.manage',
      'admin.settings.read',
      'admin.status.read',
      'admin.report.read',
      'admin.print.configure',
      'admin.print.read',
      'print.job.manage',
      'barcode.scheme.configure',
      'barcode.device.configure',
      'ihub.connector.read',
      'ihub.connector.manage',
      'ihub.mapping.manage',
      'ihub.schedule.manage',
      'ihub.message.read',
      'ihub.message.retry',
      'ihub.message.replay',
      'ihub.dlq.manage',
      'ihub.health.read',
      'ihub.report.read',
      'sso.provider.manage',
      'sso.mapping.manage',
      'sso.identity.manage',
      'sso.log.read',
      'sso.scim.manage',
      'sso.reconcile',
      'sso.report.read',
      'audit.integrity.run',
      'audit.archive.manage',
      'audit.shipping.manage',
      'dr.repository.manage',
      'dr.backup.read',
      'dr.backup.run',
      'dr.restore.test',
      'dr.restore.request',
      'dr.drill.manage',
      'dr.runbook.manage',
      'dr.status.read',
      'dr.downtime.manage',
      'dr.maintenance.manage',
      'dr.report.read',
      'security.posture.read',
      'security.asset.manage',
      'security.vuln.manage',
      'security.patch.manage',
      'security.incident.read',
      'security.incident.manage',
      'security.endpoint.manage',
      'security.edge.manage',
      'security.siem.manage',
      'security.secret.manage',
      'security.report.read',
      'gateway.product.manage',
      'gateway.client.manage',
      'gateway.policy.manage',
      'gateway.usage.read',
      'gateway.log.read',
      'gateway.webhook.manage',
      'gateway.status.manage',
      'gateway.devportal.admin',
      'email.provider.manage',
      'email.sender.manage',
      'email.message.read',
      'email.message.resend',
      'email.suppression.manage',
      'email.report.read',
      'notify.type.manage',
      'notify.admin.read',
      'notify.report.read',
      'tpl.print.manage',
    ],
    abacDefaults: { deviceBound: true },
    mfaMandatory: true,
    sensitiveGrant: true,
    requiresCoSign: false,
  },
  {
    key: 'privacy_officer',
    docsRow: 57,
    name: 'Privacy Officer / DPO',
    description:
      'Consent ledger, PHI access reports, break-glass review, data-subject access requests and breach notification.',
    category: 'governance',
    homeWorkspace: 'privacy-dashboard',
    permissions: [
      'consent.artefact.manage',

      'consent.ledger.read',
      'consent.withdraw',
      'consent.notice.manage',
      'consent.dsar.manage',
      'consent.report.read',
      'messaging.optin.manage',
      'messaging.optin.read',
      'abdm.consent.read',

      'mrd.record.list',
      'mrd.record.read',
      'mrd.record.export',
      'mrd.search',
      'mrd.destruction.approve',
      'cdss.alert.replay',
      'opd.audit.read',

      ...BASE_STAFF,
      'audit.read',
      'audit.patient.read',
      'audit.user.read',
      'audit.breakglass.review',
      'audit.case.manage',
      'audit.export',
      'audit.integrity.run',
      'audit.retention.configure',
      'audit.config.manage',
      'audit.report.read',
      'admin.audit.read',
      'admin.audit.export',
      'org.audit.read',
      'org.policy.manage',
      'ihub.dataflow.read',
      'gateway.dataflow.read',
      'email.recipient.read',
      'email.phi.read',
      'security.breach.notify',
      'security.incident.read',
      'security.posture.read',
      'notify.admin.read',
      'wf.audit.read',
    ],
    abacDefaults: { deviceBound: true },
    mfaMandatory: true,
    sensitiveGrant: true,
    requiresCoSign: false,
  },
  {
    key: 'auditor',
    docsRow: 58,
    name: 'Auditor (internal / external)',
    description: 'Read-only across the tenant. Every export is audited.',
    category: 'governance',
    homeWorkspace: 'audit-workspace',
    permissions: [
      'lab.order.list',
      'lab.order.read',
      'lab.report.read',
      'lab.qc.read',
      'labq.qc.read',
      'labq.report.read',
      'rad.report.read',
      'rad.dose.read',
      'rad.pacs.read',
      'integration.lab.read',
      'invest.report.read',

      ...PATIENT_READ,
      'appointment.list',
      'visit.list',
      'queue.analytics.read',
      'receipt.report.read',
      'consent.ledger.read',
      'consent.report.read',

      'opd.encounter.read',
      'opd.audit.read',
      'order.list',
      'terminology.read',
      'vitals.record.read',
      'vitals.report.read',
      'cdss.alert.read',
      'cdss.alert.replay',
      'cdss.snapshot.read',
      'cdss.rule.read',
      'cdss.governance.read',
      'cdss.report.read',
      'mrd.record.list',
      'mrd.record.read',
      'mrd.search',
      'mrd.coding.list',
      'mrd.deficiency.read',
      'mrd.report.read',

      'org.read',
      'mdm.read',
      'mdm.report.read',
      'mdm.quality.read',
      'tpl.form.read',
      'tpl.governance.read',
      'lic.entitlement.read',
      'audit.read',
      'audit.patient.read',
      'audit.export',
      'audit.integrity.run',
      'audit.report.read',
      'admin.audit.read',
      'admin.audit.export',
      'admin.role.read',
      'admin.report.read',
      'org.audit.read',
      'org.report.read',
      'org.finance.read',
      'wf.audit.read',
      'wf.report.read',
      'dr.backup.read',
      'dr.drill.read',
      'dr.report.read',
      'security.posture.read',
      'security.incident.read',
      'security.report.read',
      'gateway.dataflow.read',
      'notify.report.read',
      'lic.subscription.read',

      // Phase 4 — read-only reach across stores, procurement, consignment,
      // consumption and the statutory registers. Every key here is a read, a
      // list or an audited export; docs/05 row 58 admits nothing else.
      ...SUPPLY_CHAIN_AUDIT,
    ],
    abacDefaults: { dataClassMasks: ['aadhaar'] },
    mfaMandatory: true,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'patient',
    docsRow: 59,
    name: 'Patient',
    description:
      'Own records, appointments, bills and family access with consent. Authenticates by OTP or ABHA.',
    category: 'external',
    homeWorkspace: 'patient-portal',
    permissions: ['tpl.response.read', 'tpl.render'],
    abacDefaults: { ownPatientsOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'family_attendant',
    docsRow: 60,
    name: 'Family / Attendant (bystander)',
    description:
      'Limited view: bill, visiting pass and status updates. Linked by an explicit consent artefact.',
    category: 'external',
    homeWorkspace: 'family-view',
    permissions: ['tpl.render'],
    abacDefaults: { ownPatientsOnly: true, dataClassMasks: ['diagnosis', 'aadhaar'] },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'corporate_hr_client',
    docsRow: 61,
    name: 'Corporate HR Client',
    description: "Their employees' utilisation and invoices, through the corporate portal.",
    category: 'external',
    homeWorkspace: 'corporate-portal',
    permissions: ['tpl.render', 'lic.entitlement.read'],
    abacDefaults: { dataClassMasks: ['diagnosis', 'aadhaar', 'address'] },
    mfaMandatory: true,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'payer_user',
    docsRow: 62,
    name: 'TPA / Insurer User',
    description: 'Pre-authorisations and claims for their own payer only.',
    category: 'external',
    homeWorkspace: 'payer-portal',
    permissions: ['tpl.render', 'tpl.response.read'],
    abacDefaults: { dataClassMasks: ['aadhaar'] },
    mfaMandatory: true,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'vendor',
    docsRow: 63,
    name: 'Vendor',
    description: 'Purchase orders, invoices and consignment stock, through the vendor portal.',
    category: 'external',
    homeWorkspace: 'vendor-portal',
    permissions: ['tpl.render'],
    abacDefaults: {},
    mfaMandatory: true,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  /**
   * OP-025 §0.7 asks each console to add its own sub-roles. The optometrist is
   * the first: they run the refraction lane, record everything a doctor reads,
   * and sign nothing — unless the hospital has delegated the spectacle
   * prescription, which is a separate key the admin grants deliberately.
   */
  {
    key: 'optometrist',
    docsRow: 65,
    name: 'Optometrist',
    description:
      'Runs the refraction lane: acuity, refraction, pressure and the lensmeter. Signs a spectacle prescription only where the hospital delegates it.',
    category: 'therapy',
    homeWorkspace: 'ophtha-worklist',
    permissions: [
      'procedure.order.read',
      'procedure.timeout.confirm',
      ...OPHTHA_OPTOMETRY,
      ...CONSOLE_TECHNICIAN,
      ...BASE_CLINICAL,
      ...LABEL_PRINTER,
      'ophtha.spectacle_rx.print',
    ],
    abacDefaults: { ownDepartmentOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  /**
   * The cardio-pulmonary laboratory is one room and one set of staff in every
   * hospital that has one: the person who hooks up an ECG also runs the
   * treadmill and the spirometer. Splitting it into a cardiac technician and a
   * pulmonary technician would be inventing an org chart nobody has.
   *
   * They record everything and interpret nothing. The one key that matters here
   * is the one they *do not* hold: `cardio.ecg.acknowledge_critical`, because
   * an acknowledgement is a handover to somebody who can act, and a technician
   * acknowledging their own critical tracing closes the loop without anybody
   * having been told.
   */
  {
    key: 'cardiopulmonary_technician',
    docsRow: 66,
    name: 'Cardio-Pulmonary Lab Technician',
    description:
      'Runs ECGs, treadmills, spirometry and sleep studies. Records the numbers and the effort grade; the interpretation and the critical acknowledgement belong to a doctor.',
    category: 'diagnostics',
    homeWorkspace: 'cardiopulmonary-lab',
    permissions: [
      ...CARDIO_TECHNICIAN,
      ...PULMO_TECHNICIAN,
      ...CONSOLE_TECHNICIAN,
      ...BASE_CLINICAL,
      ...LABEL_PRINTER,
      'procedure.order.read',
      'procedure.timeout.confirm',
    ],
    abacDefaults: { ownDepartmentOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  /**
   * Audiology is the one console where the technician signs, and that is not a
   * concession — it is the profession. An audiologist's registered scope is
   * producing and interpreting the audiogram, fitting the aid and verifying it
   * in the ear. The ENT surgeon reads the report; they do not write it.
   */
  {
    key: 'audiologist',
    docsRow: 67,
    name: 'Audiologist / Speech-Language Pathologist',
    description:
      'Runs the booth, signs the audiogram, and fits and verifies hearing aids. The four-frequency average and the degree of loss are derived from the thresholds they enter.',
    category: 'therapy',
    homeWorkspace: 'audiology-booth',
    permissions: [
      ...ENT_AUDIOLOGY,
      'ent.exam.read',
      'ent.report.read',
      ...CONSOLE_TECHNICIAN,
      ...BASE_CLINICAL,
      ...LABEL_PRINTER,
    ],
    abacDefaults: { ownDepartmentOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  /**
   * A registered dental hygienist charts, scales and records periodontal
   * findings. They do not price work and they do not present a plan, because a
   * treatment plan is a quotation the patient will be asked to consent to and
   * pay for.
   */
  {
    key: 'dental_hygienist',
    docsRow: 68,
    name: 'Dental Hygienist',
    description:
      'Charts the mouth, records the periodontal examination and carries out hygiene procedures. Cannot price or present a treatment plan.',
    category: 'therapy',
    homeWorkspace: 'dental-chair',
    permissions: [
      ...DENTAL_HYGIENE,
      'dental.sitting.record',
      ...CONSOLE_TECHNICIAN,
      ...BASE_CLINICAL,
      ...LABEL_PRINTER,
      'procedure.order.read',
      'procedure.timeout.confirm',
    ],
    abacDefaults: { ownDepartmentOnly: true },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
  {
    key: 'device',
    docsRow: 64,
    name: 'Kiosk / TV / Device',
    description:
      'Scoped device token, not a person. Boards and kiosks read only what their pairing grants; they never idle out but their token is narrowly scoped.',
    category: 'device',
    homeWorkspace: 'device-display',
    permissions: [
      'integration.lab.ingest',
      'integration.lab.send',
      'integration.rad.mpps',
      'integration.rad.study',

      'kiosk.checkin',
      'queue.token.issue',
      'queue.board.read',
      'print.agent',
      'print.job.create',
      'barcode.scan',
      'integration.vitals.ingest',
    ],
    abacDefaults: {
      deviceBound: true,
      dataClassMasks: ['full_name', 'aadhaar', 'address', 'mobile', 'diagnosis'],
    },
    mfaMandatory: false,
    sensitiveGrant: false,
    requiresCoSign: false,
  },
];

// ── validation at import time ────────────────────────────────────────────────
// A template referencing an unregistered key would produce a role that grants
// nothing while looking correct in the admin UI. Fail the process instead.
for (const t of templates) {
  for (const key of t.permissions) {
    assertRegisteredPermission(key, `role template "${t.key}" (docs/05 row ${t.docsRow})`);
  }
}

const rowNumbers = new Set(templates.map((t) => t.docsRow));
if (rowNumbers.size !== templates.length) {
  throw new Error('Two role templates claim the same docs/05 row number.');
}
if (templates.length !== 68) {
  throw new Error(
    `docs/05 defines 68 system role templates; the registry has ${templates.length}. ` +
      `Add the missing template or update docs/05 — the two must agree.`,
  );
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = Object.freeze(templates);

const templatesByKey = new Map(ROLE_TEMPLATES.map((t) => [t.key, t]));

export function getRoleTemplate(key: string): RoleTemplate | undefined {
  return templatesByKey.get(key);
}

export const ROLE_TEMPLATE_KEYS: readonly string[] = Object.freeze(ROLE_TEMPLATES.map((t) => t.key));

/** docs/04 §2 / EN-007 §3.4.2 — roles that cannot log in without MFA enrolled. */
export const MFA_MANDATORY_ROLE_KEYS: readonly string[] = Object.freeze(
  ROLE_TEMPLATES.filter((t) => t.mfaMandatory).map((t) => t.key),
);

/** EN-007 §5 / EN-025 §3.3.3 — roles a group claim may never grant on its own. */
export const SENSITIVE_ROLE_KEYS: readonly string[] = Object.freeze(
  ROLE_TEMPLATES.filter((t) => t.sensitiveGrant).map((t) => t.key),
);
