/**
 * Entitlement keys and the degradation ladder (EN-040).
 *
 * The single most important rule in this file, from `EN-040 §1`:
 *
 *   "commercial state may restrict *administrative and convenience* functions,
 *    but it must **never** block clinical care, patient safety functions, or a
 *    hospital's access to its own data."
 *
 * `EN-040 §14 AC-20` requires an automated test asserting every
 * `clinicalSafetyExempt` enforcement point stays exempt at every tier, and that
 * the build fails if one is not. That test reads `CLINICAL_SAFETY_EXEMPT_KEYS`
 * and `DEGRADATION_LADDER` from here.
 */

export type EntitlementKeyFamily = 'feature' | 'capacity' | 'quota';

/** How an entitlement failure is enforced (EN-040 §3.2). */
export type EnforcementGuard = 'route' | 'action' | 'quota' | 'seat' | 'device';

export interface EnforcementPoint {
  readonly key: string;
  readonly family: EntitlementKeyFamily;
  readonly guard: EnforcementGuard;
  readonly description: string;
  /**
   * `EN-040 §3.2`: "fail-safe by direction … the system **fails open for clinical
   * modules and fails closed for administrative/commercial features** — never the
   * reverse."
   */
  readonly failOpen: boolean;
  /** Never blocked by licence state, degradation tier or feature flag. */
  readonly clinicalSafetyExempt: boolean;
  /** Plain-language message a nurse can understand — never "SKU" or "entitlement". */
  readonly message: string;
  readonly upgradeCta?: string;
}

function ep(
  key: string,
  family: EntitlementKeyFamily,
  guard: EnforcementGuard,
  description: string,
  opts: { failOpen?: boolean; exempt?: boolean; message: string; upgradeCta?: string },
): EnforcementPoint {
  return {
    key,
    family,
    guard,
    description,
    failOpen: opts.failOpen ?? false,
    clinicalSafetyExempt: opts.exempt ?? false,
    message: opts.message,
    ...(opts.upgradeCta !== undefined ? { upgradeCta: opts.upgradeCta } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Module feature keys. One per module that can be licensed independently.
// Phase 0 registers the platform modules; later phases append theirs.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `CLAUDE.md §4`: "Feature flags (`packages/flags`) for every new module:
 * `module.<key>.enabled` per hospital (licence gating)."
 *
 * The platform modules below are marked exempt and fail-open because a hospital
 * whose subscription lapsed must still be able to authenticate its staff, audit
 * what they do, print a wristband and export its own records. Blocking any of
 * those would turn a billing dispute into a patient-safety event.
 */
export const ENFORCEMENT_POINTS: readonly EnforcementPoint[] = Object.freeze([
  // ── platform: always on, never gateable ────────────────────────────────────
  ep('module.admin.enabled', 'feature', 'route', 'EN-007 System Admin & RBAC — the control plane.', {
    exempt: true,
    failOpen: true,
    message: 'Administration is always available.',
  }),
  ep('module.audit.enabled', 'feature', 'route', 'EN-024 Audit Trail — cannot be disabled at all.', {
    exempt: true,
    failOpen: true,
    message: 'Audit logging is always active and cannot be turned off.',
  }),
  ep('module.mdm.enabled', 'feature', 'route', 'EN-027 Master Data Management.', {
    exempt: true,
    failOpen: true,
    message: 'Master data is always available.',
  }),
  ep('module.notifications.enabled', 'feature', 'route', 'EN-037 Notification Centre.', {
    exempt: true,
    failOpen: true,
    message: 'Notifications are always available.',
  }),
  ep('module.workflow.enabled', 'feature', 'route', 'EN-038 Workflow & Approval Engine.', {
    exempt: true,
    failOpen: true,
    message: 'Approvals are always available.',
  }),
  ep('module.forms.enabled', 'feature', 'route', 'EN-039 Forms & Template Builder.', {
    exempt: true,
    failOpen: true,
    message: 'Forms and documents are always available.',
  }),
  ep('module.licensing.enabled', 'feature', 'route', 'EN-040 — the flag authority itself.', {
    exempt: true,
    failOpen: true,
    message: 'Licensing is always available.',
  }),
  ep('module.multi_branch.enabled', 'feature', 'route', 'EN-041 Multi-branch / Group Architecture.', {
    message: 'Multiple branches are not included in your plan.',
    upgradeCta: 'Ask about Enterprise Group',
  }),
  ep('module.barcode.enabled', 'feature', 'route', 'EN-013 Barcode / QR — patient identification.', {
    exempt: true,
    failOpen: true,
    message: 'Patient identification is always available.',
  }),
  ep('module.print.enabled', 'feature', 'route', 'EN-005 Printer Integration.', {
    exempt: true,
    failOpen: true,
    message: 'Printing is always available.',
  }),
  ep('module.integration_hub.enabled', 'feature', 'route', 'EN-017 Integration Hub / ESB.', {
    message: 'Integrations are not included in your plan.',
    upgradeCta: 'Ask about Hospital Advanced',
  }),
  ep('module.sso.enabled', 'feature', 'route', 'EN-025 Single Sign-On.', {
    message: 'Single sign-on is not included in your plan.',
    upgradeCta: 'Ask about Hospital Advanced',
  }),
  ep('module.backup_dr.enabled', 'feature', 'route', 'EN-022 Backup & DR — backup jobs never stop.', {
    exempt: true,
    failOpen: true,
    message: 'Backups always run.',
  }),
  ep('module.security.enabled', 'feature', 'route', 'EN-023 Cybersecurity.', {
    exempt: true,
    failOpen: true,
    message: 'Security monitoring is always active.',
  }),
  ep('module.api_gateway.enabled', 'feature', 'route', 'EN-026 API Gateway — partner access.', {
    message: 'Partner API access is not included in your plan.',
    upgradeCta: 'Ask about Enterprise Group',
  }),
  ep('module.email.enabled', 'feature', 'route', 'EN-032 Email Integration.', {
    message: 'Email is not included in your plan.',
  }),

  // ── the export guarantee ───────────────────────────────────────────────────
  // EN-040 §5: "A hospital always owns and can export its data, in every state
  // including suspension and termination; export is never gated by payment."
  ep('feature.data_export.enabled', 'feature', 'action', 'The hospital’s right to export its own data.', {
    exempt: true,
    failOpen: true,
    message: 'You can always export your own data.',
  }),

  // ── capacity ───────────────────────────────────────────────────────────────
  ep('capacity.seats.clinical', 'capacity', 'seat', 'Named clinical user seats.', {
    message: 'The clinical seat limit has been reached.',
    upgradeCta: 'Add seats',
  }),
  ep('capacity.seats.front_office', 'capacity', 'seat', 'Named front-office seats.', {
    message: 'The front-office seat limit has been reached.',
    upgradeCta: 'Add seats',
  }),
  ep('capacity.seats.admin', 'capacity', 'seat', 'Named administrative seats.', {
    message: 'The administrative seat limit has been reached.',
    upgradeCta: 'Add seats',
  }),
  ep('capacity.seats.read_only', 'capacity', 'seat', 'Read-only seats (auditors, corporate clients).', {
    message: 'The read-only seat limit has been reached.',
    upgradeCta: 'Add seats',
  }),
  ep('capacity.concurrent_sessions', 'capacity', 'seat', 'Concurrent session ceiling.', {
    message: 'The concurrent-session limit has been reached.',
  }),
  ep('capacity.branches', 'capacity', 'action', 'Number of branches.', {
    message: 'Your plan does not allow another branch.',
    upgradeCta: 'Add a branch',
  }),
  ep('capacity.beds', 'capacity', 'action', 'Bed band.', {
    message: 'Your plan’s bed band has been exceeded.',
    upgradeCta: 'Move to the next bed band',
  }),
  ep('capacity.devices', 'capacity', 'device', 'Kiosks, TV boards, print agents and analyzers.', {
    message: 'Your plan’s device limit has been reached.',
    upgradeCta: 'Add devices',
  }),

  // ── quotas ─────────────────────────────────────────────────────────────────
  ep('quota.sms.monthly', 'quota', 'quota', 'SMS/WhatsApp units per month.', {
    message: 'The monthly messaging quota is used up.',
  }),
  ep('quota.email.monthly', 'quota', 'quota', 'Email volume per month.', {
    message: 'The monthly email quota is used up.',
  }),
  ep('quota.storage_gb', 'quota', 'quota', 'Document storage in gigabytes.', {
    message: 'The storage quota is used up.',
  }),
  ep('quota.api_calls.daily', 'quota', 'quota', 'Partner API calls per day (EN-026 tier).', {
    message: 'The daily API quota is used up.',
  }),
  ep('quota.import_rows.monthly', 'quota', 'quota', 'Data-import rows per month (EN-036).', {
    message: 'The monthly import quota is used up.',
  }),

  // ── clinical and operational modules, phases 1–4 ───────────────────────────
  //
  // The header above says "later phases append theirs". None did. Every key in
  // this file was a Phase-0 platform module, so `seedLicences` — which writes one
  // licence row per hospital for each `module.*` key — had nothing to write for
  // OPD, diagnostics, pharmacy or stores. A hospital could not enable those
  // modules because there was no row to enable, and screens declaring
  // `entitlement: 'module.lab.enabled'` named a key the catalogue did not define.
  //
  // None of these is `exempt`. Clinical *safety* is protected one level down: the
  // policy engine's `clinicalSafetyExempt` carve-out means an allergy hard stop,
  // a critical result or a recall trace is never blocked by licence state
  // whatever a hospital has paid for. Licensing gates a **module**, never a
  // safety behaviour inside one.
  ep('module.opd.enabled', 'feature', 'route', 'OP-001/OP-002 OPD registration and clinical core.', {
    message: 'Outpatient clinical records are not included in your plan.',
    upgradeCta: 'Ask about Hospital Clinical',
  }),
  ep('module.lab.enabled', 'feature', 'route', 'OP-004/EN-031 Laboratory information system.', {
    message: 'The laboratory module is not included in your plan.',
    upgradeCta: 'Ask about Hospital Diagnostics',
  }),
  ep('module.radiology.enabled', 'feature', 'route', 'OP-008/EN-008 Radiology, PACS and dose.', {
    message: 'The radiology module is not included in your plan.',
    upgradeCta: 'Ask about Hospital Diagnostics',
  }),
  ep('module.pharmacy.enabled', 'feature', 'route', 'OP-003 Pharmacy and dispensing.', {
    message: 'The pharmacy module is not included in your plan.',
    upgradeCta: 'Ask about Hospital Operations',
  }),
  ep('module.inventory.enabled', 'feature', 'route', 'NC-006/NC-005 Stores, purchase and supply chain.', {
    message: 'Stores and purchase are not included in your plan.',
    upgradeCta: 'Ask about Hospital Operations',
  }),

  // ── phases 1-8, added when the gap above recurred ──────────────────────────
  //
  // The comment on the block above describes this defect being fixed once, for
  // phases 1-4. It came back: by Phase 8 ten more keys were named by screens
  // (`entitlement: 'module.inpatient.enabled'` and friends) and defined
  // nowhere, so `seedLicences` wrote no row for them, no hospital could enable
  // them, and the field on the screen was documentation rather than a gate.
  //
  // `apps/web/src/lib/entitlements.spec.ts` now fails if any screen names a key
  // this list does not define, which is the part that was missing the first
  // time.
  ep(
    'module.appointments.enabled',
    'feature',
    'route',
    'OP-001/EN-006 Appointments, queue and token boards.',
    {
      message: 'Appointment scheduling is not included in your plan.',
      upgradeCta: 'Ask about Front Office',
    },
  ),
  ep(
    'module.cash_counter.enabled',
    'feature',
    'route',
    'NC-001/OP-005 Cash counter, receipts and day close.',
    {
      message: 'The cash counter is not included in your plan.',
      upgradeCta: 'Ask about Front Office',
    },
  ),
  ep('module.vitals_room.enabled', 'feature', 'route', 'OP-007 Vitals room and pre-consultation nursing.', {
    message: 'The vitals room is not included in your plan.',
    upgradeCta: 'Ask about Hospital Clinical',
  }),
  ep('module.opd_cpoe.enabled', 'feature', 'route', 'OP-002 Doctor console, e-prescribing and orders.', {
    message: 'The doctor console is not included in your plan.',
    upgradeCta: 'Ask about Hospital Clinical',
  }),
  ep('module.investigations.enabled', 'feature', 'route', 'OP-022 The investigation and report console.', {
    message: 'The investigation console is not included in your plan.',
    upgradeCta: 'Ask about Hospital Diagnostics',
  }),
  ep('module.rcm.enabled', 'feature', 'route', 'RC-002/RC-003/RC-006 Tariffs, claims and revenue cycle.', {
    message: 'Revenue cycle management is not included in your plan.',
    upgradeCta: 'Ask about Hospital Revenue',
  }),
  ep('module.emergency.enabled', 'feature', 'route', 'OP-006/TR-001 Emergency intake, triage and trauma.', {
    message: 'The emergency module is not included in your plan.',
    upgradeCta: 'Ask about Emergency & Trauma',
  }),
  ep(
    'module.ortho.enabled',
    'feature',
    'route',
    'OP-009/TR-002/TR-003 Orthopaedics, fractures and implants.',
    {
      message: 'The orthopaedic module is not included in your plan.',
      upgradeCta: 'Ask about Emergency & Trauma',
    },
  ),
  ep(
    'module.inpatient.enabled',
    'feature',
    'route',
    'IP-001 to IP-018 Beds, wards, theatre, ICU and discharge.',
    {
      message: 'The inpatient module is not included in your plan.',
      upgradeCta: 'Ask about Hospital Inpatient',
    },
  ),

  // ── Phase 8 specialty consoles ────────────────────────────────────────────
  //
  // One key per console, because `phase-08` gate 11 requires each to be
  // switchable on its own: "Every console is toggled off: no nav item, no
  // route, no search result … Toggle one back on and it works without a
  // restart." A shared `module.specialty.enabled` would make that impossible to
  // satisfy for one console at a time.
  ep('module.ophthalmology.enabled', 'feature', 'route', 'OP-025 The ophthalmology console.', {
    message: 'The ophthalmology console is not included in your plan.',
    upgradeCta: 'Ask about Specialty Consoles',
  }),
  ep('module.cardiology.enabled', 'feature', 'route', 'OP-029 The cardiology console.', {
    message: 'The cardiology console is not included in your plan.',
    upgradeCta: 'Ask about Specialty Consoles',
  }),
  ep('module.pulmonology.enabled', 'feature', 'route', 'OP-030 The pulmonology console.', {
    message: 'The pulmonology console is not included in your plan.',
    upgradeCta: 'Ask about Specialty Consoles',
  }),
  ep('module.ent.enabled', 'feature', 'route', 'OP-028 The ENT and audiology console.', {
    message: 'The ENT and audiology console is not included in your plan.',
    upgradeCta: 'Ask about Specialty Consoles',
  }),
  ep('module.dental.enabled', 'feature', 'route', 'OP-026 The dental console.', {
    message: 'The dental console is not included in your plan.',
    upgradeCta: 'Ask about Specialty Consoles',
  }),
  ep('module.dermatology.enabled', 'feature', 'route', 'OP-027 The dermatology console.', {
    message: 'The dermatology console is not included in your plan.',
    upgradeCta: 'Ask about Specialty Consoles',
  }),
  ep(
    'module.therapy.enabled',
    'feature',
    'route',
    'OP-015 Physiotherapy, rehabilitation and the shared therapy spine.',
    {
      message: 'The therapy console is not included in your plan.',
      upgradeCta: 'Ask about Specialty Consoles',
    },
  ),
  ep('module.wound_care.enabled', 'feature', 'route', 'OP-017 The wound care clinic.', {
    message: 'The wound care clinic is not included in your plan.',
    upgradeCta: 'Ask about Specialty Consoles',
  }),
  ep('module.nutrition.enabled', 'feature', 'route', 'OP-011 Dietetics and nutrition.', {
    message: 'The dietetics console is not included in your plan.',
    upgradeCta: 'Ask about Specialty Consoles',
  }),
  // OP-035's swallow order is the one console screen that is never licence
  // gated: an IDDSI recommendation the ward cannot read is a patient eating
  // the wrong texture, and EN-040 §5 does not let billing state cause that.
  ep('module.speech_therapy.enabled', 'feature', 'route', 'OP-035 Speech, language and swallow.', {
    message: 'The speech therapy console is not included in your plan.',
    upgradeCta: 'Ask about Specialty Consoles',
  }),
  ep(
    'module.procedures.enabled',
    'feature',
    'route',
    'OP-010/OP-039 The procedure console, minor OT and the OPD nursing rooms.',
    {
      message: 'The procedure and OPD nursing rooms are not included in your plan.',
      upgradeCta: 'Ask about Hospital Clinical',
    },
  ),
]);

const pointsByKey = new Map(ENFORCEMENT_POINTS.map((e) => [e.key, e]));

if (pointsByKey.size !== ENFORCEMENT_POINTS.length) {
  throw new Error('Duplicate entitlement keys in ENFORCEMENT_POINTS.');
}

export function getEnforcementPoint(key: string): EnforcementPoint | undefined {
  return pointsByKey.get(key);
}

export const ENTITLEMENT_KEYS: readonly string[] = Object.freeze(ENFORCEMENT_POINTS.map((e) => e.key));

/** The exempt set the safety suite asserts at every degradation tier. */
export const CLINICAL_SAFETY_EXEMPT_KEYS: readonly string[] = Object.freeze(
  ENFORCEMENT_POINTS.filter((e) => e.clinicalSafetyExempt).map((e) => e.key),
);

// ─────────────────────────────────────────────────────────────────────────────
// The degradation ladder (EN-040 §3.5)
// ─────────────────────────────────────────────────────────────────────────────

export type DegradationTier = 0 | 1 | 2 | 3 | 4;

export type SubscriptionStatus =
  | 'trial'
  | 'active'
  | 'grace'
  | 'soft_degraded'
  | 'hard_degraded'
  | 'suspended'
  | 'terminated'
  | 'billing_hold';

export interface DegradationTierSpec {
  readonly tier: DegradationTier;
  readonly status: SubscriptionStatus;
  readonly label: string;
  /** Plain-language description shown on the customer-facing preview screen. */
  readonly stillWorks: string;
  readonly restricted: string;
  /**
   * Capability families restricted at this tier. Anything in
   * `CLINICAL_SAFETY_EXEMPT_KEYS` is unaffected regardless of what is listed here.
   */
  readonly restrictedCapabilities: readonly string[];
}

export const DEGRADATION_LADDER: readonly DegradationTierSpec[] = Object.freeze([
  {
    tier: 0,
    status: 'active',
    label: 'Active',
    stillWorks: 'Everything.',
    restricted: 'Nothing.',
    restrictedCapabilities: [],
  },
  {
    tier: 1,
    status: 'grace',
    label: 'Grace period',
    stillWorks: 'Everything. A banner shows the renewal date and the exact date restrictions would begin.',
    restricted: 'Adding a new branch or new seats.',
    restrictedCapabilities: [
      'capacity.branches',
      'capacity.seats.clinical',
      'capacity.seats.front_office',
      'capacity.seats.admin',
      'capacity.seats.read_only',
    ],
  },
  {
    tier: 2,
    status: 'soft_degraded',
    label: 'Soft-degraded',
    stillWorks:
      'All clinical work: registration, triage, orders, prescribing, results, medication administration, vitals, ' +
      'safety alerts, discharge, emergency and theatre, dispensing, lab reporting — and billing and receipts, ' +
      'because a hospital must be able to treat patients and collect money.',
    restricted:
      'Analytics and BI dashboards, the report builder, bulk exports of non-clinical data, marketing campaigns, ' +
      'authoring new templates and rules, non-clinical integrations, new mobile-app logins, partner API access.',
    restrictedCapabilities: [
      'module.api_gateway.enabled',
      'module.integration_hub.enabled',
      'module.email.enabled',
    ],
  },
  {
    tier: 3,
    status: 'hard_degraded',
    label: 'Hard-degraded',
    stillWorks:
      'Clinical read plus emergency write — register an emergency patient, place orders, record vitals, dispense, ' +
      'produce a discharge summary — and full data export.',
    restricted:
      'Routine scheduling, new elective registrations, non-clinical modules (HR, procurement, accounts), ' +
      'all administrative configuration.',
    restrictedCapabilities: [
      'module.api_gateway.enabled',
      'module.integration_hub.enabled',
      'module.email.enabled',
      'module.sso.enabled',
      'module.multi_branch.enabled',
    ],
  },
  {
    tier: 4,
    status: 'suspended',
    label: 'Suspended',
    stillWorks:
      'Data export, through a time-boxed administrator session. A notice explains how to retrieve data.',
    restricted: 'Interactive use.',
    restrictedCapabilities: [
      'module.api_gateway.enabled',
      'module.integration_hub.enabled',
      'module.email.enabled',
      'module.sso.enabled',
      'module.multi_branch.enabled',
    ],
  },
]);

/**
 * `EN-040 §3.5`: "**Never degraded at any tier**: allergy and interaction alerts,
 * critical-value alerts and escalation (EN-029/EN-037), MAR safety checks,
 * blood-bank cross-match, emergency/ER and OT modules, audit logging, backup jobs
 * (EN-022), and the ability to export the hospital's own data."
 *
 * Listed as capability names rather than permission keys because most of these
 * modules do not exist yet — the list is the *contract* that later phases must
 * satisfy, and the safety test asserts each name resolves to at least one exempt
 * enforcement point or permission once its phase lands.
 */
export const NEVER_DEGRADED_CAPABILITIES: readonly string[] = Object.freeze([
  'allergy_alerts',
  'interaction_alerts',
  'critical_value_alerts',
  'critical_alert_escalation',
  'mar_safety_checks',
  'blood_crossmatch',
  'emergency_department',
  'operation_theatre',
  'audit_logging',
  'backup_jobs',
  'data_export',
  'patient_identification',
]);

/**
 * `EN-040 §3.3.4`: "**Emergency headroom**: a configurable overflow (default
 * +10 % or 5 sessions, whichever is greater) is always available for clinical
 * roles so a mass-casualty surge cannot be locked out by a seat limit."
 */
export function emergencyHeadroom(limit: number): number {
  return Math.max(5, Math.ceil(limit * 0.1));
}

export interface EntitlementCheckResult {
  readonly allowed: boolean;
  readonly reason: string;
  readonly limit: number | null;
  readonly used: number | null;
  readonly remaining: number | null;
  readonly degradeMode: DegradationTier;
  readonly expiresAt: string | null;
  /** True when the answer came from a cached, signed document rather than live. */
  readonly fromCache: boolean;
  /** True when the answer is the fail-open default because nothing was reachable. */
  readonly failedOpen: boolean;
}

/**
 * `EN-040 §3.2`: the cached entitlement document stays valid offline for up to
 * 72 hours before the fail-open/fail-closed split applies.
 */
export const ENTITLEMENT_CACHE_MAX_AGE_SECONDS = 72 * 60 * 60;

/** `EN-040 §7`: every service must reflect an entitlement change within 30 s. */
export const ENTITLEMENT_PROPAGATION_SLA_SECONDS = 30;
