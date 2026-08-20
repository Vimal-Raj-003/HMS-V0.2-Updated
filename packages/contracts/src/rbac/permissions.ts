/**
 * The permission catalogue — the authoritative registry of every RBAC key.
 *
 * `docs/05 §Permission catalogue conventions`: key = `<module>.<resource>.<action>`.
 * `EN-007 §3.3.1`: "Permissions registered in code (`packages/contracts/permissions.ts`:
 *  key, module, resource, action, description, data_class PHI/financial/HR/operational,
 *  risk level, default roles) → synced to `core.permissions` at boot (new keys flagged
 *  'unassigned' in Admin UI); modules cannot use unregistered keys (lint + runtime check)."
 * `docs/04 §3`: "Every endpoint declares a permission key; CI fails on any route without one."
 *
 * Only Phase 0 modules are registered here. Each later phase appends its own keys;
 * the boot-time sync marks keys present in the database but absent from code as
 * `deprecated` rather than deleting them, so a historical audit row's
 * `actor_role`/permission reference always resolves.
 */

/** docs/05: the sanctioned action vocabulary, extended by what the specs actually use. */
export type PermissionAction =
  | 'read'
  | 'list'
  | 'create'
  | 'update'
  | 'delete'
  | 'cancel'
  | 'approve'
  | 'reject'
  | 'validate'
  | 'sign'
  | 'dispense'
  | 'issue'
  | 'export'
  | 'print'
  | 'reprint'
  | 'configure'
  | 'override'
  | 'manage'
  | 'assign'
  | 'request'
  | 'review'
  | 'publish'
  | 'propose'
  | 'run'
  | 'install'
  | 'revoke'
  | 'retry'
  | 'replay'
  | 'dispatch'
  | 'verify'
  | 'scan'
  | 'decide'
  | 'bypass'
  | 'reset'
  | 'impersonate'
  | 'notify'
  | 'act'
  | 'locate'
  | 'onboard'
  | 'pay'
  | 'send'
  | 'capture'
  | 'withdraw'
  | 'call'
  | 'join'
  | 'activate'
  | 'clear'
  | 'announce'
  | 'reconcile'
  | 'fleet'
  | 'admin';

/** docs/05 §Model: "Data classes: PHI, financial, HR, operational." */
export type DataClass = 'phi' | 'financial' | 'hr' | 'operational' | 'security' | 'commercial';

/**
 * Risk drives the UI treatment, whether MFA/step-up is demanded, and whether the
 * grant itself needs dual approval (EN-007 §5).
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface PermissionDefinition {
  readonly key: string;
  /** Owning module ID from docs/12-module-index.md. */
  readonly module: string;
  readonly resource: string;
  readonly action: PermissionAction;
  readonly description: string;
  readonly dataClass: DataClass;
  readonly risk: RiskLevel;
  /** Build phase that introduces the key (CLAUDE.md §6). */
  readonly phase: number;
  /** Granting this role requires two approvers and MFA on the grantee (EN-007 §5). */
  readonly sensitiveGrant?: boolean;
  /** Exercising it needs a second authenticated person (docs/05 §ABAC `requires_second_person`). */
  readonly requiresSecondPerson?: boolean;
  /** Reason capture is mandatory (EN-024 §5). */
  readonly requiresReason?: boolean;
  /** Fresh strong auth required at the moment of use (EN-025 §3.6). */
  readonly requiresStepUp?: boolean;
  /** Use writes a `READ_PHI` audit row (EN-024 §3.2). */
  readonly phiRead?: boolean;
  /**
   * `EN-040 §5`: "Clinical safety is never gated." A key marked here can never be
   * blocked by licence state, degradation tier or feature flag. An automated test
   * asserts the exempt set at every tier — a regression is a patient-safety bug.
   */
  readonly clinicalSafetyExempt?: boolean;
  readonly deprecated?: boolean;
}

type Def = Omit<PermissionDefinition, 'module' | 'phase'>;

function group(module: string, phase: number, defs: readonly Def[]): PermissionDefinition[] {
  return defs.map((d) => ({ ...d, module, phase }));
}

/** Terse constructor so the catalogue reads as data rather than boilerplate. */
function p(
  key: string,
  resource: string,
  action: PermissionAction,
  dataClass: DataClass,
  risk: RiskLevel,
  description: string,
  extra: Partial<Def> = {},
): Def {
  return { key, resource, action, dataClass, risk, description, ...extra };
}

// ─────────────────────────────────────────────────────────────────────────────
// EN-007 — System Admin & RBAC
// ─────────────────────────────────────────────────────────────────────────────
const EN007 = group('EN-007', 0, [
  p(
    'admin.hospital.configure',
    'hospital',
    'configure',
    'operational',
    'high',
    'Create and configure hospitals, branches, legal identity, tax and branding.',
    { sensitiveGrant: true },
  ),
  p(
    'admin.settings.read',
    'settings',
    'read',
    'operational',
    'low',
    'View hospital, branch and department settings.',
  ),
  p(
    'admin.settings.configure',
    'settings',
    'configure',
    'operational',
    'high',
    'Change settings. Sensitive keys (payment/SMS credentials) additionally require step-up.',
    { requiresStepUp: true },
  ),
  p(
    'admin.calendar.configure',
    'calendar',
    'configure',
    'operational',
    'medium',
    'Maintain working hours, shift definitions and the holiday calendar.',
  ),
  p(
    'admin.numbering.configure',
    'numbering_series',
    'configure',
    'operational',
    'high',
    'Define numbering series patterns and trigger financial-year rollover.',
    { requiresReason: true },
  ),
  p('admin.user.read', 'user', 'read', 'hr', 'medium', 'View user accounts and their role assignments.'),
  p('admin.user.create', 'user', 'create', 'hr', 'high', 'Create and invite user accounts.'),
  p(
    'admin.user.update',
    'user',
    'update',
    'hr',
    'high',
    'Edit user identity, professional details and preferences.',
  ),
  p(
    'admin.user.deactivate',
    'user',
    'delete',
    'hr',
    'high',
    'Deactivate a user; revokes sessions immediately. Users are never hard-deleted.',
    { requiresReason: true },
  ),
  p(
    'admin.user.reset',
    'user',
    'reset',
    'security',
    'high',
    'Reset a password, unlock an account, revoke MFA or force logout.',
    { requiresReason: true },
  ),
  p(
    'admin.role.read',
    'role',
    'read',
    'security',
    'low',
    'View roles, the permission tree and the role matrix.',
  ),
  p(
    'admin.role.configure',
    'role',
    'configure',
    'security',
    'critical',
    'Create and edit roles and their permission sets.',
    { sensitiveGrant: true, requiresStepUp: true },
  ),
  p(
    'admin.role.assign',
    'role',
    'assign',
    'security',
    'critical',
    'Assign or revoke a role for a user. Sensitive roles need dual approval.',
    { sensitiveGrant: true, requiresStepUp: true, requiresReason: true },
  ),
  p(
    'admin.access.request',
    'access_request',
    'request',
    'operational',
    'low',
    'Request a role or scope for yourself or a team member.',
  ),
  p(
    'admin.access.approve',
    'access_request',
    'approve',
    'security',
    'high',
    'Approve or reject an access request.',
    { requiresReason: true },
  ),
  p(
    'admin.access.review',
    'access_review',
    'review',
    'security',
    'medium',
    'Run and attest periodic access-review campaigns.',
  ),
  p(
    'admin.security.configure',
    'auth_policy',
    'configure',
    'security',
    'critical',
    'Change password, MFA, session, OTP and SSO policy. Dual control.',
    { sensitiveGrant: true, requiresStepUp: true },
  ),
  p(
    'admin.session.manage',
    'session',
    'manage',
    'security',
    'high',
    'View and revoke sessions, including branch-wide force logout.',
    { requiresReason: true },
  ),
  p(
    'admin.device.manage',
    'device',
    'manage',
    'security',
    'medium',
    'Pair and revoke kiosk, TV, print-agent and workstation device tokens.',
  ),
  p(
    'admin.audit.read',
    'audit',
    'read',
    'phi',
    'medium',
    'Search the audit trail. Viewing PHI-bearing entries is itself audited.',
    { phiRead: true },
  ),
  p(
    'admin.audit.export',
    'audit',
    'export',
    'phi',
    'high',
    'Export audit data. Always audited; purpose required.',
    { requiresReason: true, requiresStepUp: true, phiRead: true },
  ),
  p(
    'admin.flags.configure',
    'feature_flag',
    'configure',
    'operational',
    'high',
    'Enable or disable feature flags within the licence.',
  ),
  p('admin.licence.read', 'licence', 'read', 'commercial', 'low', 'View plan, seats, quotas and expiry.'),
  p(
    'admin.impersonate',
    'impersonation',
    'impersonate',
    'security',
    'critical',
    'Act as another user for support. Read-only by default, time-boxed, both identities audited.',
    { sensitiveGrant: true, requiresStepUp: true, requiresReason: true, phiRead: true },
  ),
  p(
    'admin.status.read',
    'status',
    'read',
    'operational',
    'low',
    'View backup, security and integration status panels.',
  ),
  p('admin.report.read', 'report', 'read', 'operational', 'low', 'Run administrative reports.'),
]);

// ─────────────────────────────────────────────────────────────────────────────
// EN-024 — Audit Trail & Logging.  No role may ever update or delete an audit
// entry: EN-024 §12 states "the permission does not exist", so none is defined.
// ─────────────────────────────────────────────────────────────────────────────
const EN024 = group('EN-024', 0, [
  p('audit.read', 'audit_log', 'read', 'phi', 'medium', 'Search audit entries and view field-level diffs.', {
    phiRead: true,
  }),
  p(
    'audit.patient.read',
    'audit_log',
    'read',
    'phi',
    'high',
    'View everyone who touched a given patient record.',
    { phiRead: true },
  ),
  p('audit.user.read', 'audit_log', 'read', 'hr', 'medium', "View a user's activity history."),
  p(
    'audit.breakglass.review',
    'break_glass',
    'review',
    'phi',
    'high',
    'Review break-glass accesses as justified, not justified or needing explanation.',
    { requiresReason: true },
  ),
  p(
    'audit.case.manage',
    'audit_case',
    'manage',
    'phi',
    'high',
    'Open and manage privacy investigation cases.',
  ),
  p(
    'audit.export',
    'audit_export',
    'export',
    'phi',
    'critical',
    'Produce an evidence export. Purpose mandatory; court/regulator exports need approval.',
    { requiresReason: true, requiresStepUp: true, phiRead: true },
  ),
  p(
    'audit.integrity.run',
    'audit_integrity',
    'run',
    'security',
    'medium',
    'Run on-demand hash-chain verification over a date range.',
  ),
  p(
    'audit.retention.configure',
    'audit_retention',
    'configure',
    'security',
    'critical',
    'Change retention policy. Statutory floors are enforced in code and cannot be lowered.',
    { sensitiveGrant: true, requiresStepUp: true },
  ),
  p(
    'audit.archive.manage',
    'audit_archive',
    'manage',
    'security',
    'high',
    'Archive and restore audit partitions. Every restore is audited.',
    { requiresReason: true },
  ),
  p(
    'audit.config.manage',
    'audit_config',
    'manage',
    'security',
    'critical',
    'Change diff-masking and reason-enforcement policy. Dual control.',
    { sensitiveGrant: true },
  ),
  p(
    'audit.shipping.manage',
    'audit_shipping',
    'manage',
    'security',
    'high',
    'Configure SIEM/log shipping. PHI redaction is validated before saving.',
  ),
  p(
    'audit.report.read',
    'audit_report',
    'read',
    'operational',
    'medium',
    'Run statutory audit reports (NABH pack, PHI access, config changes).',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// EN-027 — Master Data Management
// ─────────────────────────────────────────────────────────────────────────────
const MDM_DOMAINS = [
  'pharmacy',
  'lab',
  'service',
  'org',
  'inventory',
  'payer',
  'finance',
  'radiology',
  'clinical',
] as const;

const EN027 = group('EN-027', 0, [
  p(
    'mdm.read',
    'master',
    'read',
    'operational',
    'low',
    'Read any master for pickers and lookups. Granted to all staff.',
  ),
  ...MDM_DOMAINS.map((d) =>
    p(
      `mdm.${d}.propose`,
      `master_${d}`,
      'propose',
      'operational',
      'medium',
      `Propose changes to ${d} masters as a change set.`,
    ),
  ),
  ...MDM_DOMAINS.map((d) =>
    p(
      `mdm.${d}.approve`,
      `master_${d}`,
      'approve',
      'operational',
      'high',
      `Approve ${d} master change sets. Proposer may never approve.`,
      { requiresReason: true },
    ),
  ),
  p(
    'mdm.terminology.manage',
    'code_system',
    'manage',
    'operational',
    'high',
    'Load and activate ICD/SNOMED/LOINC releases after reviewing the delta report.',
  ),
  p('mdm.valueset.manage', 'value_set', 'manage', 'operational', 'medium', 'Author and version value sets.'),
  p(
    'mdm.map.manage',
    'concept_map',
    'manage',
    'operational',
    'medium',
    'Maintain concept maps and work the unmapped-code backlog.',
  ),
  p(
    'mdm.merge',
    'master',
    'manage',
    'operational',
    'high',
    'Merge duplicate master records into a golden record. Unmerge available for 30 days.',
    { requiresReason: true },
  ),
  p(
    'mdm.sync.manage',
    'master_sync',
    'manage',
    'operational',
    'high',
    'Publish group master changes to branches and review the override register.',
  ),
  p(
    'mdm.quality.read',
    'master_quality',
    'read',
    'operational',
    'low',
    'View the master-data health scorecard.',
  ),
  p(
    'mdm.review.manage',
    'master_review',
    'manage',
    'operational',
    'medium',
    'Run annual stewardship review campaigns.',
  ),
  p('mdm.report.read', 'master_report', 'read', 'operational', 'low', 'Run master-data reports.'),
  p(
    'mdm.emergency_change',
    'master',
    'override',
    'operational',
    'critical',
    'Fast-track a correction to a live master (e.g. a wrong drug strength) with post-hoc review.',
    { sensitiveGrant: true, requiresReason: true, clinicalSafetyExempt: true },
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// EN-037 — Notification Centre
// ─────────────────────────────────────────────────────────────────────────────
const EN037 = group('EN-037', 0, [
  p(
    'notify.publish',
    'notification',
    'dispatch',
    'operational',
    'medium',
    'Raise a notification. Service accounts and modules only.',
    { clinicalSafetyExempt: true },
  ),
  p(
    'notify.type.manage',
    'notification_type',
    'manage',
    'operational',
    'high',
    'Create and edit notification types. Clinical types need Medical Superintendent co-approval.',
  ),
  p(
    'notify.policy.manage',
    'escalation_ladder',
    'manage',
    'operational',
    'high',
    'Configure escalation ladders, routing rules and severity.',
    { clinicalSafetyExempt: true },
  ),
  p(
    'notify.admin.read',
    'notification',
    'read',
    'phi',
    'medium',
    "Search other users' notifications. Audited as a PHI access.",
    { phiRead: true },
  ),
  p(
    'notify.admin.manage',
    'notification',
    'cancel',
    'operational',
    'high',
    'Cancel or resolve an in-flight escalation.',
    { requiresReason: true },
  ),
  p(
    'notify.escalation.read',
    'escalation',
    'read',
    'operational',
    'medium',
    'View the live escalation board.',
    { clinicalSafetyExempt: true },
  ),
  p(
    'notify.report.read',
    'notification_report',
    'read',
    'operational',
    'low',
    'View delivery, responsiveness and alert-fatigue reports.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// EN-038 — Workflow & Approval Engine
// ─────────────────────────────────────────────────────────────────────────────
const EN038 = group('EN-038', 0, [
  p(
    'wf.request.create',
    'wf_request',
    'create',
    'operational',
    'low',
    'Raise an approval request and preview its approver chain.',
  ),
  p(
    'wf.request.read',
    'wf_request',
    'read',
    'operational',
    'low',
    'Read approval requests. Own requests always; wider scope by role.',
  ),
  p(
    'wf.decide',
    'wf_request',
    'decide',
    'operational',
    'high',
    'Approve, reject, modify or reassign a request you are a resolved approver for.',
    { requiresReason: true },
  ),
  p(
    'wf.decide.bulk',
    'wf_request',
    'decide',
    'operational',
    'high',
    'Decide several homogeneous requests at once (hard cap 50).',
    { requiresReason: true },
  ),
  p(
    'wf.bypass',
    'wf_request',
    'bypass',
    'operational',
    'critical',
    'Emergency bypass of an approval. Notifies the whole chain and requires ratification within 24 h.',
    { sensitiveGrant: true, requiresReason: true, clinicalSafetyExempt: true },
  ),
  p(
    'wf.process.manage',
    'wf_process',
    'manage',
    'operational',
    'high',
    'Define approval processes and their context schemas.',
  ),
  p('wf.matrix.manage', 'wf_matrix', 'manage', 'operational', 'high', 'Author approval matrices as drafts.'),
  p(
    'wf.matrix.publish',
    'wf_matrix',
    'publish',
    'operational',
    'critical',
    'Publish a matrix version. Financial matrices require an attached simulation run.',
    { sensitiveGrant: true, requiresStepUp: true },
  ),
  p(
    'wf.delegation.manage',
    'wf_delegation',
    'manage',
    'operational',
    'medium',
    'Set your own out-of-office and delegate.',
  ),
  p(
    'wf.delegation.admin',
    'wf_delegation',
    'manage',
    'operational',
    'high',
    "Reassign a departed approver's pending queue.",
    { requiresReason: true },
  ),
  p(
    'wf.calendar.manage',
    'wf_calendar',
    'manage',
    'operational',
    'medium',
    'Maintain business calendars and recorded downtime windows used for SLA maths.',
  ),
  p(
    'wf.report.read',
    'wf_report',
    'read',
    'operational',
    'low',
    'View turnaround, SLA, approver-load and bypass reports.',
  ),
  p(
    'wf.audit.read',
    'wf_request',
    'read',
    'operational',
    'medium',
    'Open the full per-request evidence pack.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// EN-039 — Forms & Template Builder
// ─────────────────────────────────────────────────────────────────────────────
const EN039 = group('EN-039', 0, [
  p(
    'tpl.form.read',
    'form_template',
    'read',
    'operational',
    'low',
    'Read form templates for rendering. All clinical and administrative roles.',
    { clinicalSafetyExempt: true },
  ),
  p(
    'tpl.form.manage',
    'form_template',
    'manage',
    'operational',
    'medium',
    'Author form templates and versions with migration rules.',
  ),
  p(
    'tpl.form.publish',
    'form_template',
    'publish',
    'operational',
    'high',
    'Publish a form template version. Clinical templates need Medical Superintendent sign-off.',
    { requiresStepUp: true },
  ),
  p(
    'tpl.response.write',
    'form_response',
    'create',
    'phi',
    'medium',
    'Save a form response. Role-gated per template definition.',
    { clinicalSafetyExempt: true },
  ),
  p(
    'tpl.response.read',
    'form_response',
    'read',
    'phi',
    'medium',
    'Read a saved form response, rendered against the template version it was filled on.',
    { phiRead: true, clinicalSafetyExempt: true },
  ),
  p(
    'tpl.response.amend',
    'form_response',
    'update',
    'phi',
    'high',
    'Amend a finalised response — creates a new version with a mandatory reason.',
    { requiresReason: true },
  ),
  p(
    'tpl.response.sign',
    'form_response',
    'sign',
    'phi',
    'high',
    'Sign a clinical document, making it immutable and hash-chained.',
    { requiresStepUp: true },
  ),
  p(
    'tpl.print.manage',
    'print_template',
    'manage',
    'operational',
    'medium',
    'Author print, label and thermal templates.',
  ),
  p(
    'tpl.print.publish',
    'print_template',
    'publish',
    'operational',
    'high',
    'Publish a print template version.',
  ),
  p(
    'tpl.render',
    'document',
    'create',
    'phi',
    'medium',
    'Render a document. Every PHI-bearing render is audited.',
    { clinicalSafetyExempt: true },
  ),
  p(
    'tpl.reprint.override',
    'document',
    'reprint',
    'financial',
    'high',
    'Reprint an original without the COPY watermark. Audited.',
    { requiresReason: true },
  ),
  p(
    'tpl.branding.manage',
    'branding',
    'manage',
    'operational',
    'medium',
    'Manage letterhead and branch identity assets.',
  ),
  p(
    'tpl.translation.manage',
    'translation',
    'manage',
    'operational',
    'low',
    'Manage template translations and the completeness meter.',
  ),
  p(
    'tpl.bundle.manage',
    'template_bundle',
    'manage',
    'operational',
    'medium',
    'Export and import signed template bundles between branches or tenants.',
  ),
  p(
    'tpl.governance.read',
    'template_governance',
    'read',
    'operational',
    'low',
    'View the controlled-document register and review-due list.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// EN-040 — Licence & Subscription Management
// ─────────────────────────────────────────────────────────────────────────────
const EN040 = group('EN-040', 0, [
  p(
    'lic.entitlement.read',
    'entitlement',
    'read',
    'commercial',
    'low',
    'Read the current entitlement document. Called by every service.',
    { clinicalSafetyExempt: true },
  ),
  p(
    'lic.subscription.read',
    'subscription',
    'read',
    'commercial',
    'low',
    'View plan, status, expiry and degradation tier.',
  ),
  p('lic.subscription.request', 'subscription', 'request', 'commercial', 'low', 'Request a plan upgrade.'),
  p('lic.usage.read', 'usage', 'read', 'commercial', 'low', 'View usage against entitlement.'),
  p('lic.invoice.read', 'invoice', 'read', 'financial', 'low', 'View and download SaaS invoices.'),
  p('lic.invoice.pay', 'invoice', 'pay', 'financial', 'medium', 'Pay an invoice via a payment link.'),
  p(
    'lic.key.install',
    'licence_key',
    'install',
    'commercial',
    'high',
    'Install or renew an on-prem licence key. Validated fully offline.',
  ),
  // Operator-only keys. Present in every tenant's catalogue so the audit log can
  // resolve them, but granted only to the SaaS operator's roles.
  p('lic.plan.manage', 'plan', 'manage', 'commercial', 'high', 'Operator: define plans and versions.'),
  p(
    'lic.subscription.manage',
    'subscription',
    'manage',
    'commercial',
    'critical',
    'Operator: change a tenant subscription, suspend or restore. Reason mandatory and visible to the tenant.',
    { sensitiveGrant: true, requiresReason: true },
  ),
  p(
    'lic.override.manage',
    'entitlement_override',
    'manage',
    'commercial',
    'critical',
    'Operator: add a per-customer entitlement override with an expiry.',
    { sensitiveGrant: true, requiresReason: true },
  ),
  p(
    'lic.billing.manage',
    'billing_run',
    'manage',
    'financial',
    'high',
    'Operator: close a period, issue, void or credit-note invoices.',
  ),
  p(
    'lic.key.issue',
    'licence_key',
    'issue',
    'commercial',
    'critical',
    'Operator: sign an on-prem licence key with the HSM-held Ed25519 key.',
    { sensitiveGrant: true, requiresStepUp: true },
  ),
  p('lic.usage.admin', 'usage', 'admin', 'commercial', 'medium', 'Operator: cross-tenant usage view.'),
  p(
    'lic.report.admin',
    'licence_report',
    'admin',
    'commercial',
    'medium',
    'Operator: MRR, churn and usage-vs-plan analytics.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// EN-041 — Multi-branch / Group Architecture
// ─────────────────────────────────────────────────────────────────────────────
const EN041 = group('EN-041', 0, [
  p('org.read', 'org', 'read', 'operational', 'low', 'Read your own group/hospital/branch hierarchy.'),
  p(
    'org.branch.manage',
    'branch',
    'manage',
    'operational',
    'high',
    'Create, suspend and close branches. A live branch is never deleted.',
    { requiresReason: true },
  ),
  p(
    'org.branch.onboard',
    'branch',
    'onboard',
    'operational',
    'high',
    'Run the branch onboarding wizard and the go-live smoke test.',
  ),
  p(
    'org.registration.manage',
    'branch_registration',
    'manage',
    'operational',
    'medium',
    'Maintain per-branch licences and accreditations with expiry tracking.',
  ),
  p(
    'org.policy.manage',
    'data_domain',
    'manage',
    'security',
    'critical',
    'Change data-sharing domains and residency policy. Group Admin + DPO dual control.',
    { sensitiveGrant: true, requiresStepUp: true },
  ),
  p(
    'org.master.override',
    'master_override',
    'override',
    'operational',
    'medium',
    'Create a branch override of a group master attribute.',
    { requiresReason: true },
  ),
  p(
    'org.access.manage',
    'branch_access',
    'manage',
    'security',
    'high',
    'Grant or revoke a user’s branch access and per-branch roles.',
    { requiresReason: true },
  ),
  p(
    'org.patient.locate',
    'patient_branch_link',
    'locate',
    'phi',
    'low',
    'See which branches hold a patient’s records — existence only, no clinical content.',
  ),
  p(
    'org.patient.cross_access',
    'patient',
    'read',
    'phi',
    'high',
    'Open a patient record held at another branch. Logged as a cross-branch PHI read.',
    { phiRead: true, requiresReason: true, clinicalSafetyExempt: true },
  ),
  p(
    'org.patient.break_glass',
    'patient',
    'override',
    'phi',
    'critical',
    'Emergency cross-branch access without consent. Granted immediately, notified and reviewed.',
    { phiRead: true, requiresReason: true, clinicalSafetyExempt: true },
  ),
  p(
    'org.transfer.manage',
    'org_transfer',
    'manage',
    'operational',
    'high',
    'Initiate and accept inter-branch patient, stock, asset or sample transfers.',
  ),
  p(
    'org.finance.read',
    'org_settlement',
    'read',
    'financial',
    'medium',
    'View inter-branch settlements and elimination status.',
  ),
  p(
    'org.report.read',
    'org_report',
    'read',
    'operational',
    'medium',
    'View the group scorecard and branch comparison.',
  ),
  p(
    'org.audit.read',
    'cross_branch_access_log',
    'read',
    'phi',
    'high',
    'Read the cross-branch disclosure log.',
    { phiRead: true },
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// EN-025 — Single Sign-On
// ─────────────────────────────────────────────────────────────────────────────
const EN025 = group('EN-025', 0, [
  p(
    'sso.provider.manage',
    'sso_provider',
    'manage',
    'security',
    'critical',
    'Configure identity providers. Enabling force-SSO additionally requires Hospital Admin.',
    { sensitiveGrant: true, requiresStepUp: true },
  ),
  p(
    'sso.mapping.manage',
    'sso_role_mapping',
    'manage',
    'security',
    'critical',
    'Maintain claim and group→role mappings. Sensitive-role mappings need Hospital Admin.',
    { sensitiveGrant: true },
  ),
  p(
    'sso.identity.manage',
    'sso_identity',
    'manage',
    'security',
    'high',
    'Link and unlink federated identities.',
  ),
  p(
    'sso.log.read',
    'sso_login_attempt',
    'read',
    'security',
    'medium',
    'Read the authentication log (retained ≥ 180 days per CERT-In).',
  ),
  p(
    'sso.scim.manage',
    'sso_scim_client',
    'manage',
    'security',
    'high',
    'Manage SCIM clients and rotate their tokens.',
  ),
  p(
    'sso.reconcile',
    'sso_reconciliation',
    'reconcile',
    'security',
    'medium',
    'Run and apply directory reconciliation (orphans, missing, drift).',
  ),
  p(
    'sso.breakglass.manage',
    'sso_break_glass',
    'manage',
    'security',
    'critical',
    'Manage emergency local accounts and open an IdP-outage fallback window.',
    { sensitiveGrant: true, requiresReason: true, clinicalSafetyExempt: true },
  ),
  p(
    'sso.stepup.configure',
    'sso_step_up_policy',
    'configure',
    'security',
    'critical',
    'Configure which actions demand fresh strong authentication. Dual control.',
    { sensitiveGrant: true },
  ),
  p(
    'sso.report.read',
    'sso_report',
    'read',
    'security',
    'low',
    'View login-method mix, deprovisioning SLA and break-glass reports.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// EN-017 — Integration Hub / ESB
// ─────────────────────────────────────────────────────────────────────────────
const EN017 = group('EN-017', 0, [
  p('ihub.connector.read', 'connector', 'read', 'operational', 'low', 'View connectors and their health.'),
  p(
    'ihub.connector.manage',
    'connector',
    'manage',
    'operational',
    'high',
    'Register, configure, activate, pause and retire connectors; rotate credentials.',
    { requiresStepUp: true },
  ),
  p(
    'ihub.mapping.manage',
    'mapping',
    'manage',
    'operational',
    'medium',
    'Author field mappings. Activation is gated on stored samples passing.',
  ),
  p(
    'ihub.schedule.manage',
    'schedule',
    'manage',
    'operational',
    'medium',
    'Configure polling schedules, windows and backfills.',
  ),
  p(
    'ihub.message.dispatch',
    'message',
    'dispatch',
    'operational',
    'medium',
    'Dispatch a message to a connector. Service accounts and modules only.',
  ),
  p(
    'ihub.message.read',
    'message',
    'read',
    'operational',
    'medium',
    'Read the message log. Payloads are PHI-redacted.',
  ),
  p(
    'ihub.payload.read',
    'message_payload',
    'read',
    'phi',
    'critical',
    'Reveal a full message payload. Step-up auth; audited as a PHI read.',
    { requiresStepUp: true, phiRead: true, requiresReason: true },
  ),
  p('ihub.message.retry', 'message', 'retry', 'operational', 'medium', 'Retry or discard a single message.'),
  p(
    'ihub.message.edit',
    'message',
    'update',
    'operational',
    'high',
    'Retry a message with an edited payload. Audited.',
    { requiresReason: true },
  ),
  p(
    'ihub.message.replay',
    'message',
    'replay',
    'operational',
    'high',
    'Bulk replay a range. Dry-run and a second confirmation required above 1000 messages.',
    { requiresReason: true },
  ),
  p('ihub.dlq.manage', 'dlq', 'manage', 'operational', 'medium', 'Triage the dead-letter queue.'),
  p(
    'ihub.health.read',
    'connector_health',
    'read',
    'operational',
    'low',
    'View connector health and uptime.',
  ),
  p(
    'ihub.dataflow.read',
    'data_flow',
    'read',
    'security',
    'medium',
    'Read and export the DPDP data-flow register.',
  ),
  p(
    'ihub.package.manage',
    'connector_package',
    'manage',
    'operational',
    'high',
    'Install and uninstall signed connector packages.',
  ),
  p(
    'ihub.report.read',
    'ihub_report',
    'read',
    'operational',
    'low',
    'View integration volume and error reports.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// EN-013 — Barcode / QR
// ─────────────────────────────────────────────────────────────────────────────
const EN013 = group('EN-013', 0, [
  p(
    'barcode.scheme.configure',
    'bc_scheme',
    'configure',
    'operational',
    'medium',
    'Configure identifier schemes and symbologies.',
  ),
  p(
    'barcode.label.print',
    'bc_label',
    'print',
    'operational',
    'low',
    'Print labels for entities in your scope.',
    { clinicalSafetyExempt: true },
  ),
  p(
    'barcode.label.reprint',
    'bc_label',
    'reprint',
    'operational',
    'medium',
    'Reprint a label. Reason mandatory.',
    { requiresReason: true },
  ),
  p(
    'barcode.wristband.issue',
    'bc_wristband',
    'issue',
    'phi',
    'medium',
    'Issue or deactivate a patient wristband.',
    { clinicalSafetyExempt: true },
  ),
  p('barcode.scan', 'bc_scan', 'scan', 'operational', 'low', 'Resolve a scanned code to an entity.', {
    clinicalSafetyExempt: true,
  }),
  p(
    'barcode.verify.mar',
    'bc_verification',
    'verify',
    'phi',
    'high',
    'Perform bedside medication verification (5 Rights).',
    { clinicalSafetyExempt: true },
  ),
  p(
    'barcode.verify.sample',
    'bc_verification',
    'verify',
    'phi',
    'high',
    'Verify specimen collection against the patient wristband.',
    { clinicalSafetyExempt: true },
  ),
  p(
    'barcode.verify.blood',
    'bc_verification',
    'verify',
    'phi',
    'critical',
    'Verify a blood component against the patient. Requires two authenticated people.',
    { requiresSecondPerson: true, clinicalSafetyExempt: true },
  ),
  p(
    'barcode.verify.implant',
    'bc_verification',
    'verify',
    'phi',
    'high',
    'Scan an implant UDI into the implant log.',
    { clinicalSafetyExempt: true },
  ),
  p(
    'barcode.verify.cssd',
    'bc_verification',
    'verify',
    'operational',
    'high',
    'Verify a CSSD pack at point of use.',
    { clinicalSafetyExempt: true },
  ),
  p(
    'barcode.verify.override',
    'bc_verification',
    'override',
    'phi',
    'critical',
    'Override a failed verification. Reason mandatory; supervisor for high-alert drugs.',
    { requiresReason: true, requiresSecondPerson: true, clinicalSafetyExempt: true },
  ),
  p(
    'barcode.device.configure',
    'bc_scanner_profile',
    'configure',
    'operational',
    'low',
    'Manage scanner profiles and configuration sheets.',
  ),
  p(
    'barcode.token.issue',
    'bc_signed_token',
    'issue',
    'operational',
    'medium',
    'Mint a signed public QR token. System use.',
  ),
  p(
    'barcode.report.read',
    'bc_report',
    'read',
    'operational',
    'low',
    'View verification, override and label reports.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// EN-005 — Printer Integration
// ─────────────────────────────────────────────────────────────────────────────
const EN005 = group('EN-005', 0, [
  p(
    'admin.print.configure',
    'printer',
    'configure',
    'operational',
    'medium',
    'Register agents and printers, map document types, configure auto-print rules.',
  ),
  p(
    'admin.print.read',
    'printer',
    'read',
    'operational',
    'low',
    'View printer and queue health and cost reports.',
  ),
  p('print.job.create', 'print_job', 'create', 'operational', 'low', 'Send a document to a printer.', {
    clinicalSafetyExempt: true,
  }),
  p('print.job.read', 'print_job', 'read', 'operational', 'low', 'View print jobs. Own jobs by default.'),
  p(
    'print.job.reprint',
    'print_job',
    'reprint',
    'financial',
    'medium',
    'Reprint a document. Reason mandatory for receipts, bills and reports.',
    { requiresReason: true },
  ),
  p('print.job.manage', 'print_job', 'manage', 'operational', 'medium', 'Cancel or redirect any print job.'),
  p(
    'print.cross_branch',
    'print_job',
    'override',
    'phi',
    'high',
    'Print a PHI document to a printer in another branch. Denied by default.',
    { requiresReason: true },
  ),
  p(
    'print.agent',
    'print_agent',
    'read',
    'operational',
    'low',
    'Print-agent device token scope: fetch and acknowledge jobs for its own printers.',
  ),
  p(
    'print.template.configure',
    'print_template',
    'configure',
    'operational',
    'medium',
    'Configure print templates (delegated to EN-039).',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// EN-032 — Email Integration
// ─────────────────────────────────────────────────────────────────────────────
const EN032 = group('EN-032', 0, [
  p(
    'email.provider.manage',
    'email_provider',
    'manage',
    'operational',
    'high',
    'Configure SMTP/SES providers and DKIM/SPF.',
  ),
  p(
    'email.sender.manage',
    'email_sender',
    'manage',
    'operational',
    'medium',
    'Manage verified sender identities.',
  ),
  p(
    'email.send',
    'email',
    'send',
    'operational',
    'low',
    'Send transactional email. Scoped by template category.',
  ),
  p(
    'email.campaign.manage',
    'email_campaign',
    'manage',
    'operational',
    'medium',
    'Author campaigns. Health content requires DPO approval.',
  ),
  p(
    'email.campaign.send',
    'email_campaign',
    'send',
    'operational',
    'high',
    'Dispatch an approved campaign to its audience, honouring the suppression list.',
    { requiresReason: true },
  ),
  p(
    'email.message.read',
    'email_message',
    'read',
    'operational',
    'medium',
    'Read the email delivery log for your own references.',
  ),
  p(
    'email.recipient.read',
    'email_recipient',
    'read',
    'phi',
    'high',
    'Reveal recipient addresses. Step-up auth; audited.',
    { requiresStepUp: true, phiRead: true },
  ),
  p(
    'email.message.resend',
    'email_message',
    'retry',
    'operational',
    'medium',
    'Resend a previously sent message to the same recipients.',
  ),
  p(
    'email.suppression.manage',
    'email_suppression',
    'manage',
    'operational',
    'medium',
    'Manage the bounce and opt-out suppression list.',
  ),
  p(
    'email.verify.send',
    'email_verification',
    'send',
    'operational',
    'low',
    'Send an address-verification email.',
  ),
  p('email.phi.read', 'email_message', 'read', 'phi', 'high', 'Read PHI-bearing email content.', {
    phiRead: true,
    requiresStepUp: true,
  }),
  p(
    'email.report.read',
    'email_report',
    'read',
    'operational',
    'low',
    'View delivery and engagement reports.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// EN-022 — Backup & Disaster Recovery
// ─────────────────────────────────────────────────────────────────────────────
const EN022 = group('EN-022', 0, [
  p(
    'dr.policy.configure',
    'dr_policy',
    'configure',
    'security',
    'critical',
    'Configure backup schedules, retention and RPO/RTO targets. Dual control.',
    { sensitiveGrant: true },
  ),
  p(
    'dr.repository.manage',
    'dr_repository',
    'manage',
    'security',
    'high',
    'Manage backup repositories and their credentials.',
  ),
  p('dr.backup.read', 'dr_backup', 'read', 'operational', 'low', 'View backup history and status.'),
  p('dr.backup.run', 'dr_backup', 'run', 'operational', 'medium', 'Trigger an on-demand backup.'),
  p(
    'dr.restore.test',
    'dr_restore',
    'run',
    'operational',
    'medium',
    'Run a restore into an isolated scratch environment.',
  ),
  p('dr.restore.request', 'dr_restore', 'request', 'security', 'critical', 'Request a production restore.', {
    requiresReason: true,
  }),
  p(
    'dr.restore.approve',
    'dr_restore',
    'approve',
    'security',
    'critical',
    'Approve a production restore. Must differ from the requester.',
    { sensitiveGrant: true, requiresReason: true, requiresStepUp: true },
  ),
  p(
    'dr.drill.manage',
    'dr_drill',
    'manage',
    'operational',
    'medium',
    'Schedule and record DR drills (core.dr_drills).',
  ),
  p('dr.drill.read', 'dr_drill', 'read', 'operational', 'low', 'View DR drill records.'),
  p('dr.runbook.manage', 'dr_runbook', 'manage', 'operational', 'medium', 'Maintain operational runbooks.'),
  p('dr.status.read', 'dr_status', 'read', 'operational', 'low', 'View backup/PITR/restore-drill status.', {
    clinicalSafetyExempt: true,
  }),
  p(
    'dr.status.fleet',
    'dr_status',
    'fleet',
    'operational',
    'medium',
    'Operator: cross-tenant backup posture.',
  ),
  p(
    'dr.downtime.manage',
    'dr_downtime',
    'manage',
    'operational',
    'high',
    'Declare a downtime window (also pauses SLA clocks in EN-038) and activate the downtime protocol.',
    { requiresReason: true, clinicalSafetyExempt: true },
  ),
  p(
    'dr.maintenance.manage',
    'dr_maintenance',
    'manage',
    'operational',
    'medium',
    'Schedule maintenance windows.',
  ),
  p('dr.report.read', 'dr_report', 'read', 'operational', 'low', 'View DR compliance reports.'),
]);

// ─────────────────────────────────────────────────────────────────────────────
// EN-026 — API Gateway
// ─────────────────────────────────────────────────────────────────────────────
const EN026 = group('EN-026', 0, [
  p(
    'gateway.product.manage',
    'api_product',
    'manage',
    'operational',
    'high',
    'Define API products and their scopes.',
  ),
  p(
    'gateway.client.manage',
    'api_client',
    'manage',
    'security',
    'high',
    'Issue and revoke API client credentials. Production PHI access needs Hospital Admin approval.',
    { sensitiveGrant: true, requiresStepUp: true },
  ),
  p(
    'gateway.policy.manage',
    'api_policy',
    'manage',
    'operational',
    'high',
    'Configure rate limits and quotas within the licence ceiling.',
  ),
  p(
    'gateway.usage.read',
    'api_usage',
    'read',
    'operational',
    'low',
    'View API usage. Partners see only their own.',
  ),
  p('gateway.log.read', 'api_log', 'read', 'phi', 'medium', 'Read API access logs.', { phiRead: true }),
  p(
    'gateway.webhook.manage',
    'api_webhook',
    'manage',
    'operational',
    'medium',
    'Manage outbound webhook subscriptions.',
  ),
  p(
    'gateway.status.manage',
    'api_status',
    'manage',
    'operational',
    'medium',
    'Publish status-page incidents.',
  ),
  p('gateway.status.read', 'api_status', 'read', 'operational', 'low', 'Read the API status page.'),
  p(
    'gateway.dataflow.read',
    'api_data_flow',
    'read',
    'security',
    'medium',
    'Read the API data-flow register.',
  ),
  p(
    'gateway.devportal.admin',
    'developer_portal',
    'admin',
    'operational',
    'medium',
    'Approve developer accounts in the portal.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// EN-023 — Cybersecurity
// ─────────────────────────────────────────────────────────────────────────────
const EN023 = group('EN-023', 0, [
  p(
    'security.posture.read',
    'security_posture',
    'read',
    'security',
    'low',
    'View the security posture dashboard.',
  ),
  p(
    'security.posture.fleet',
    'security_posture',
    'fleet',
    'security',
    'medium',
    'Operator: cross-tenant security posture.',
  ),
  p(
    'security.asset.manage',
    'security_asset',
    'manage',
    'security',
    'medium',
    'Maintain the IT asset inventory.',
  ),
  p(
    'security.vuln.manage',
    'vulnerability',
    'manage',
    'security',
    'high',
    'Triage and track vulnerabilities.',
  ),
  p(
    'security.patch.manage',
    'patch',
    'manage',
    'security',
    'high',
    'Plan and record patching. Medical devices coordinated with Biomedical.',
  ),
  p('security.incident.read', 'security_incident', 'read', 'security', 'medium', 'Read security incidents.'),
  p(
    'security.incident.manage',
    'security_incident',
    'manage',
    'security',
    'high',
    'Open, update and close security incidents.',
  ),
  p(
    'security.incident.act',
    'security_incident',
    'act',
    'security',
    'critical',
    'Take containment action. Care-impacting actions need Medical Superintendent concurrence.',
    { sensitiveGrant: true, requiresReason: true },
  ),
  p(
    'security.certin.report',
    'certin_report',
    'create',
    'security',
    'critical',
    'File a CERT-In incident report (6-hour obligation).',
    { sensitiveGrant: true },
  ),
  p(
    'security.breach.notify',
    'breach_notification',
    'notify',
    'security',
    'critical',
    'Issue DPDP breach notifications. DPO only (72-hour obligation).',
    { sensitiveGrant: true },
  ),
  p(
    'security.secret.manage',
    'secret',
    'manage',
    'security',
    'critical',
    'Manage secrets and rotate keys. Dual control for the key-encryption key.',
    { sensitiveGrant: true, requiresStepUp: true },
  ),
  p(
    'security.endpoint.manage',
    'endpoint',
    'manage',
    'security',
    'high',
    'Manage endpoint protection policy.',
  ),
  p(
    'security.pentest.manage',
    'pentest',
    'manage',
    'security',
    'high',
    'Record penetration tests and track finding closure.',
  ),
  p(
    'security.awareness.manage',
    'awareness',
    'manage',
    'security',
    'low',
    'Run security-awareness campaigns.',
  ),
  p('security.edge.manage', 'edge', 'manage', 'security', 'high', 'Manage WAF, DDoS and edge rules.'),
  p('security.siem.manage', 'siem', 'manage', 'security', 'high', 'Configure SIEM forwarding.'),
  p('security.report.read', 'security_report', 'read', 'security', 'low', 'View security reports.'),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — Patient & Front Office
// ─────────────────────────────────────────────────────────────────────────────

// OP-001 — front office, patient master/MPI, appointments, visits
const OP001 = group('OP-001', 1, [
  p('patient.record.create', 'patient', 'create', 'phi', 'high', 'Register a new patient and issue a UHID.'),
  p(
    'patient.record.read',
    'patient',
    'read',
    'phi',
    'medium',
    'Open a patient record and its safety banner.',
    { phiRead: true },
  ),
  p(
    'patient.record.list',
    'patient',
    'list',
    'phi',
    'medium',
    'Search the patient master. Results are audited with the count and filter, never the identifiers.',
    { phiRead: true },
  ),
  p(
    'patient.record.update',
    'patient',
    'update',
    'phi',
    'high',
    'Amend demographics. Every change is versioned with a reason; nothing is overwritten in place.',
    { requiresReason: true },
  ),
  p(
    'patient.record.create_override',
    'patient',
    'override',
    'phi',
    'critical',
    'Register a patient despite a duplicate score at or above the blocking threshold. The override and its reason are recorded against both records.',
    { requiresReason: true, sensitiveGrant: true },
  ),
  p(
    'patient.record.export',
    'patient',
    'export',
    'phi',
    'critical',
    'Export patient records. Audited with the row count and the filter used.',
    { requiresReason: true, phiRead: true },
  ),
  p(
    'patient.record.print',
    'patient',
    'print',
    'phi',
    'medium',
    'Print a patient card, wristband or summary.',
    { phiRead: true },
  ),
  p(
    'patient.mobile.verify',
    'patient_mobile',
    'update',
    'phi',
    'medium',
    'Send and verify a mobile OTP. A verified mobile becomes the portal login identity.',
  ),
  p(
    'patient.alert.manage',
    'patient_alert',
    'update',
    'phi',
    'high',
    'Add or retire a patient alert (allergy mirror, MLC, isolation, credit block). Drives the safety banner.',
    { clinicalSafetyExempt: true },
  ),
  p(
    'patient.merge.review',
    'patient_merge',
    'read',
    'phi',
    'medium',
    'Review the duplicate-patient queue and its scores.',
    { phiRead: true },
  ),
  p(
    'patient.merge.execute',
    'patient_merge',
    'update',
    'phi',
    'critical',
    'Merge two patient records. Two-step confirmation, fully audited, reversible; the victim UHID is never reissued.',
    { requiresReason: true, requiresStepUp: true, sensitiveGrant: true },
  ),

  p(
    'appointment.slot.read',
    'appointment_slot',
    'read',
    'operational',
    'low',
    'See a doctor’s available appointment slots for a date.',
  ),
  p(
    'appointment.create',
    'appointment',
    'create',
    'phi',
    'medium',
    'Book an appointment against a published slot.',
  ),
  p(
    'appointment.list',
    'appointment',
    'list',
    'phi',
    'low',
    'List appointments for a doctor, department or day.',
  ),
  p(
    'appointment.update',
    'appointment',
    'update',
    'phi',
    'medium',
    'Reschedule an appointment or confirm a booking.',
  ),
  p(
    'appointment.cancel',
    'appointment',
    'cancel',
    'phi',
    'medium',
    'Cancel an appointment. A reason is required because it drives the refund policy.',
    { requiresReason: true },
  ),
  p(
    'appointment.overbook',
    'appointment',
    'override',
    'operational',
    'high',
    'Book beyond a slot’s capacity. Deliberately separate from `appointment.create`: overbooking is a clinical-load decision, not a booking one.',
    { requiresReason: true },
  ),
  p(
    'appointment.waitlist',
    'appointment_waitlist',
    'update',
    'operational',
    'low',
    'Manage the waitlist and offer released slots to waiting patients.',
  ),

  p('visit.create', 'op_visit', 'create', 'phi', 'medium', 'Check a patient in and open an OP visit.'),
  p('visit.list', 'op_visit', 'list', 'phi', 'low', 'List visits for a doctor, a department or a day.'),
  p(
    'visit.update',
    'op_visit',
    'update',
    'phi',
    'medium',
    'Update visit details or close a completed visit.',
  ),
  p(
    'visit.cancel',
    'op_visit',
    'cancel',
    'phi',
    'medium',
    'Cancel a visit. Refused once the consultation has started — the billing reversal path is used instead.',
    { requiresReason: true },
  ),
  p(
    'visit.transfer',
    'op_visit',
    'update',
    'phi',
    'medium',
    'Move a visit to another doctor or department.',
    { requiresReason: true },
  ),

  p(
    'schedule.configure',
    'schedule_template',
    'configure',
    'operational',
    'medium',
    'Edit doctor schedule templates, sessions and exceptions.',
  ),
  p(
    'schedule.publish',
    'schedule_template',
    'update',
    'operational',
    'high',
    'Publish a schedule version. Published schedules are what the website and portal book against.',
  ),

  p(
    'frontoffice.dashboard.read',
    'frontoffice_dashboard',
    'read',
    'operational',
    'low',
    'View front-office counter activity and daily KPIs.',
  ),
  p(
    'frontoffice.counter.configure',
    'registration_counter',
    'configure',
    'operational',
    'medium',
    'Configure registration counters and kiosk devices.',
  ),
  p(
    'kiosk.checkin',
    'kiosk',
    'create',
    'phi',
    'low',
    'Self check-in from a kiosk. Held by a device token, never by a person.',
  ),
]);

// EN-006 — queue and tokens
const EN006 = group('EN-006', 1, [
  p(
    'queue.config.manage',
    'queue_config',
    'configure',
    'operational',
    'medium',
    'Define queues, priority rules and calling policy.',
  ),
  p(
    'queue.counter.manage',
    'queue_counter',
    'configure',
    'operational',
    'low',
    'Open, close and reassign service counters.',
  ),
  p(
    'queue.token.issue',
    'queue_token',
    'create',
    'operational',
    'low',
    'Issue a token. Held by reception, kiosk devices, the call centre, ER and wards.',
    { clinicalSafetyExempt: true },
  ),
  p(
    'queue.token.read',
    'queue_token',
    'read',
    'operational',
    'low',
    'View tokens, their positions and estimated waits.',
  ),
  p(
    'queue.token.call',
    'queue_token',
    'update',
    'operational',
    'low',
    'Call, recall or skip the next token. Scoped to the holder’s own queues by the ABAC `ownQueueOnly` condition.',
  ),
  p(
    'queue.token.manage',
    'queue_token',
    'update',
    'operational',
    'medium',
    'Transfer, re-prioritise or cancel a token.',
    { requiresReason: true },
  ),
  p(
    'queue.board.read',
    'queue_board',
    'read',
    'operational',
    'low',
    'Render a queue board. Held by display device tokens as well as staff.',
    { clinicalSafetyExempt: true },
  ),
  p(
    'queue.doctor.status',
    'queue_doctor_status',
    'update',
    'operational',
    'low',
    'Set a doctor as available, on break, or running late.',
  ),
  p(
    'queue.overview.read',
    'queue_overview',
    'read',
    'operational',
    'low',
    'See every queue in the branch on one overview.',
  ),
  p(
    'queue.analytics.read',
    'queue_analytics',
    'read',
    'operational',
    'low',
    'Read wait-time, throughput and no-show analytics.',
  ),
  p(
    'queue.virtual.join',
    'queue_token',
    'create',
    'operational',
    'low',
    'Join a queue remotely. Patient scope.',
  ),
]);

// NC-001 — cash counter
const NC001 = group('NC-001', 1, [
  p(
    'receipt.counter.configure',
    'cash_counter',
    'configure',
    'financial',
    'medium',
    'Configure cash counters, payment modes and float policy.',
  ),
  p(
    'receipt.shift.open',
    'cash_shift',
    'create',
    'financial',
    'medium',
    'Open a cashier shift and declare the opening float.',
  ),
  p(
    'receipt.shift.open_any',
    'cash_shift',
    'override',
    'financial',
    'high',
    'Open a shift on another cashier’s counter.',
    { requiresReason: true },
  ),
  p(
    'receipt.shift.read',
    'cash_shift',
    'read',
    'financial',
    'low',
    'View a cashier shift and its collections.',
  ),
  p(
    'receipt.shift.list',
    'cash_shift',
    'list',
    'financial',
    'low',
    'List cashier shifts for a counter or a day.',
  ),
  p(
    'receipt.shift.close',
    'cash_shift',
    'update',
    'financial',
    'medium',
    'Close a shift and declare the denomination sheet.',
  ),
  p(
    'receipt.shift.force_close',
    'cash_shift',
    'override',
    'financial',
    'high',
    'Close somebody else’s shift — used when a cashier leaves without closing.',
    { requiresReason: true, requiresStepUp: true },
  ),
  p(
    'receipt.shift.variance.approve',
    'cash_shift',
    'approve',
    'financial',
    'high',
    'Approve a closing variance. Creator may never be approver.',
    { requiresReason: true },
  ),
  p(
    'receipt.collect',
    'receipt',
    'create',
    'financial',
    'medium',
    'Take a payment and issue a numbered receipt.',
  ),
  p(
    'receipt.collect.night',
    'receipt',
    'create',
    'financial',
    'high',
    'Collect outside counter hours. Bounded by an ABAC time window and amount limit.',
  ),
  p(
    'receipt.reprint',
    'receipt',
    'reprint',
    'financial',
    'medium',
    'Reprint a receipt. Every reprint is marked and audited.',
    { requiresReason: true },
  ),
  p(
    'receipt.void',
    'receipt',
    'cancel',
    'financial',
    'critical',
    'Void a receipt. Requires a supervisor and a reason; the original is never deleted.',
    { requiresReason: true, requiresSecondPerson: true },
  ),
  p(
    'receipt.drawer.open',
    'cash_drawer',
    'update',
    'financial',
    'medium',
    'Open the cash drawer without a sale. Audited, because it is the classic shrinkage path.',
    { requiresReason: true },
  ),
  p(
    'receipt.refund.pay',
    'refund',
    'create',
    'financial',
    'critical',
    'Pay out a refund. Bounded by an ABAC amount limit and an approval.',
    { requiresReason: true, requiresSecondPerson: true },
  ),
  p(
    'receipt.handover.accept',
    'cash_handover',
    'approve',
    'financial',
    'high',
    'Accept a cash handover from a closing cashier shift.',
  ),
  p(
    'receipt.night.reconcile',
    'cash_shift',
    'update',
    'financial',
    'medium',
    'Reconcile the overnight collection against the counter.',
  ),
  p(
    'receipt.daybook.read',
    'daybook',
    'read',
    'financial',
    'low',
    'Read the day book — the daily collection summary by mode.',
  ),
  p(
    'receipt.daybook.close',
    'daybook',
    'update',
    'financial',
    'high',
    'Close the day book. Irreversible for the period.',
    { requiresReason: true },
  ),
  p(
    'receipt.petty.manage',
    'petty_cash',
    'update',
    'financial',
    'medium',
    'Manage the petty-cash float and its vouchers.',
  ),
  p(
    'receipt.forex.configure',
    'forex',
    'configure',
    'financial',
    'medium',
    'Configure foreign-currency handling and exchange rates.',
  ),
  p(
    'receipt.forex.collect',
    'forex',
    'create',
    'financial',
    'medium',
    'Collect a payment in a foreign currency at the declared rate.',
  ),
  p(
    'receipt.report.read',
    'receipt_report',
    'read',
    'financial',
    'low',
    'Read collection and variance reports for a counter or period.',
  ),
  p(
    'receipt.export',
    'receipt',
    'export',
    'financial',
    'high',
    'Export receipts. Audited with the row count.',
    { requiresReason: true },
  ),
]);

// EN-009 — SMS and WhatsApp
const EN009 = group('EN-009', 1, [
  p(
    'messaging.provider.configure',
    'messaging_provider',
    'configure',
    'operational',
    'high',
    'Configure gateways, sender IDs and DLT entity registration.',
  ),
  p(
    'messaging.provider.read',
    'messaging_provider',
    'read',
    'operational',
    'low',
    'View messaging gateway configuration and delivery health.',
  ),
  p(
    'messaging.template.configure',
    'message_template',
    'configure',
    'operational',
    'medium',
    'Author message templates. A template whose content would carry clinical detail is refused here, not at send time.',
  ),
  p(
    'messaging.template.approve',
    'message_template',
    'approve',
    'operational',
    'high',
    'Approve a template for sending. Author may not approve.',
    { requiresReason: true },
  ),
  p(
    'messaging.message.send',
    'message',
    'create',
    'operational',
    'medium',
    'Send a message from an approved, registered template.',
  ),
  p(
    'messaging.message.read',
    'message',
    'read',
    'phi',
    'medium',
    'Read the message log. Patient-level reads are audited.',
    { phiRead: true },
  ),
  p(
    'messaging.optin.manage',
    'messaging_optin',
    'update',
    'operational',
    'high',
    'Record consent or opt-out. DPDP and TRAI-DND both land here.',
    { requiresReason: true },
  ),
  p(
    'messaging.optin.read',
    'messaging_optin',
    'read',
    'operational',
    'low',
    'Read the opt-out and consent ledger for a number.',
  ),
  p(
    'messaging.trigger.configure',
    'messaging_trigger',
    'configure',
    'operational',
    'medium',
    'Map domain events to the templates they trigger.',
  ),
  p(
    'messaging.inbox.read',
    'messaging_inbox',
    'read',
    'phi',
    'medium',
    'Read inbound patient replies in the shared inbox.',
    { phiRead: true },
  ),
  p(
    'messaging.inbox.reply',
    'messaging_inbox',
    'create',
    'phi',
    'medium',
    'Reply to an inbound patient message from the shared inbox.',
  ),
  p(
    'messaging.campaign.manage',
    'messaging_campaign',
    'update',
    'commercial',
    'medium',
    'Build a marketing campaign and its audience.',
  ),
  p(
    'messaging.campaign.approve',
    'messaging_campaign',
    'approve',
    'commercial',
    'high',
    'Approve a campaign for send. Promotional sends are consent-gated separately from transactional ones.',
    { requiresReason: true },
  ),
  p(
    'messaging.cost.read',
    'messaging_cost',
    'read',
    'financial',
    'low',
    'Read per-message and per-tenant messaging cost reports.',
  ),
]);

// EN-011 — ABDM / ABHA (M1 in this phase)
const EN011 = group('EN-011', 1, [
  p(
    'integration.abdm.configure',
    'abdm_config',
    'configure',
    'security',
    'critical',
    'Configure ABDM credentials, HFR facility and HPR mapping. Dual control.',
    { sensitiveGrant: true, requiresStepUp: true },
  ),
  p(
    'integration.abdm.read',
    'abdm_config',
    'read',
    'operational',
    'low',
    'View ABDM configuration and health.',
  ),
  p(
    'abdm.abha.create',
    'abha',
    'create',
    'phi',
    'medium',
    'Create an ABHA on the patient’s behalf, with consent.',
  ),
  p(
    'abdm.abha.verify',
    'abha',
    'read',
    'phi',
    'medium',
    'Verify an ABHA number or address against the ABDM registry.',
  ),
  p('abdm.abha.link', 'abha', 'update', 'phi', 'medium', 'Link a verified ABHA to a patient record.'),
  p('abdm.abha.delink', 'abha', 'delete', 'phi', 'high', 'Delink an ABHA. Supervisor action.', {
    requiresReason: true,
  }),
  p(
    'abdm.abha.read',
    'abha',
    'read',
    'phi',
    'medium',
    'Read a patient’s ABHA number, address and linkage status.',
    { phiRead: true },
  ),
  p(
    'abdm.scan_share.manage',
    'abdm_scan_share',
    'update',
    'phi',
    'low',
    'Operate scan-and-share intake at the registration desk.',
  ),
  p(
    'abdm.hip.link',
    'abdm_care_context',
    'create',
    'phi',
    'medium',
    'Link a care context to an ABHA so records become discoverable.',
  ),
  p(
    'abdm.consent.read',
    'abdm_consent',
    'read',
    'phi',
    'medium',
    'Read the ABDM consent artefacts held for a patient.',
    { phiRead: true },
  ),
  p(
    'abdm.registry.manage',
    'abdm_registry',
    'configure',
    'operational',
    'medium',
    'Manage HFR facility and HPR practitioner registry entries.',
  ),
]);

// EN-028 — consent
const EN028 = group('EN-028', 1, [
  p('consent.read', 'consent', 'read', 'phi', 'medium', 'Read a patient’s consents.', { phiRead: true }),
  p(
    'consent.request',
    'consent',
    'create',
    'phi',
    'low',
    'Raise a consent request against a patient and purpose.',
  ),
  p(
    'consent.capture',
    'consent',
    'create',
    'phi',
    'medium',
    'Capture a consent with the patient present. Requires an explicit affirmative action, never a pre-ticked box.',
  ),
  p(
    'consent.withdraw',
    'consent',
    'update',
    'phi',
    'high',
    'Withdraw a consent. DPDP makes this a right, so it must be at least as easy as giving it.',
    { requiresReason: true },
  ),
  p(
    'consent.emergency_override',
    'consent',
    'override',
    'phi',
    'critical',
    'Treat without consent in an emergency. Lawful and sometimes necessary; the Medical Superintendent is notified and it is reviewed.',
    { requiresReason: true, clinicalSafetyExempt: true },
  ),
  p(
    'consent.override.review',
    'consent',
    'approve',
    'phi',
    'high',
    'Review emergency consent overrides and their justification.',
  ),
  p(
    'consent.template.manage',
    'consent_template',
    'configure',
    'operational',
    'medium',
    'Author consent templates and their clauses.',
  ),
  p(
    'consent.template.approve',
    'consent_template',
    'approve',
    'operational',
    'high',
    'Approve a consent template. Needs the Medical Superintendent and Legal/DPO.',
    { requiresReason: true },
  ),
  p(
    'consent.type.configure',
    'consent_type',
    'configure',
    'operational',
    'medium',
    'Configure consent types and their lawful purposes.',
  ),
  p(
    'consent.notice.manage',
    'consent_notice',
    'configure',
    'operational',
    'high',
    'Manage the DPDP privacy notice and its versions.',
  ),
  p(
    'consent.guardian.manage',
    'consent_guardian',
    'update',
    'phi',
    'high',
    'Record verifiable guardian consent for a minor or a patient lacking capacity.',
    { requiresReason: true },
  ),
  p(
    'consent.dsar.manage',
    'consent_dsar',
    'update',
    'phi',
    'critical',
    'Handle a data-subject access request. DPO only.',
    { requiresReason: true, sensitiveGrant: true },
  ),
  p(
    'consent.ledger.read',
    'consent_ledger',
    'read',
    'phi',
    'medium',
    'Read the consent ledger. Append-only: no role may edit or delete a finalised entry.',
    { phiRead: true },
  ),
  p(
    'consent.artefact.manage',
    'consent_artefact',
    'update',
    'phi',
    'high',
    'Manage stored ABDM consent artefacts and their validity.',
  ),
  p(
    'consent.report.read',
    'consent_report',
    'read',
    'operational',
    'low',
    'Read consent capture and compliance reports.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────

export const PERMISSION_CATALOGUE: readonly PermissionDefinition[] = Object.freeze([
  ...EN007,
  ...EN024,
  ...EN027,
  ...EN037,
  ...EN038,
  ...EN039,
  ...EN040,
  ...EN041,
  ...EN025,
  ...EN017,
  ...EN013,
  ...EN005,
  ...EN032,
  ...EN022,
  ...EN026,
  ...EN023,

  // Phase 1
  ...OP001,
  ...EN006,
  ...NC001,
  ...EN009,
  ...EN011,
  ...EN028,
]);

const byKey = new Map<string, PermissionDefinition>(PERMISSION_CATALOGUE.map((d) => [d.key, d]));

// A duplicate key would mean two modules silently sharing an authorisation
// decision. Fail at import time rather than at 2 a.m.
if (byKey.size !== PERMISSION_CATALOGUE.length) {
  const seen = new Set<string>();
  const dupes = PERMISSION_CATALOGUE.map((d) => d.key).filter((k) =>
    seen.has(k) ? true : (seen.add(k), false),
  );
  throw new Error(`Duplicate permission keys in the catalogue: ${[...new Set(dupes)].join(', ')}`);
}

/** Every registered key, as a union-friendly readonly tuple source. */
export const PERMISSION_KEYS: readonly string[] = Object.freeze(PERMISSION_CATALOGUE.map((d) => d.key));

export function isRegisteredPermission(key: string): boolean {
  return byKey.has(key);
}

export function getPermission(key: string): PermissionDefinition | undefined {
  return byKey.get(key);
}

/**
 * `EN-007 §3.3.1` / `docs/04 §3`: a module may not use an unregistered key.
 * The `@Permission()` decorator calls this at class-construction time, so an
 * unregistered key fails the process at boot, not on the first request.
 */
export function assertRegisteredPermission(key: string, context: string): PermissionDefinition {
  const def = byKey.get(key);
  if (!def) {
    throw new Error(
      `Unregistered permission key "${key}" used by ${context}. ` +
        `Add it to packages/contracts/src/rbac/permissions.ts — the catalogue is the contract (EN-007 §3.3).`,
    );
  }
  return def;
}

export function permissionsForModule(moduleId: string): readonly PermissionDefinition[] {
  return PERMISSION_CATALOGUE.filter((d) => d.module === moduleId);
}

/**
 * `EN-040 §5` / `EN-040 §14 AC-20`: the keys that no licence state, degradation
 * tier or feature flag may ever block. The safety test suite iterates this list
 * at every tier and fails the build if one becomes gateable.
 */
export const CLINICAL_SAFETY_EXEMPT_PERMISSIONS: readonly string[] = Object.freeze(
  PERMISSION_CATALOGUE.filter((d) => d.clinicalSafetyExempt).map((d) => d.key),
);

/** Keys whose *grant* needs dual approval + MFA on the grantee (EN-007 §5). */
export const SENSITIVE_GRANT_PERMISSIONS: readonly string[] = Object.freeze(
  PERMISSION_CATALOGUE.filter((d) => d.sensitiveGrant).map((d) => d.key),
);

/** Keys whose *use* requires a reason (EN-024 §5). */
export const REASON_REQUIRED_PERMISSIONS: readonly string[] = Object.freeze(
  PERMISSION_CATALOGUE.filter((d) => d.requiresReason).map((d) => d.key),
);

/** Keys whose *use* requires fresh strong auth (EN-025 §3.6). */
export const STEP_UP_PERMISSIONS: readonly string[] = Object.freeze(
  PERMISSION_CATALOGUE.filter((d) => d.requiresStepUp).map((d) => d.key),
);

/** Keys whose *use* requires a second authenticated person (docs/05 §ABAC). */
export const SECOND_PERSON_PERMISSIONS: readonly string[] = Object.freeze(
  PERMISSION_CATALOGUE.filter((d) => d.requiresSecondPerson).map((d) => d.key),
);

/** Keys whose use writes a `READ_PHI` audit row (EN-024 §3.2). */
export const PHI_READ_PERMISSIONS: readonly string[] = Object.freeze(
  PERMISSION_CATALOGUE.filter((d) => d.phiRead).map((d) => d.key),
);

/**
 * `docs/05 §Permission catalogue conventions` / `docs/04 §3`:
 * "Segregation of duties enforced (maker ≠ checker for discounts, refunds, POs,
 * payroll, result validation, blood issue, narcotics)."
 *
 * Phase 0 can only express the pairs whose keys exist yet; later phases append
 * their own (e.g. `lab.result.enter` vs `lab.result.validate` in Phase 3).
 * `mode: 'block'` cannot be overridden except by Hospital Admin with a reason
 * (EN-007 §5).
 */
export interface SodRule {
  readonly permA: string;
  readonly permB: string;
  readonly mode: 'warn' | 'block';
  readonly reason: string;
}

export const SEGREGATION_OF_DUTIES_RULES: readonly SodRule[] = Object.freeze([
  {
    permA: 'wf.matrix.manage',
    permB: 'wf.matrix.publish',
    mode: 'warn',
    reason:
      'Authoring and publishing an approval matrix by the same person removes the only control over the control (EN-038 §3.7).',
  },
  {
    permA: 'dr.restore.request',
    permB: 'dr.restore.approve',
    mode: 'block',
    reason: 'EN-022 §12 requires the restore approver to differ from the requester.',
  },
  {
    permA: 'admin.role.assign',
    permB: 'admin.access.approve',
    mode: 'warn',
    reason:
      'Requesting and approving one’s own access grant defeats the access-request workflow (EN-007 §3.2).',
  },
  {
    permA: 'lic.override.manage',
    permB: 'lic.billing.manage',
    mode: 'warn',
    reason: 'Granting a commercial override and billing for it should be separate hands (EN-040 §5).',
  },
  {
    permA: 'audit.config.manage',
    permB: 'audit.export',
    mode: 'block',
    reason:
      'Whoever can change what the audit log records must not also be the person who produces evidence from it (EN-024 §5).',
  },
  {
    permA: 'security.secret.manage',
    permB: 'audit.retention.configure',
    mode: 'block',
    reason:
      'Control of key material plus control of audit retention is the exact combination an insider needs to erase their tracks (EN-024 §3.4).',
  },
]);
