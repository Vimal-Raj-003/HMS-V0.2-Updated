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
  | 'admin'
  // Phase 3 — the verbs the diagnostics specs actually use.
  | 'label'
  | 'collect'
  | 'receive'
  | 'enter'
  | 'amend'
  | 'record'
  | 'generate'
  | 'deliver'
  | 'complete'
  | 'unlock'
  | 'void'
  | 'grant'
  | 'resolve'
  | 'ingest'
  | 'view'
  | 'annotate'
  | 'upload'
  | 'share'
  | 'cosign';

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
// Phase 2 — OPD Clinical Core
//
// From the §12 Permissions section of OP-002, OP-007, EN-029, NC-003 and OP-019.
//
// Three flags carry more weight here than anywhere in Phase 0/1 and are set
// deliberately, never by pattern:
//
//   • `clinicalSafetyExempt` (EN-040 §5, D-9) — the licence state of a tenant may
//     never stand between a clinician and a safety check. The exempt set below is
//     the allergy/CDSS path and the two alert loops that close it. A hospital with
//     an unpaid invoice still gets its allergy hard stop.
//   • `requiresReason` — every amendment, correction, cancellation and waiver,
//     because the reason is the only thing that makes the version history
//     readable afterwards (`docs/04 §7`, EN-024 §5).
//   • `requiresSecondPerson` — narcotic prescribing and record destruction. Both
//     are irreversible in the way that matters: one puts a controlled substance
//     into the world, the other removes a medical record from it.
// ─────────────────────────────────────────────────────────────────────────────

// OP-002 — consultation, e-Rx, CPOE, doctor inbox, templates
const OP002 = group('OP-002', 2, [
  p(
    'opd.queue.read',
    'opd_queue',
    'read',
    'phi',
    'low',
    'See the live consultation queue. The card carries vitals flags and safety alerts, so it is a PHI read.',
    { phiRead: true },
  ),
  p(
    'opd.queue.manage',
    'opd_queue',
    'manage',
    'phi',
    'low',
    'Call, skip or requeue a patient from the doctor’s own queue.',
  ),
  p(
    'opd.encounter.create',
    'encounter',
    'create',
    'phi',
    'medium',
    'Start a consultation against a checked-in visit.',
  ),
  p(
    'opd.encounter.read',
    'encounter',
    'read',
    'phi',
    'medium',
    'Open an encounter and the patient timeline behind it.',
    { phiRead: true },
  ),
  p(
    'opd.encounter.update',
    'encounter',
    'update',
    'phi',
    'medium',
    'Autosave consultation notes and form responses while the encounter is open.',
  ),
  p(
    'opd.encounter.sign',
    'encounter',
    'sign',
    'phi',
    'high',
    'Complete and sign a consultation note. The signed document is immutable and hash-chained; only an amendment can follow it.',
  ),
  p(
    'opd.encounter.amend',
    'encounter_amendment',
    'update',
    'phi',
    'high',
    'Amend a signed note. Creates a new version with a reason; the original stays retrievable and the PDF prints "Amended".',
    { requiresReason: true },
  ),
  p(
    'opd.diagnosis.update',
    'encounter_diagnosis',
    'update',
    'phi',
    'medium',
    'Record or revise the ICD-10/SNOMED diagnoses on an encounter. Also held by MRD for coding verification.',
  ),
  p(
    'opd.allergy.update',
    'allergy',
    'update',
    'phi',
    'high',
    'Record or retire a patient allergy. Never licence-gated: the allergy list is what the hard stop evaluates against (EN-040 §5).',
    { clinicalSafetyExempt: true },
  ),
  p(
    'opd.inbox.read',
    'doctor_inbox',
    'read',
    'phi',
    'low',
    'Read the doctor inbox: results, critical values, co-sign requests, referrals and drafts.',
    { phiRead: true },
  ),
  p(
    'opd.result.acknowledge',
    'result_acknowledgement',
    'update',
    'phi',
    'high',
    'Acknowledge a result and close the critical-value loop. Never licence-gated: an unacknowledgeable critical value is an open patient-safety loop (EN-040 §5).',
    { clinicalSafetyExempt: true },
  ),
  p(
    'opd.template.manage',
    'clinical_template',
    'manage',
    'operational',
    'low',
    'Create and edit personal consultation templates, order sets and Rx combos.',
  ),
  p(
    'opd.template.publish',
    'clinical_template',
    'publish',
    'operational',
    'medium',
    'Publish a template to the whole department. Deliberately separate from authoring it (OP-002 §12: HOD only).',
  ),
  p(
    'opd.certificate.create',
    'certificate',
    'create',
    'phi',
    'medium',
    'Issue a fitness, sick-leave or referral certificate in the signing doctor’s name.',
  ),
  p(
    'opd.preferences.manage',
    'doctor_preferences',
    'manage',
    'operational',
    'low',
    'Edit the doctor’s own favourites, hotkeys, auto-print and generic-first preferences.',
  ),
  p(
    'opd.department.view',
    'opd_department',
    'read',
    'phi',
    'medium',
    'See every doctor’s queue and wait heatmap in the department. HOD scope (OP-002 §12).',
    { phiRead: true },
  ),
  p(
    'opd.audit.read',
    'opd_audit',
    'read',
    'phi',
    'medium',
    'Read the OPD clinical audit views: unsigned drafts, amendments, break-glass and override registers.',
    { phiRead: true },
  ),
  p(
    'terminology.read',
    'terminology',
    'read',
    'operational',
    'low',
    'Search ICD-10/ICD-11, SNOMED CT and the clinical value sets behind diagnosis entry.',
  ),

  p(
    'rx.drug.search',
    'drug',
    'list',
    'operational',
    'low',
    'Search the drug master by generic or brand, with stock and price hints.',
  ),
  p(
    'rx.create',
    'prescription',
    'create',
    'phi',
    'medium',
    'Create or edit a draft prescription and run the CDSS check over its lines.',
  ),
  p(
    'rx.sign',
    'prescription',
    'sign',
    'phi',
    'high',
    'Sign a prescription and release it to pharmacy. A resident without this key leaves the Rx provisional until co-signed.',
  ),
  p(
    'rx.amend',
    'prescription_amendment',
    'update',
    'phi',
    'high',
    'Amend a signed prescription. Supersedes the previous revision; the reason is printed on the amended PDF.',
    { requiresReason: true },
  ),
  p(
    'rx.cancel',
    'prescription',
    'cancel',
    'phi',
    'medium',
    'Cancel a prescription. The reason reaches the pharmacy queue, so it is mandatory.',
    { requiresReason: true },
  ),
  p(
    'rx.print',
    'prescription',
    'print',
    'phi',
    'low',
    'Render or reprint the prescription PDF. Held by nursing so a patient is never sent away without their Rx.',
    { phiRead: true },
  ),
  p(
    'rx.cosign',
    'prescription_cosign',
    'sign',
    'phi',
    'high',
    'Co-sign a resident’s prescription, which is what releases it to pharmacy (OP-002 AC-5).',
  ),
  p(
    'rx.schedule_x.prescribe',
    'prescription_schedule_x',
    'create',
    'phi',
    'critical',
    'Prescribe a Schedule X / NDPS controlled drug. Statutory caps are a hard stop that may only be countersigned, never bypassed (EN-029 §5).',
    {
      requiresReason: true,
      requiresStepUp: true,
      requiresSecondPerson: true,
      sensitiveGrant: true,
    },
  ),

  p(
    'order.create',
    'order',
    'create',
    'phi',
    'medium',
    'Place lab, radiology, procedure, therapy, diet, nursing or referral orders.',
  ),
  p('order.list', 'order', 'list', 'phi', 'low', 'List and track orders for a patient or a worklist.', {
    phiRead: true,
  }),
  p(
    'order.cancel',
    'order',
    'cancel',
    'phi',
    'medium',
    'Cancel an order or one of its lines. The reason drives the charge reversal, so it is mandatory.',
    { requiresReason: true },
  ),
  p(
    'order.admission.request',
    'admission_request',
    'request',
    'phi',
    'high',
    'Raise a pre-admission request from the consultation with a provisional diagnosis and expected stay.',
  ),
]);

// OP-007 — vital room / nursing pre-consult
const OP007 = group('OP-007', 2, [
  p(
    'vitals.queue.read',
    'vitals_queue',
    'read',
    'phi',
    'low',
    'See the vitals-room worklist and its waiting times.',
    { phiRead: true },
  ),
  p(
    'vitals.queue.manage',
    'vitals_queue',
    'manage',
    'phi',
    'low',
    'Call, hold and hand a patient back from the vitals station to the doctor queue.',
  ),
  p(
    'vitals.record.create',
    'vitals',
    'create',
    'phi',
    'medium',
    'Record an observation set. Deliberately separate from every prescribing key: a nurse records vitals and never signs an Rx.',
  ),
  p(
    'vitals.record.read',
    'vitals',
    'read',
    'phi',
    'low',
    'Read vitals and their trends, including the paediatric growth percentile.',
    { phiRead: true },
  ),
  p(
    'vitals.record.correct',
    'vitals',
    'update',
    'phi',
    'medium',
    'Correct a recorded observation. Never an overwrite: the correction supersedes and both rows survive.',
    { requiresReason: true },
  ),
  p(
    'vitals.alert.acknowledge',
    'vitals_alert',
    'update',
    'phi',
    'high',
    'Acknowledge a red-flag vitals alert and close the loop. Never licence-gated (EN-040 §5).',
    { clinicalSafetyExempt: true },
  ),
  p(
    'vitals.recheck.request',
    'vitals_recheck',
    'request',
    'phi',
    'low',
    'Send a patient back to the vitals room for a repeat reading, re-entering the queue with priority.',
  ),
  p(
    'vitals.escalate.er',
    'vitals_escalation',
    'dispatch',
    'phi',
    'critical',
    'Send a deteriorating outpatient straight to the emergency department. Never licence-gated (EN-040 §5).',
    { clinicalSafetyExempt: true },
  ),
  p(
    'vitals.configure',
    'vitals_station',
    'configure',
    'operational',
    'medium',
    'Configure stations, paired devices and the age-banded abnormal thresholds.',
  ),
  p(
    'vitals.report.read',
    'vitals_report',
    'read',
    'operational',
    'low',
    'Read vitals-room throughput, abnormal/critical rates and device-health reports.',
  ),
  p(
    'integration.vitals.ingest',
    'vitals_device_feed',
    'create',
    'phi',
    'medium',
    'Push a device reading into a station. Held by a paired device token, never by a person (OP-007 §12).',
  ),
]);

// EN-029 — Clinical Decision Support
const EN029 = group('EN-029', 2, [
  p(
    'cdss.evaluate',
    'cdss_evaluation',
    'run',
    'phi',
    'high',
    'Run the rules engine over a draft order or prescription. Never licence-gated: this is the check itself (EN-040 §5, D-9).',
    { clinicalSafetyExempt: true },
  ),
  p(
    'cdss.alert.read',
    'cdss_alert',
    'read',
    'phi',
    'medium',
    'See fired alerts and their evidence. Never licence-gated: an alert a clinician cannot read has not fired (EN-040 §5, D-9).',
    { phiRead: true, clinicalSafetyExempt: true },
  ),
  p(
    'cdss.alert.respond',
    'cdss_alert',
    'update',
    'phi',
    'high',
    'Acknowledge, override with a coded reason, or countersign an alert. Never licence-gated: without it a hard stop can never be cleared (EN-040 §5).',
    { requiresReason: true, clinicalSafetyExempt: true },
  ),
  p(
    'cdss.alert.replay',
    'cdss_alert_replay',
    'replay',
    'phi',
    'high',
    'Reproduce a historical alert from its snapshot digest for medico-legal review. Reads and recomputes; writes nothing.',
    { phiRead: true },
  ),
  p(
    'cdss.snapshot.read',
    'cdss_snapshot',
    'read',
    'phi',
    'high',
    'Inspect the evaluation context the engine saw for a patient — allergies, problems, labs, weight.',
    { phiRead: true },
  ),
  p(
    'cdss.score.read',
    'cdss_score',
    'read',
    'phi',
    'low',
    'Read computed clinical scores such as NEWS2 and PEWS.',
    { phiRead: true },
  ),
  p(
    'cdss.score.compute',
    'cdss_score',
    'run',
    'phi',
    'low',
    'Compute a clinical score from an observation set. Idempotent per vitals row.',
  ),
  p(
    'cdss.rule.read',
    'cdss_rule',
    'read',
    'operational',
    'low',
    'Read rule definitions, versions and diffs.',
  ),
  p(
    'cdss.rule.manage',
    'cdss_rule',
    'manage',
    'operational',
    'critical',
    'Author and edit CDSS rules. Changes what every clinician in the tenant is warned about, so authoring is separated from publishing.',
    { requiresReason: true, sensitiveGrant: true },
  ),
  p(
    'cdss.rule.test',
    'cdss_rule_test',
    'run',
    'operational',
    'medium',
    'Run a draft rule against fixtures and a de-identified retrospective cohort before it can be published.',
  ),
  p(
    'cdss.rule.publish',
    'cdss_rule',
    'publish',
    'operational',
    'critical',
    'Publish, shadow, disable or roll back a rule version. Only this key can raise a rule to hard-stop, and only with EN-038 approval (EN-029 §5).',
    { requiresReason: true, requiresStepUp: true, sensitiveGrant: true },
  ),
  p(
    'cdss.kb.read',
    'cdss_kb',
    'read',
    'operational',
    'low',
    'Read knowledge-base releases and the formulary coverage report.',
  ),
  p(
    'cdss.kb.manage',
    'cdss_kb',
    'manage',
    'operational',
    'high',
    'Review and activate a knowledge-base release. A bad interaction table is a silent safety regression, so activation is reviewed.',
    { requiresReason: true, sensitiveGrant: true },
  ),
  p(
    'cdss.emergency.declare',
    'cdss_emergency_mode',
    'activate',
    'phi',
    'critical',
    'Declare bounded emergency mode on an encounter: soft stops render passive, anaphylaxis/pregnancy-X/NDPS hard stops still block. Never licence-gated (EN-040 §5).',
    { requiresReason: true, clinicalSafetyExempt: true },
  ),
  p(
    'cdss.governance.read',
    'cdss_governance',
    'read',
    'operational',
    'low',
    'Read the monthly alert-fatigue governance pack and its history.',
  ),
  p(
    'cdss.governance.manage',
    'cdss_governance',
    'manage',
    'operational',
    'high',
    'Record CDSS governance committee decisions against a rule, including retirement and downgrade.',
    { requiresReason: true },
  ),
  p(
    'cdss.report.read',
    'cdss_report',
    'read',
    'operational',
    'low',
    'Read alert-fatigue KPIs: alerts per 1000 orders, override rate and alert effectiveness.',
  ),
]);

// NC-003 — Digital MRD (Phase 2 foundation: record, deficiency, coding, scan,
// retention. Release-of-information and physical file tracking arrive with the
// full module in Phase 9.)
const NC003 = group('NC-003', 2, [
  p(
    'mrd.record.list',
    'mrd_record',
    'list',
    'phi',
    'low',
    'List medical records by status, completeness or coding queue.',
    { phiRead: true },
  ),
  p(
    'mrd.record.read',
    'mrd_record',
    'read',
    'phi',
    'medium',
    'Open a medical record and its assembled documents.',
    { phiRead: true },
  ),
  p(
    'mrd.record.close',
    'mrd_record',
    'update',
    'phi',
    'medium',
    'Close a record once assembly, signing and coding are complete.',
  ),
  p(
    'mrd.record.reopen',
    'mrd_record',
    'update',
    'phi',
    'high',
    'Reopen a closed record. A reason is required because closure is what NABH completeness is measured on.',
    { requiresReason: true },
  ),
  p(
    'mrd.record.export',
    'mrd_record',
    'export',
    'phi',
    'critical',
    'Export a medical record. Audited with the record, the basis and the recipient.',
    { requiresReason: true, requiresStepUp: true, phiRead: true },
  ),
  p(
    'mrd.deficiency.read',
    'mrd_deficiency',
    'read',
    'phi',
    'low',
    'See outstanding record deficiencies — unsigned notes, missing diagnoses — and who owns them.',
    { phiRead: true },
  ),
  p(
    'mrd.deficiency.resolve',
    'mrd_deficiency',
    'update',
    'phi',
    'low',
    'Close a deficiency once the missing content has actually been supplied.',
  ),
  p(
    'mrd.deficiency.waive',
    'mrd_deficiency',
    'approve',
    'phi',
    'high',
    'Waive a deficiency that will never be completed. Separated from resolving it: a waiver is a clinical-governance decision.',
    { requiresReason: true },
  ),
  p('mrd.coding.list', 'mrd_coding', 'list', 'phi', 'low', 'See the coding worklist and its ageing.', {
    phiRead: true,
  }),
  p(
    'mrd.coding.assign',
    'mrd_coding',
    'assign',
    'phi',
    'low',
    'Assign records in the coding queue to a coder.',
  ),
  p(
    'mrd.coding.code',
    'mrd_coding',
    'update',
    'phi',
    'medium',
    'Assign principal and secondary codes, procedures and DRG to a record.',
  ),
  p(
    'mrd.coding.qa',
    'mrd_coding_qa',
    'review',
    'phi',
    'high',
    'Audit a coder’s work. Segregated from `mrd.coding.code`: nobody passes their own coding QA (docs/05 §Permission catalogue conventions).',
  ),
  p(
    'mrd.coding.query.answer',
    'mrd_coding_query',
    'update',
    'phi',
    'low',
    'Answer a coder’s clinical query from the doctor inbox, optionally amending the note.',
  ),
  p(
    'mrd.scan.operate',
    'mrd_scan_batch',
    'create',
    'phi',
    'low',
    'Scan or upload paper documents into a record and index their OCR text.',
  ),
  p(
    'mrd.scan.qa',
    'mrd_scan_batch',
    'review',
    'phi',
    'medium',
    'Check a scan batch for legibility, page count and correct patient attribution before it is committed.',
  ),
  p(
    'mrd.search',
    'mrd_record',
    'list',
    'phi',
    'medium',
    'Full-text search across record content and OCR text. Audited with the query and the result count, never the identifiers.',
    { phiRead: true },
  ),
  p(
    'mrd.legal_hold.set',
    'mrd_legal_hold',
    'update',
    'phi',
    'critical',
    'Place a record under legal hold. Blocks archival, destruction and deletion until released.',
    { requiresReason: true, sensitiveGrant: true },
  ),
  p(
    'mrd.legal_hold.release',
    'mrd_legal_hold',
    'update',
    'phi',
    'critical',
    'Release a legal hold. The one action that can make a medico-legal record destructible again.',
    { requiresReason: true, requiresStepUp: true, sensitiveGrant: true },
  ),
  p(
    'mrd.retention.manage',
    'mrd_retention_policy',
    'configure',
    'phi',
    'high',
    'Configure retention policies and propose a destruction run. Proposing is never approving (docs/05 §Segregation of duties).',
    { requiresReason: true },
  ),
  p(
    'mrd.destruction.approve',
    'mrd_destruction_run',
    'approve',
    'phi',
    'critical',
    'Approve a destruction run. Two distinct approvers, neither of whom proposed it; the records do not come back.',
    {
      requiresReason: true,
      requiresStepUp: true,
      requiresSecondPerson: true,
      sensitiveGrant: true,
    },
  ),
  p(
    'mrd.report.read',
    'mrd_report',
    'read',
    'operational',
    'low',
    'Read MRD completeness, coding productivity, deficiency ageing and retention reports.',
  ),
  p(
    'mrd.configure',
    'mrd_config',
    'configure',
    'operational',
    'medium',
    'Configure deficiency rules, numbering, sensitivity classes and scan categories.',
  ),
]);

// OP-019 — Doctor PWA (mobile surface over the same OP-002 keys)
const OP019 = group('OP-019', 2, [
  p(
    'mobile.sync',
    'mobile_sync',
    'run',
    'phi',
    'medium',
    'Push queued offline mutations and pull the delta. Conflicts are reported, never silently resolved.',
  ),
  p(
    'mobile.offline_rx',
    'mobile_offline_rx',
    'create',
    'phi',
    'high',
    'Compose a prescription offline for server-side CDSS re-validation on sync. Withheld from residents (OP-019 §12).',
  ),
  p(
    'auth.device.manage',
    'own_device',
    'manage',
    'security',
    'medium',
    'Register, name and revoke the user’s own devices, including biometric unlock enrolment.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — Diagnostics (LIS, analyzer interfacing, lab quality, RIS, PACS,
// investigation console)
//
// Keys come from the §12 Permissions section of OP-004, EN-004, EN-031, OP-008,
// EN-008 and OP-022. EN-035 §12 declares no keys of its own ("Relevant keys live
// in their owning modules"), so where its prose uses a different spelling for
// somebody else's key (`rad.exam.perform`, `pacs.study.view`, `pacs.mwl.manage`)
// the owning module's spelling is the one registered — a second spelling would
// be a second authorisation decision for the same action.
// ─────────────────────────────────────────────────────────────────────────────

/** OP-004 — Laboratory Information System. */
const OP004 = group('OP-004', 3, [
  p(
    'lab.order.create',
    'lab_order',
    'create',
    'phi',
    'medium',
    'Raise a laboratory order, including a walk-in order taken at the front desk.',
  ),
  p(
    'lab.order.list',
    'lab_order',
    'list',
    'phi',
    'low',
    'List laboratory orders and the reception worklist.',
    {
      phiRead: true,
    },
  ),
  p('lab.order.read', 'lab_order', 'read', 'phi', 'low', 'Open one laboratory order and its test lines.', {
    phiRead: true,
  }),
  p(
    'lab.order.addon',
    'lab_order',
    'create',
    'phi',
    'medium',
    'Add a test to an order whose sample is already in the laboratory, within the sample stability window.',
  ),
  p(
    'lab.order.cancel',
    'lab_order',
    'cancel',
    'phi',
    'medium',
    'Cancel an order or a test line. OP-004 §5 reverses the charge only before a result exists, so the reason is the audit trail.',
    { requiresReason: true },
  ),

  p(
    'lab.sample.label',
    'lab_sample',
    'label',
    'phi',
    'low',
    'Print and reprint barcode sample labels with container guidance (EN-013).',
  ),
  p(
    'lab.sample.collect',
    'lab_sample',
    'collect',
    'phi',
    'medium',
    'Confirm collection after the two-identifier check. OP-004 §5 forbids a manual "collected" without a scan except under an audited printer-failure override.',
  ),
  p(
    'lab.sample.reject',
    'lab_sample',
    'reject',
    'phi',
    'medium',
    'Reject a sample against a coded reason, which triggers a zero-charge recollection order and notifies the ward and the patient.',
    { requiresReason: true },
  ),
  p(
    'lab.sample.receive',
    'lab_sample',
    'receive',
    'phi',
    'medium',
    'Receive and accession a sample at the laboratory, starting the routine TAT clock.',
  ),
  p(
    'lab.sample.custody',
    'lab_sample_custody',
    'record',
    'phi',
    'high',
    'Record a chain-of-custody handover for a medico-legal sample. Each link names both people and survives into evidence.',
    { requiresReason: true, phiRead: true },
  ),
  p(
    'lab.sample.update',
    'lab_sample',
    'update',
    'phi',
    'medium',
    'Correct sample attributes and resend the sample to an instrument worklist (EN-004 §12).',
    { requiresReason: true },
  ),

  p(
    'lab.result.enter',
    'lab_result',
    'enter',
    'phi',
    'medium',
    'Enter or edit an unverified result at the bench. Segregated from validation: docs/05 requires enterer ≠ validator.',
  ),
  p(
    'lab.result.verify',
    'lab_result',
    'verify',
    'phi',
    'medium',
    'Technical verification — the first of OP-004 §5’s two levels. The service additionally refuses to let a user verify their own entry.',
  ),
  p(
    'lab.result.validate',
    'lab_result',
    'validate',
    'phi',
    'high',
    'Clinical authorisation of a result, which releases it. For a critical result OP-004 §5 and D-10 require the documented read-back, or a documented "clinician unreachable — escalated" entry, first.',
  ),
  p(
    'lab.result.amend',
    'lab_result',
    'amend',
    'phi',
    'high',
    'Amend an authorised result. Never an overwrite: a new version is written and everyone already notified is re-notified.',
    { requiresReason: true },
  ),
  p('lab.result.read', 'lab_result', 'read', 'phi', 'medium', 'Read laboratory results for a patient.', {
    phiRead: true,
  }),
  p(
    'lab.result.sensitive.read',
    'lab_result_sensitive',
    'read',
    'phi',
    'critical',
    'Read results the hospital has flagged confidential — HIV, other serology, genetic and molecular tests. OP-004 §5 restricts these, bars them from SMS/WhatsApp and attaches a counselling flag; the treating clinician receives this key only as an explicit, named grant.',
    { sensitiveGrant: true, requiresReason: true, requiresStepUp: true, phiRead: true },
  ),

  p(
    'lab.critical.notify',
    'lab_critical_value',
    'notify',
    'phi',
    'critical',
    'Raise a critical-value alert and record the call-back — who called whom, when, and whether read-back was confirmed. EN-040 §5 exempts it from every licence check: a hospital in arrears still gets its panic-value loop.',
    { clinicalSafetyExempt: true, phiRead: true },
  ),
  p(
    'lab.critical.read',
    'lab_critical_value',
    'read',
    'phi',
    'high',
    'See the critical-value alert and its acknowledgement state. Exempt from licence gating for the same reason as `lab.critical.notify` — an alert nobody can open is not an alert.',
    { clinicalSafetyExempt: true, phiRead: true },
  ),

  p(
    'lab.report.generate',
    'lab_report',
    'generate',
    'phi',
    'medium',
    'Produce the branded report PDF with its QR verification block, including cumulative and serial reports.',
  ),
  p('lab.report.print', 'lab_report', 'print', 'phi', 'medium', 'Print a laboratory report at a counter.', {
    phiRead: true,
  }),
  p(
    'lab.report.deliver',
    'lab_report',
    'deliver',
    'phi',
    'medium',
    'Hand over or send a report — portal, WhatsApp, email, counter — and record the delivery evidence.',
    { phiRead: true },
  ),
  p(
    'lab.report.export',
    'lab_report',
    'export',
    'phi',
    'high',
    'Export laboratory reports in bulk. PHI leaves the building, so docs/05 §Data classes makes it an audited, reasoned action.',
    { requiresReason: true, requiresStepUp: true, phiRead: true },
  ),
  p(
    'lab.report.read',
    'lab_report',
    'read',
    'phi',
    'low',
    'Read released laboratory reports and the TAT / rejection KPIs built from them.',
    { phiRead: true },
  ),

  p(
    'lab.outsource.manage',
    'lab_outsource',
    'manage',
    'operational',
    'medium',
    'Configure referral laboratories and dispatch, track and receive outsourced tests. The partner’s NABL scope decides whether the hospital logo may appear on the report.',
  ),
  p(
    'lab.master.configure',
    'lab_master',
    'configure',
    'operational',
    'high',
    'Maintain the test catalogue, panels, specimen types, reference ranges, critical limits, delta rules and TAT targets. Ranges are effective-dated, so a change never rewrites a historical report.',
    { requiresReason: true },
  ),
]);

/**
 * EN-004 — Lab machine integration.
 *
 * EN-004 §12 decomposes quality control into `configure | record | read | unlock`
 * where OP-004 §12 writes the coarser `lab.qc.manage|read`. The decomposition is
 * registered and the coarse form is not: two keys meaning the same thing would be
 * two authorisation decisions for one action, and the bench (`record`) and the
 * quality manager (`configure`, `unlock`) are exactly the split that matters.
 */
const EN004 = group('EN-004', 3, [
  p(
    'lab.instrument.manage',
    'lab_instrument',
    'manage',
    'operational',
    'high',
    'Onboard and maintain analyzers: instrument master, test mapping, lifecycle (verification → live → out of service).',
  ),
  p(
    'lab.instrument.downtime.record',
    'lab_instrument_downtime',
    'record',
    'operational',
    'low',
    'Open and close an analyzer downtime window so the uptime KPI and the "analyzer down" board note are true.',
  ),
  p(
    'lab.interface.errors.resolve',
    'lab_if_error',
    'resolve',
    'phi',
    'high',
    'Work the interface error queue — unmatched, unmapped and patient-mismatch results. EN-004 §5 forbids matching by name similarity, so resolution is always an explicit human assignment.',
    { requiresReason: true, phiRead: true },
  ),
  p(
    'lab.autoval.configure',
    'lab_autoval_ruleset',
    'configure',
    'operational',
    'high',
    'Author an auto-validation rule set. EN-004 §5 keeps STAT, ICU, paediatric, critical, delta and QC-hold results off the automatic path unless explicitly configured.',
    { requiresReason: true },
  ),
  p(
    'lab.autoval.approve',
    'lab_autoval_ruleset',
    'approve',
    'operational',
    'high',
    'Quality-manager approval of an auto-validation rule set before it can be signed into service.',
  ),
  p(
    'lab.autoval.sign',
    'lab_autoval_ruleset',
    'sign',
    'operational',
    'critical',
    'Pathologist signature that puts an auto-validation rule set live. EN-004 §5 requires the approver and the signatory to be different people.',
    { sensitiveGrant: true, requiresStepUp: true },
  ),
  p(
    'lab.qc.configure',
    'lab_qc',
    'configure',
    'operational',
    'high',
    'Configure instrument QC: control lots, targets, schedules and the Westgard rule set per analyte.',
  ),
  p('lab.qc.record', 'lab_qc', 'record', 'operational', 'low', 'Record a QC run result at the bench.'),
  p(
    'lab.qc.read',
    'lab_qc',
    'read',
    'operational',
    'low',
    'Read QC state, Levey-Jennings charts and lockouts for an analyte and instrument.',
  ),
  p(
    'lab.qc.unlock',
    'lab_qc_lockout',
    'unlock',
    'operational',
    'high',
    'Lift an analyte × instrument lockout after passing QC and a recorded corrective action. Releasing patient results past an out-of-control run is a different key — `labq.qc.release_override`.',
    { requiresReason: true },
  ),
  p(
    'integration.lab.configure',
    'lab_interface',
    'configure',
    'operational',
    'high',
    'Configure analyzer drivers, MLLP/ASTM endpoints, middleware routing and LOINC mapping.',
    { sensitiveGrant: true },
  ),
  p(
    'integration.lab.read',
    'lab_interface',
    'read',
    'operational',
    'low',
    'Read the interface message log metadata, instrument status board and uptime dashboard.',
  ),
  p(
    'integration.lab.raw.read',
    'lab_interface_raw',
    'read',
    'phi',
    'high',
    'Open the raw HL7/ASTM message body. The wire format carries patient identifiers, so every open writes a PHI-read audit row.',
    { requiresReason: true, phiRead: true },
  ),
  p(
    'integration.lab.replay',
    'lab_interface',
    'replay',
    'phi',
    'high',
    'Replay buffered or failed analyzer messages after downtime. Idempotency is by message hash and control id, so a replay cannot double-post a result.',
    { requiresReason: true },
  ),
  p(
    'integration.lab.send',
    'lab_interface',
    'send',
    'operational',
    'medium',
    'Push an order worklist to an analyzer. Held by the interface service account, not by a person.',
  ),
  p(
    'integration.lab.ingest',
    'lab_interface',
    'ingest',
    'phi',
    'medium',
    'Accept an inbound analyzer result message. Held by a paired instrument or gateway token, never by a person (OP-004 §12).',
  ),
]);

/**
 * EN-031 — NABL integration / lab quality.
 *
 * `labq.*` is the accreditation management system: control materials, EQA,
 * method validation, competency, environment, non-conformity and the audit pack.
 * `lab.qc.*` (EN-004) is the day-to-day gate at the bench. They meet at one
 * place — an out-of-control analyte blocks release, and `labq.qc.release_override`
 * is the only lawful way past it.
 */
const EN031 = group('EN-031', 3, [
  p(
    'labq.qc.read',
    'labq_qc',
    'read',
    'operational',
    'low',
    'Read QC runs, Levey-Jennings charts, lot boundaries and out-of-control state.',
  ),
  p(
    'labq.qc.enter',
    'labq_qc_run',
    'enter',
    'operational',
    'low',
    'Enter a QC run result. EN-031 §5 forbids deletion — a mistaken entry is voided, with a reason, and stays visible on the chart.',
  ),
  p(
    'labq.qc.manage',
    'labq_qc',
    'manage',
    'operational',
    'high',
    'Maintain control materials, lots, schedules, Westgard configuration and lot-changeover parallel testing.',
  ),
  p(
    'labq.qc.approve',
    'labq_qc_target',
    'approve',
    'operational',
    'high',
    'Approve laboratory-derived QC targets, which replace the manufacturer’s provisional values after ≥20 runs over ≥20 days. Director-level; the bench that produced the runs does not approve them.',
    { sensitiveGrant: true },
  ),
  p(
    'labq.qc.void',
    'labq_qc_run',
    'void',
    'operational',
    'medium',
    'Void a mistaken QC point. The point remains on the chart marked void — EN-031 §5 allows no deletion.',
    { requiresReason: true },
  ),
  p(
    'labq.qc.action',
    'labq_qc_action',
    'record',
    'operational',
    'medium',
    'Record the corrective action and root cause for an out-of-control run, and the impact assessment on patient results already released.',
    { requiresReason: true },
  ),
  p(
    'labq.qc.release_override',
    'labq_qc_release',
    'override',
    'phi',
    'critical',
    'Authorise release of patient results for an analyte that is out of control or has a missed QC schedule. EN-031 §5 makes this the single lawful exception to the release gate: Lab Director only, recorded in the QC action log with a reason, audited, and reported to management every month.',
    { sensitiveGrant: true, requiresReason: true, requiresStepUp: true },
  ),
  p(
    'labq.eqa.manage',
    'labq_eqa',
    'manage',
    'operational',
    'medium',
    'Enrol in EQA/PT programmes, record cycles, submit results and track Z-scores. An in-scope analyte with no enrolment is a blocking readiness gap.',
  ),
  p(
    'labq.validation.manage',
    'labq_method_validation',
    'manage',
    'operational',
    'medium',
    'Run and document method validation or verification, including precision, trueness, linearity and measurement uncertainty.',
  ),
  p(
    'labq.validation.approve',
    'labq_method_validation',
    'approve',
    'operational',
    'high',
    'Director approval of a method validation, which is what makes a test orderable as an accredited test in OP-004.',
    { sensitiveGrant: true },
  ),
  p(
    'labq.equipment.manage',
    'labq_equipment',
    'manage',
    'operational',
    'medium',
    'Record instrument calibration, qualification and requalification after repair, relocation or software upgrade.',
  ),
  p(
    'labq.environment.manage',
    'labq_environment',
    'manage',
    'operational',
    'low',
    'Log temperature, humidity and storage monitoring, and close an excursion with its impact assessment on stored materials.',
  ),
  p(
    'labq.competency.manage',
    'labq_competency',
    'manage',
    'hr',
    'high',
    'Maintain competency and training records. An expired competency withdraws a technician’s authority to enter or verify results for that analyte, so this key changes who may touch a patient result.',
    { sensitiveGrant: true },
  ),
  p(
    'labq.checklist.manage',
    'labq_checklist',
    'manage',
    'operational',
    'medium',
    'Maintain the ISO 15189 / NABL 112 clause checklist and its evidence links.',
  ),
  p(
    'labq.accreditation.manage',
    'labq_accreditation',
    'manage',
    'operational',
    'high',
    'Maintain the accreditation scope — certificate, validity, and which tests are in scope. Scope decides whether the NABL logo may appear on a report.',
  ),
  p(
    'labq.indicator.review',
    'labq_indicator',
    'review',
    'operational',
    'low',
    'Review the quality indicators — TAT, rejection rate, repeat rate, critical-value communication — against their targets.',
  ),
  p(
    'labq.nc.manage',
    'labq_nonconformity',
    'manage',
    'operational',
    'medium',
    'Raise, investigate and close non-conformities with root cause, CAPA and effectiveness verification.',
  ),
  p(
    'labq.review.sign',
    'labq_review',
    'sign',
    'operational',
    'high',
    'Sign the monthly QC, indicator and management reviews. EN-031 §5: an unsigned month is a gap in the evidence, not a formality.',
    { requiresStepUp: true },
  ),
  p(
    'labq.auditpack.generate',
    'labq_auditpack',
    'generate',
    'operational',
    'medium',
    'Generate the audit-readiness pack for an assessment window.',
  ),
  p(
    'labq.assessor.grant',
    'labq_assessor',
    'grant',
    'security',
    'high',
    'Create the time-boxed, read-only assessor account. EN-031 §5 caps it at 14 days by default, scopes it to quality data and audits every access.',
    { sensitiveGrant: true, requiresReason: true },
  ),
  p(
    'labq.report.read',
    'labq_report',
    'read',
    'operational',
    'low',
    'Read the quality dashboards, readiness status and accreditation evidence.',
  ),
]);

/** OP-008 — Radiology & imaging: orders, schedule, exams, dose, reports. */
const OP008 = group('OP-008', 3, [
  p(
    'rad.order.create',
    'rad_order',
    'create',
    'phi',
    'medium',
    'Raise an imaging order with its clinical indication. OP-008 §5 makes the indication mandatory — an unjustified exposure is an AERB finding.',
  ),
  p('rad.order.read', 'rad_order', 'read', 'phi', 'low', 'Open one imaging order and its procedure lines.', {
    phiRead: true,
  }),
  p('rad.order.list', 'rad_order', 'list', 'phi', 'low', 'List imaging orders and the radiology worklist.', {
    phiRead: true,
  }),
  p(
    'rad.order.update',
    'rad_order',
    'update',
    'phi',
    'medium',
    'Update an order: protocol, contrast decision, pregnancy and safety screening, laterality correction.',
  ),
  p(
    'rad.order.cancel',
    'rad_order',
    'cancel',
    'phi',
    'medium',
    'Cancel an imaging order. OP-008 §5 requires approval for cancellation after acquisition, because the exposure already happened.',
    { requiresReason: true },
  ),
  p(
    'rad.schedule.manage',
    'rad_appointment',
    'manage',
    'operational',
    'medium',
    'Book, move and cancel modality slots, and issue the preparation instructions that go to the patient.',
  ),
  p(
    'rad.study.complete',
    'rad_exam',
    'complete',
    'phi',
    'medium',
    'Technologist acquisition workflow: exam started and completed, retakes with reason, contrast administered. EN-035 §12 calls the same action `rad.exam.perform`; this is the registered spelling.',
  ),
  p(
    'rad.study.reconcile',
    'rad_study',
    'reconcile',
    'phi',
    'high',
    'Attach an unmatched or manually-entered study to the right patient and accession. EN-008 §5 forbids silent matching, so this is always a named human decision; EN-008 §12 calls the same action `rad.pacs.reconcile`.',
    { requiresReason: true, phiRead: true },
  ),
  p(
    'rad.dose.record',
    'rad_dose',
    'record',
    'phi',
    'medium',
    'Record radiation dose from RDSR, DICOM header or manual entry. OP-008 §5 will not close an ionising order without one.',
  ),
  p(
    'rad.dose.read',
    'rad_dose',
    'read',
    'phi',
    'low',
    'Read per-study and cumulative patient dose, DRL comparison and the AERB dose register.',
    { phiRead: true },
  ),
  p(
    'rad.report.create',
    'rad_report',
    'create',
    'phi',
    'medium',
    'Draft a radiology report against a structured template. Drafting is not signing — a resident stops here.',
  ),
  p(
    'rad.report.preliminary',
    'rad_report_preliminary',
    'publish',
    'phi',
    'high',
    'Issue a preliminary read, visibly flagged as preliminary. The final report overrides it and the pair stays in the version history.',
  ),
  p(
    'rad.report.sign',
    'rad_report',
    'sign',
    'phi',
    'high',
    'Sign a radiology report. OP-008 §5 admits only radiologists with a valid registration — and a valid PC-PNDT registration for obstetric ultrasound. The technologist who performed the exam never holds this.',
    { requiresStepUp: true },
  ),
  p(
    'rad.report.amend',
    'rad_report',
    'amend',
    'phi',
    'high',
    'Amend or append to a signed report. A new immutable version, never an edit, and everyone already notified is re-notified.',
    { requiresReason: true },
  ),
  p(
    'rad.report.deliver',
    'rad_report',
    'deliver',
    'phi',
    'medium',
    'Deliver a report to the portal, referring doctor, WhatsApp or email, and record the delivery evidence.',
    { phiRead: true },
  ),
  p('rad.report.print', 'rad_report', 'print', 'phi', 'medium', 'Print a radiology report at a counter.', {
    phiRead: true,
  }),
  p(
    'rad.report.read',
    'rad_report',
    'read',
    'phi',
    'low',
    'Read radiology reports and the TAT, repeat-rate and utilisation KPIs built from them.',
    { phiRead: true },
  ),
  p(
    'rad.critical.notify',
    'rad_critical_finding',
    'notify',
    'phi',
    'critical',
    'Raise a critical or significant imaging finding and record the read-back call-back. EN-040 §5 exempts it from every licence check — the same rule that protects the lab panic-value loop protects this one.',
    { clinicalSafetyExempt: true, phiRead: true },
  ),
  p(
    'rad.critical.read',
    'rad_critical_finding',
    'read',
    'phi',
    'high',
    'See the critical-finding alert and whether it has been acknowledged. Exempt from licence gating: an alert nobody can open is not an alert.',
    { clinicalSafetyExempt: true, phiRead: true },
  ),
  p(
    'rad.peer_review.create',
    'rad_peer_review',
    'create',
    'phi',
    'medium',
    'Record a peer review or QA sampling score against another radiologist’s report.',
  ),
  p(
    'rad.peer_review.read',
    'rad_peer_review',
    'read',
    'phi',
    'medium',
    'Read peer-review outcomes and discrepancy rates.',
    { phiRead: true },
  ),
  p(
    'rad.pnpdt.manage',
    'rad_form_f',
    'manage',
    'phi',
    'critical',
    'Complete and sign the PC-PNDT Form F register and its monthly returns. This is criminal law, not paperwork: the Act makes the recording clinician personally liable, and no field anywhere in the product records foetal sex.',
    { sensitiveGrant: true, requiresReason: true, requiresStepUp: true, phiRead: true },
  ),
  p(
    'rad.configure',
    'rad_configuration',
    'configure',
    'operational',
    'high',
    'Configure modality rooms, AERB licences, QA due dates, dose k-factors and DRL thresholds. An expired licence blocks the room for scheduling.',
  ),
  p(
    'integration.rad.mpps',
    'rad_mpps',
    'ingest',
    'phi',
    'medium',
    'Accept a Modality Performed Procedure Step message, which moves an exam to in-progress or completed without a technologist keystroke. Held by a device token.',
  ),
  p(
    'integration.rad.study',
    'rad_study_feed',
    'ingest',
    'phi',
    'medium',
    'Accept a study-availability notification from the archive. Held by a device or service token, never by a person.',
  ),
]);

/**
 * EN-008 — PACS integration & DICOM viewer.
 *
 * Two of these keys carry a scope the catalogue cannot express, so it is stated
 * here and enforced by ABAC (`packages/contracts/src/rbac/abac.ts`), not by the
 * key: `rad.image.view` is care-team-scoped with break-glass on a recorded
 * reason, and `rad.telerad.read` is assigned-studies-only for an external
 * partner. Holding the key is necessary and never sufficient.
 */
const EN008 = group('EN-008', 3, [
  p(
    'rad.mwl.manage',
    'rad_mwl',
    'manage',
    'phi',
    'medium',
    'Publish, refresh and remove modality worklist entries. OP-008 §12 names the same key; EN-035 §2 puts MWL publication in EN-008, which is why it is registered here.',
  ),
  p(
    'rad.mwl.read',
    'rad_mwl',
    'read',
    'phi',
    'low',
    'Read the modality worklist as served to the scanners, for troubleshooting a modality that shows no patients.',
    { phiRead: true },
  ),
  p(
    'rad.study.read',
    'rad_study',
    'read',
    'phi',
    'low',
    'List and open study metadata. Care-team scoped by ABAC; break-glass outside the care team requires a recorded reason.',
    { phiRead: true },
  ),
  p(
    'rad.image.view',
    'rad_image',
    'view',
    'phi',
    'high',
    'Open images in the viewer. Scope is enforced by ABAC, not by this key: care-team-only by default, break-glass on a recorded reason, and every view is written to the PACS access audit (EN-008 §5).',
    { phiRead: true },
  ),
  p(
    'rad.image.annotate',
    'rad_image',
    'annotate',
    'phi',
    'medium',
    'Add measurements, key images and annotations. Originals are immutable — annotations are stored beside the pixels, never in them.',
  ),
  p(
    'rad.image.upload',
    'rad_image',
    'upload',
    'phi',
    'medium',
    'Import outside images or push acquired images into the archive.',
  ),
  p(
    'rad.image.share',
    'rad_image',
    'share',
    'phi',
    'high',
    'Create an expiring, OTP-protected share link for a study. EN-008 §5 requires patient or guardian consent, caps the link at 7 days and 10 views by default, and makes it revocable.',
    { requiresReason: true, phiRead: true },
  ),
  p(
    'rad.image.export',
    'rad_image',
    'export',
    'phi',
    'high',
    'Export a study as a DICOM ZIP or burn it to CD/DVD. Images leave the building, so the recipient, the ID proof and the reason are all recorded.',
    { requiresReason: true, requiresStepUp: true, phiRead: true },
  ),
  p(
    'rad.telerad.manage',
    'rad_teleradiology',
    'manage',
    'phi',
    'high',
    'Configure tele-radiology partners and assign studies out for reading, with the SLA clock that comes with it.',
    { sensitiveGrant: true },
  ),
  p(
    'rad.telerad.read',
    'rad_teleradiology',
    'read',
    'phi',
    'high',
    'External radiologist access to studies assigned for reading. ABAC restricts it to assigned studies only, with MFA and an optional IP allowlist (EN-008 §5); the key alone grants nothing.',
    { phiRead: true },
  ),
  p(
    'rad.pacs.configure',
    'pacs_server',
    'configure',
    'operational',
    'high',
    'Configure the archive: AE titles, modality registrations, storage tiers, routing rules and replication.',
    { sensitiveGrant: true },
  ),
  p(
    'rad.pacs.read',
    'pacs_server',
    'read',
    'operational',
    'low',
    'Read archive health: modality status, storage tiers, replication lag and purge history.',
  ),
  p(
    'rad.pacs.retention',
    'pacs_retention',
    'manage',
    'operational',
    'critical',
    'Set image retention policy and approve a purge run. EN-008 §5 requires two approvals, never purges medico-legal or legal-hold studies, and keeps minors until 18 + 3 years. Purged pixels do not come back.',
    { sensitiveGrant: true, requiresSecondPerson: true, requiresReason: true, requiresStepUp: true },
  ),
  p(
    'rad.ai.read',
    'rad_ai_result',
    'read',
    'phi',
    'medium',
    'Read AI triage output attached to a study. EN-008 §5 makes it advisory and marks it `AI-preliminary`; no report is ever auto-finalised from it.',
    { phiRead: true },
  ),
  p(
    'rad.mlc.read',
    'rad_mlc_study',
    'read',
    'phi',
    'high',
    'Open a study flagged medico-legal. EN-008 §5 puts MLC studies behind their own key so that access to them is a deliberate, separately auditable grant.',
    { requiresReason: true, phiRead: true },
  ),
]);

/** OP-022 — Investigation report console: ECG, endoscopy, PFT and outside reports. */
const OP022 = group('OP-022', 3, [
  p(
    'invest.worklist.read',
    'investigation_worklist',
    'read',
    'phi',
    'low',
    'Read the investigation worklist for a service, room or station.',
    { phiRead: true },
  ),
  p(
    'invest.schedule.manage',
    'investigation_schedule',
    'manage',
    'operational',
    'medium',
    'Schedule, check in and reschedule investigation studies.',
  ),
  p(
    'invest.study.manage',
    'investigation_study',
    'manage',
    'phi',
    'medium',
    'Run the study: start, complete, abandon with reason, and record the identity verification that preceded it.',
  ),
  p(
    'invest.media.create',
    'investigation_media',
    'create',
    'phi',
    'medium',
    'Upload strips, images, traces and outside PDFs against a study. OP-022 §5 quarantines an orphan upload rather than guessing whose it is.',
  ),
  p(
    'invest.media.read',
    'investigation_media',
    'read',
    'phi',
    'low',
    'View investigation media through short-lived presigned URLs.',
    { phiRead: true },
  ),
  p(
    'invest.media.manage',
    'investigation_media',
    'manage',
    'phi',
    'high',
    'Detach or move media between studies. Originals are never deleted — the move is versioned and reasoned.',
    { requiresReason: true },
  ),
  p(
    'invest.media.annotate',
    'investigation_media',
    'annotate',
    'phi',
    'medium',
    'Annotate and measure on media without altering the original.',
  ),
  p(
    'invest.media.export',
    'investigation_media',
    'export',
    'phi',
    'high',
    'Export investigation media. Exports are watermarked and audited.',
    { requiresReason: true, phiRead: true },
  ),
  p(
    'invest.report.create',
    'investigation_report',
    'create',
    'phi',
    'medium',
    'Draft an investigation report from a template.',
  ),
  p(
    'invest.report.update',
    'investigation_report',
    'update',
    'phi',
    'medium',
    'Edit an unsigned investigation report draft.',
  ),
  p(
    'invest.report.read',
    'investigation_report',
    'read',
    'phi',
    'low',
    'Read investigation reports and the TAT and co-sign KPIs built from them.',
    { phiRead: true },
  ),
  p(
    'invest.report.sign',
    'investigation_report',
    'sign',
    'phi',
    'high',
    'Sign and release an investigation report. OP-022 §5 blocks the signature on a service marked `cosign_required` unless the signer is the consultant.',
    { requiresStepUp: true },
  ),
  p(
    'invest.report.cosign',
    'investigation_report',
    'cosign',
    'phi',
    'high',
    'Consultant co-signature that finalises a resident’s report. This is the key a resident does not hold, which is what makes co-sign mean anything.',
    { requiresStepUp: true },
  ),
  p(
    'invest.report.amend',
    'investigation_report',
    'amend',
    'phi',
    'high',
    'Amend a signed investigation report as a new version, with the reason on the version.',
    { requiresReason: true },
  ),
  p(
    'invest.report.critical',
    'investigation_report_critical',
    'notify',
    'phi',
    'critical',
    'Flag a critical investigation finding and record the communication. Same escalation loop and the same EN-040 §5 exemption as the lab and radiology critical paths — a licence state may never silence it.',
    { clinicalSafetyExempt: true, phiRead: true },
  ),
  p(
    'invest.report.deliver',
    'investigation_report',
    'deliver',
    'phi',
    'medium',
    'Release a report to the portal, the referrer or print, subject to the hospital’s release policy.',
    { phiRead: true },
  ),
  p(
    'invest.configure',
    'investigation_service',
    'configure',
    'operational',
    'high',
    'Configure investigation services: templates, co-sign requirement, PC-PNDT flag, TAT thresholds and release policy.',
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

  // Phase 2
  ...OP002,
  ...OP007,
  ...EN029,
  ...NC003,
  ...OP019,

  // Phase 3
  ...OP004,
  ...EN004,
  ...EN031,
  ...OP008,
  ...EN008,
  ...OP022,
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

  // Phase 2
  {
    permA: 'mrd.coding.code',
    permB: 'mrd.coding.qa',
    mode: 'block',
    reason:
      'A coder who audits their own coding is the only reviewer the claim will ever get (NC-003 §12, docs/05 §Segregation of duties).',
  },
  {
    permA: 'mrd.retention.manage',
    permB: 'mrd.destruction.approve',
    mode: 'block',
    reason:
      'Whoever proposes a destruction run must not approve it — NC-003 §12 requires two distinct approvers and the records do not come back.',
  },
  {
    permA: 'cdss.rule.manage',
    permB: 'cdss.rule.publish',
    mode: 'block',
    reason:
      'Authoring a rule and publishing it are the same hand only if nobody checks what every clinician in the hospital is about to be interrupted by (EN-029 §5).',
  },
  {
    permA: 'mrd.deficiency.resolve',
    permB: 'mrd.deficiency.waive',
    mode: 'warn',
    reason:
      'Resolving a deficiency means the content was supplied; waiving means it never will be. The same hand doing both turns the completeness indicator into self-assessment (NC-003 §12).',
  },

  // Phase 3
  {
    permA: 'lab.result.enter',
    permB: 'lab.result.validate',
    mode: 'block',
    reason:
      'docs/05 §Segregation of duties: "result enterer ≠ validator". OP-004 §5 makes release two-level, and a bench that authorises its own numbers has one level.',
  },
  {
    permA: 'labq.qc.enter',
    permB: 'labq.qc.release_override',
    mode: 'block',
    reason:
      'Whoever runs the QC must not be the person who authorises release past their own out-of-control run — EN-031 §5 reserves the override for the Lab Director and reports it monthly.',
  },
  {
    permA: 'labq.qc.enter',
    permB: 'labq.qc.approve',
    mode: 'block',
    reason:
      'EN-031 §5 replaces the manufacturer’s provisional targets with laboratory-derived ones from the bench’s own runs; the Director approves them, not the bench that produced them.',
  },
  {
    permA: 'rad.study.complete',
    permB: 'rad.report.sign',
    mode: 'block',
    reason:
      'A technologist does not sign a radiology report. OP-008 §5 admits only a registered radiologist, and the person who chose the exposure is not an independent reader of it.',
  },
  {
    permA: 'lab.autoval.configure',
    permB: 'lab.autoval.sign',
    mode: 'block',
    reason:
      'EN-004 §5: "rule set edits require QM approval + pathologist sign". One hand authoring and signing an auto-validation rule set means results are released automatically on nobody’s independent judgement.',
  },
  {
    permA: 'invest.report.create',
    permB: 'invest.report.cosign',
    mode: 'warn',
    reason:
      'A consultant legitimately drafts their own reports and co-signs a resident’s, so this cannot block — but OP-022 §5 requires the co-signature to come from someone other than the author, which the service enforces per report.',
  },
]);
