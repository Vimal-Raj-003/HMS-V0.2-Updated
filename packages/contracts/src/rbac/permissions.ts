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
  | 'cosign'
  // Phase 4 — the verbs the supply-chain specs actually use. A key whose last
  // segment is not its own action is a key nobody can grep for, so the verb
  // list grows rather than the keys being bent to fit it.
  | 'adjust'
  | 'apply'
  | 'close'
  | 'compare'
  | 'count'
  | 'explain'
  | 'import'
  | 'inspect'
  | 'map'
  | 'match'
  | 'pick'
  | 'plan'
  | 'post'
  | 'prepare'
  | 'putaway'
  | 'qc'
  | 'quarantine'
  | 'release'
  | 'reverse'
  | 'sell'
  | 'trace'
  | 'use';

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

// ═════════════════════════════════════════════════════════════════════════════
// Phase 4 — Pharmacy, Stores & Supply Chain
//
// Namespaces follow `docs/05 §Permission catalogue conventions`, which sanctions
// `pharmacy.*` and `inventory.*` and no separate `stores.*`, `purchase.*` or
// `procurement.*`. So purchase-to-pay, stores, consignment and consumption all
// live under `inventory.*`, split by resource, exactly as NC-005 §12, NC-006
// §12, NC-007 §12 and NC-008 §12 write them. Cost centres are `finance.*` and
// the vendor master is `vendor.*`, per those specs.
//
// Where a spec writes a key that does not end in its own verb — NC-005's
// `inventory.purchase.rfq`, NC-006's `inventory.item.params`, OP-003's bare
// `pharmacy.dispense` — the key here carries the verb (`inventory.rfq.create`,
// `inventory.item.params.configure`, `pharmacy.dispense.complete`). The shape
// rule in `registry.spec.ts` allows up to four segments, and a key whose last
// segment is not the action is a key nobody can grep for.
//
// ── The second-person rule, and why it shapes the keys ──────────────────────
//
// `docs/05 §ABAC` puts narcotics behind `requires_second_person`, and
// `docs/04 §1` requires "NDPS narcotic register with dual authorisation". The
// database already refuses a single-signature NDPS row.
//
// But a `requiresSecondPerson` key **cannot be used as a route decorator**:
// `services/api/src/core/policy/permission.decorator.ts` throws at module load
// if one is, because `PolicyGuard` evaluates without a co-signer and the route
// would then deny every user including the hospital administrator — silently,
// and looking correct in review. The established shape (see
// `frontoffice/cash/cosign.service.ts`) is: decorate the route with the
// *precondition* key the acting user genuinely holds, and assert the real
// authority inside the service with the co-signer attached.
//
// So each second-person key below names its decoratable precondition in its own
// description, and `phase4-grants.spec.ts` asserts that the precondition exists,
// is registered, and is not itself second-person. `pharmacy.narcotic.prepare`
// exists for exactly this: it is the "open a controlled-drug transaction"
// authority a single pharmacist has, and it is what the four co-signed routes
// are decorated with.
// ═════════════════════════════════════════════════════════════════════════════

// ── NC-006 — item master, stores and the stock ledger ────────────────────────
const NC006 = group('NC-006', 4, [
  p(
    'inventory.item.read',
    'item',
    'read',
    'operational',
    'low',
    'View one item in the master, with its UoM ladder, schedule flags and storage conditions.',
  ),
  p(
    'inventory.item.list',
    'item',
    'list',
    'operational',
    'low',
    'Search and page the item master. Held wherever `inventory.item.read` is: an id has to come from somewhere.',
  ),
  p(
    'inventory.item.create',
    'item',
    'create',
    'operational',
    'medium',
    'Add an item to the master. The base UoM chosen here is frozen the moment stock moves.',
  ),
  p(
    'inventory.item.update',
    'item',
    'update',
    'operational',
    'medium',
    'Change item master attributes, including the schedule and narcotic flags that drive every downstream refusal.',
  ),
  p(
    'inventory.item.import',
    'item',
    'import',
    'operational',
    'high',
    'Bulk-load or update the item master from a file. A bad import is a thousand wrong items, so it is a separate grant from single-item editing.',
    { requiresReason: true },
  ),
  p(
    'inventory.item.params.configure',
    'item_store_params',
    'configure',
    'operational',
    'medium',
    'Set per-store minimum, maximum, reorder, safety-stock and par levels, and the ABC-VED-FSN classification.',
  ),
  p(
    'inventory.item.gtin.map',
    'item_barcode',
    'map',
    'operational',
    'medium',
    'Map an unrecognised GS1 GTIN to an item, so the next scan of that pack resolves instead of stopping the counter.',
  ),
  p(
    'inventory.store.read',
    'store',
    'read',
    'operational',
    'low',
    'View a store, its sub-stores, bin locations and temperature zones.',
  ),
  p(
    'inventory.store.list',
    'store',
    'list',
    'operational',
    'low',
    'List the store hierarchy. Required to reach any store-scoped screen at all.',
  ),
  p(
    'inventory.store.configure',
    'store',
    'configure',
    'operational',
    'high',
    'Create stores and sub-stores and set their valuation method, negative-stock policy, narcotic designation and drug licence.',
  ),
  p(
    'inventory.stock.read',
    'stock_balance',
    'read',
    'operational',
    'low',
    'View on-hand quantity, batch, expiry and bin for a position.',
  ),
  p(
    'inventory.stock.list',
    'stock_balance',
    'list',
    'operational',
    'low',
    'Page and filter stock balances across a store — the stock-on-hand screen.',
  ),
  p(
    'inventory.stock.putaway',
    'stock_balance',
    'putaway',
    'operational',
    'low',
    'Assign received stock to a bin or rack location, including a temperature zone.',
  ),
  p(
    'inventory.ledger.read',
    'stock_ledger',
    'read',
    'operational',
    'medium',
    'Read the append-only stock ledger for one item, batch or document — the movement history behind a balance.',
  ),
  p(
    'inventory.ledger.list',
    'stock_ledger',
    'list',
    'operational',
    'medium',
    'Page the stock ledger across items and stores, which is how a movement is found in the first place.',
  ),
  p(
    'inventory.store_indent.create',
    'store_indent',
    'create',
    'operational',
    'low',
    'Raise an indent from a ward, theatre or department on its supplying store.',
  ),
  p(
    'inventory.store_indent.read',
    'store_indent',
    'read',
    'operational',
    'low',
    'View a store indent and the quantities approved against it.',
  ),
  p(
    'inventory.store_indent.list',
    'store_indent',
    'list',
    'operational',
    'low',
    'List store indents — the queue a store keeper works from and an indenter tracks.',
  ),
  p(
    'inventory.store_indent.approve',
    'store_indent',
    'approve',
    'operational',
    'medium',
    'Approve or reduce an indent before the store picks it.',
  ),
  p(
    'inventory.issue.pick',
    'pick_list',
    'pick',
    'operational',
    'low',
    'Work a pick list, confirming batches against the FEFO suggestion.',
  ),
  p(
    'inventory.issue.create',
    'issue',
    'create',
    'operational',
    'medium',
    'Issue stock out of a store against an indent, which posts the ledger movement.',
  ),
  p('inventory.issue.read', 'issue', 'read', 'operational', 'low', 'View an issue note and its lines.'),
  p(
    'inventory.issue.list',
    'issue',
    'list',
    'operational',
    'low',
    'List issue notes for a store or a receiving department.',
  ),
  p(
    'inventory.issue.receive',
    'issue',
    'receive',
    'operational',
    'low',
    'Acknowledge receipt of an issue at the destination, closing the in-transit balance.',
  ),
  p(
    'inventory.issue.emergency.create',
    'issue',
    'create',
    'operational',
    'high',
    'Issue stock without an approved indent in an emergency, which raises a post-facto approval.',
    { requiresReason: true },
  ),
  p(
    'inventory.return.create',
    'return_to_store',
    'create',
    'operational',
    'low',
    'Return unused stock from a ward or department to the issuing store.',
    { requiresReason: true },
  ),
  p(
    'inventory.return.read',
    'return_to_store',
    'read',
    'operational',
    'low',
    'View a return to store and the inspection outcome of its lines.',
  ),
  p(
    'inventory.return.list',
    'return_to_store',
    'list',
    'operational',
    'low',
    'List returns awaiting inspection or already inspected.',
  ),
  p(
    'inventory.return.inspect',
    'return_to_store',
    'inspect',
    'operational',
    'medium',
    'Inspect returned stock and decide whether it goes back on the shelf or into quarantine.',
  ),
  p(
    'inventory.transfer.create',
    'transfer',
    'create',
    'operational',
    'medium',
    'Raise an inter-store transfer.',
  ),
  p(
    'inventory.transfer.read',
    'transfer',
    'read',
    'operational',
    'low',
    'View a transfer, including what is currently in transit.',
  ),
  p(
    'inventory.transfer.list',
    'transfer',
    'list',
    'operational',
    'low',
    'List transfers in and out of a store.',
  ),
  p(
    'inventory.transfer.approve',
    'transfer',
    'approve',
    'operational',
    'medium',
    'Approve a transfer whose value is above the configured threshold.',
  ),
  p(
    'inventory.transfer.dispatch',
    'transfer',
    'dispatch',
    'operational',
    'medium',
    'Dispatch an approved transfer, moving the stock into the in-transit state.',
  ),
  p(
    'inventory.transfer.receive',
    'transfer',
    'receive',
    'operational',
    'medium',
    'Receive a transfer at the destination store and record any discrepancy against it.',
  ),
  p(
    'inventory.adjustment.create',
    'adjustment',
    'create',
    'financial',
    'high',
    'Raise a stock adjustment or write-off. The reason is mandatory: an unexplained adjustment is indistinguishable from a loss.',
    { requiresReason: true },
  ),
  p(
    'inventory.adjustment.read',
    'adjustment',
    'read',
    'financial',
    'low',
    'View an adjustment, its reason code and its approval trail.',
  ),
  p(
    'inventory.adjustment.list',
    'adjustment',
    'list',
    'financial',
    'low',
    'List adjustments awaiting approval or already posted.',
  ),
  p(
    'inventory.adjustment.approve',
    'adjustment',
    'approve',
    'financial',
    'high',
    'Approve a stock adjustment or write-off. The database refuses an approver who is the requester.',
    { requiresReason: true },
  ),
  p(
    'inventory.batch.read',
    'item_batch',
    'read',
    'operational',
    'low',
    'View a batch: its expiry, its status, its vendor and where its stock currently sits.',
  ),
  p(
    'inventory.batch.list',
    'item_batch',
    'list',
    'operational',
    'low',
    'List and search batches, including the near-expiry and quarantined working lists.',
  ),
  p(
    'inventory.batch.quarantine',
    'item_batch',
    'quarantine',
    'operational',
    'high',
    'Put a batch on hold across one store or all of them. Never licence-gated: pulling suspect stock off a shelf is a patient-safety action.',
    { requiresReason: true, clinicalSafetyExempt: true },
  ),
  p(
    'inventory.batch.release',
    'item_batch',
    'release',
    'operational',
    'high',
    'Release a quarantined batch back to usable stock, on a recorded decision.',
    { requiresReason: true },
  ),
  p(
    'inventory.batch.trace',
    'item_batch',
    'trace',
    'phi',
    'high',
    'Trace every unit of a batch: which store holds it, which department consumed it and which patients received it. Reads patient data, so it writes a READ_PHI row, and it is never licence-gated — a recall does not wait for an invoice.',
    { phiRead: true, clinicalSafetyExempt: true },
  ),
  p(
    'inventory.expiry.read',
    'item_batch',
    'read',
    'operational',
    'low',
    'View the near-expiry and expired working lists for a store.',
  ),
  p(
    'inventory.expiry.manage',
    'item_batch',
    'manage',
    'financial',
    'high',
    'Decide what happens to near-expiry and expired stock: return, transfer, discount, quarantine or write-off.',
    { requiresReason: true },
  ),
  p(
    'inventory.coldchain.read',
    'temp_zone',
    'read',
    'operational',
    'low',
    'View temperature zones, their live readings and their excursion history.',
  ),
  p(
    'inventory.coldchain.decide',
    'temp_excursion',
    'decide',
    'operational',
    'high',
    'Decide the fate of stock held through a temperature excursion: usable, quarantined or written off.',
    { requiresReason: true },
  ),
  p(
    'inventory.reorder.read',
    'reorder_suggestion',
    'read',
    'operational',
    'low',
    'View the reorder suggestions a replenishment run produced.',
  ),
  p(
    'inventory.reorder.manage',
    'reorder_suggestion',
    'manage',
    'operational',
    'medium',
    'Run the replenishment calculation and accept, amend or dismiss its suggestions.',
  ),
  p(
    'inventory.count.plan',
    'count_plan',
    'plan',
    'operational',
    'medium',
    'Plan a cycle, full, narcotic or spot count and generate its count sheets.',
  ),
  p(
    'inventory.count.count',
    'count_sheet',
    'count',
    'operational',
    'low',
    'Record physical counts against a count sheet. Deliberately separate from approving the variance it produces.',
  ),
  p(
    'inventory.count.approve',
    'count_plan',
    'approve',
    'financial',
    'high',
    'Approve count variances and post them to the ledger. `docs/05 §Segregation of duties` keeps this away from whoever counted.',
    { requiresReason: true },
  ),
  p(
    'inventory.count.read',
    'count_plan',
    'read',
    'operational',
    'low',
    'View a count plan, its sheets and its variances.',
  ),
  p(
    'inventory.count.list',
    'count_plan',
    'list',
    'operational',
    'low',
    'List count plans due, in progress and awaiting variance approval.',
  ),
  p(
    'inventory.analysis.read',
    'analysis',
    'read',
    'operational',
    'low',
    'View ABC-VED-FSN classifications, dead-stock and slow-mover analyses.',
  ),
  p(
    'inventory.analysis.run',
    'analysis',
    'run',
    'operational',
    'medium',
    'Recompute the ABC-VED-FSN classification, which changes count frequencies and reorder behaviour.',
  ),
  p(
    'inventory.valuation.read',
    'valuation_period',
    'read',
    'financial',
    'medium',
    'View stock valuation by store, period and method.',
  ),
  p(
    'inventory.valuation.close',
    'valuation_period',
    'close',
    'financial',
    'high',
    'Close a valuation period. Nothing may be back-dated into it afterwards without an approved adjustment naming it.',
    { requiresReason: true },
  ),
  p(
    'inventory.label.print',
    'label',
    'print',
    'operational',
    'low',
    'Print item, bin and batch labels carrying the GS1 item, batch and expiry identifiers.',
  ),
  p(
    'inventory.report.read',
    'report',
    'read',
    'operational',
    'low',
    'View stores and inventory reports: stock on hand, movement, expiry risk and consumption.',
  ),
  p(
    'inventory.export',
    'report',
    'export',
    'operational',
    'high',
    'Export inventory data out of the system. Reason mandatory: an export leaves the audit boundary.',
    { requiresReason: true },
  ),
  p(
    'inventory.fefo.override',
    'pick_list',
    'override',
    'operational',
    'high',
    'Pick a batch other than the first to expire. The reason is stored on the line, because a FEFO override is how stock quietly ages into a write-off.',
    { requiresReason: true },
  ),
  p(
    'inventory.negative_stock.override',
    'stock_balance',
    'override',
    'operational',
    'critical',
    'Post a movement that would take a position negative, in a store configured to allow it with approval. Never available where the store policy is `block`.',
    { requiresReason: true, requiresStepUp: true },
  ),
]);

// ── NC-005 — indent to payment ───────────────────────────────────────────────
const NC005 = group('NC-005', 4, [
  p(
    'inventory.indent.create',
    'pur_indent',
    'create',
    'financial',
    'low',
    'Raise a purchase indent on the purchase department.',
  ),
  p(
    'inventory.indent.read',
    'pur_indent',
    'read',
    'financial',
    'low',
    'View a purchase indent and its approval trail.',
  ),
  p(
    'inventory.indent.list',
    'pur_indent',
    'list',
    'financial',
    'low',
    'List purchase indents — the buyer’s inbox and the indenter’s tracker.',
  ),
  p(
    'inventory.indent.approve',
    'pur_indent',
    'approve',
    'financial',
    'medium',
    'Approve, part-approve or reject a purchase indent within the approver’s value band.',
    { requiresReason: true },
  ),
  p(
    'inventory.indent.cancel',
    'pur_indent',
    'cancel',
    'financial',
    'low',
    'Withdraw a purchase indent before it becomes an order.',
    { requiresReason: true },
  ),
  p(
    'inventory.rfq.create',
    'pur_rfq',
    'create',
    'commercial',
    'medium',
    'Build a request for quotation from approved indent lines.',
  ),
  p(
    'inventory.rfq.send',
    'pur_rfq',
    'send',
    'commercial',
    'medium',
    'Send a request for quotation to the selected vendors and open the response window.',
  ),
  p(
    'inventory.rfq.read',
    'pur_rfq',
    'read',
    'commercial',
    'low',
    'View a request for quotation, its lines and the vendors it went to.',
  ),
  p(
    'inventory.rfq.list',
    'pur_rfq',
    'list',
    'commercial',
    'low',
    'List requests for quotation, open and closed.',
  ),
  p(
    'inventory.quotation.enter',
    'pur_quotation',
    'enter',
    'commercial',
    'medium',
    'Record a vendor quotation received by email, post or portal.',
  ),
  p(
    'inventory.quotation.read',
    'pur_quotation',
    'read',
    'commercial',
    'medium',
    'View a vendor quotation and its line rates.',
  ),
  p(
    'inventory.quotation.list',
    'pur_quotation',
    'list',
    'commercial',
    'medium',
    'List the quotations received against a request.',
  ),
  p(
    'inventory.comparative.read',
    'pur_comparative',
    'read',
    'commercial',
    'medium',
    'View a comparative statement, its scoring and the quote it selected.',
  ),
  p(
    'inventory.comparative.list',
    'pur_comparative',
    'list',
    'commercial',
    'low',
    'List comparative statements awaiting approval. The approver of a comparative has to be able to find one.',
  ),
  p(
    'inventory.comparative.compare',
    'pur_comparative',
    'compare',
    'commercial',
    'medium',
    'Build the comparative statement and score the quotations against it.',
  ),
  p(
    'inventory.comparative.approve',
    'pur_comparative',
    'approve',
    'commercial',
    'high',
    'Approve a comparative and select the vendor. Selecting other than the lowest quote requires the justification the database already insists on.',
    { requiresReason: true },
  ),
  p(
    'inventory.rate_contract.read',
    'vnd_rate_contract',
    'read',
    'commercial',
    'low',
    'View a rate contract and the rates it fixes.',
  ),
  p(
    'inventory.rate_contract.list',
    'vnd_rate_contract',
    'list',
    'commercial',
    'low',
    'List rate contracts, including those approaching expiry.',
  ),
  p(
    'inventory.rate_contract.manage',
    'vnd_rate_contract',
    'manage',
    'commercial',
    'high',
    'Author and revise rate contracts, whose rates price purchase orders automatically.',
  ),
  p(
    'inventory.rate_contract.approve',
    'vnd_rate_contract',
    'approve',
    'commercial',
    'high',
    'Approve a rate contract into force.',
  ),
  p(
    'inventory.po.create',
    'pur_purchase_order',
    'create',
    'financial',
    'medium',
    'Raise a purchase order. Approving it is a separate key held by a different person.',
  ),
  p(
    'inventory.po.read',
    'pur_purchase_order',
    'read',
    'financial',
    'low',
    'View a purchase order and every version of it.',
  ),
  p(
    'inventory.po.list',
    'pur_purchase_order',
    'list',
    'financial',
    'low',
    'List purchase orders by vendor, store, status or value.',
  ),
  p(
    'inventory.po.approve',
    'pur_purchase_order',
    'approve',
    'financial',
    'high',
    'Approve a purchase order within the approver’s value band. `docs/04 §3`: maker is never checker on a PO.',
    { requiresStepUp: true },
  ),
  p(
    'inventory.po.send',
    'pur_purchase_order',
    'send',
    'financial',
    'medium',
    'Dispatch an approved purchase order to the vendor by email, portal or print.',
  ),
  p(
    'inventory.po.amend',
    'pur_purchase_order',
    'amend',
    'financial',
    'high',
    'Supersede a purchase order with a new version. The old version is frozen — the vendor holds a copy of it.',
    { requiresReason: true },
  ),
  p(
    'inventory.po.cancel',
    'pur_purchase_order',
    'cancel',
    'financial',
    'high',
    'Cancel a purchase order before receipt and release its commitment.',
    { requiresReason: true },
  ),
  p(
    'inventory.po.short_close',
    'pur_purchase_order',
    'close',
    'financial',
    'high',
    'Close a purchase order with quantity outstanding, accepting that the balance will never arrive.',
    { requiresReason: true },
  ),
  p(
    'inventory.grn.create',
    'pur_grn',
    'create',
    'financial',
    'medium',
    'Record a goods receipt, capturing batch, expiry and rejected quantity per line.',
  ),
  p(
    'inventory.grn.qc',
    'pur_grn',
    'qc',
    'operational',
    'medium',
    'Perform the quality check on a receipt and accept or reject each line with a coded reason.',
  ),
  p(
    'inventory.grn.post',
    'pur_grn',
    'post',
    'financial',
    'high',
    'Post an accepted goods receipt to the stock ledger, which is the moment the stock becomes ours.',
  ),
  p(
    'inventory.grn.reverse',
    'pur_grn',
    'reverse',
    'financial',
    'high',
    'Reverse a posted goods receipt with compensating ledger entries. Refused once the received stock has been issued.',
    { requiresReason: true },
  ),
  p(
    'inventory.grn.read',
    'pur_grn',
    'read',
    'financial',
    'low',
    'View a goods receipt, its batches and its rejections.',
  ),
  p(
    'inventory.grn.list',
    'pur_grn',
    'list',
    'financial',
    'low',
    'List goods receipts by vendor, order, store or date — the receiving dock’s working list.',
  ),
  p(
    'inventory.grn.without_po.create',
    'pur_grn',
    'create',
    'financial',
    'high',
    'Receive goods with no purchase order behind them. The exception that has to stay countable, so it carries its own key and its own reason.',
    { requiresReason: true },
  ),
  p(
    'inventory.purchase_return.manage',
    'pur_return',
    'manage',
    'financial',
    'medium',
    'Raise and dispatch a return to the vendor against a debit note.',
    { requiresReason: true },
  ),
  p(
    'inventory.purchase_return.read',
    'pur_return',
    'read',
    'financial',
    'low',
    'View a purchase return and the debit note raised for it.',
  ),
  p(
    'inventory.purchase_return.list',
    'pur_return',
    'list',
    'financial',
    'low',
    'List purchase returns awaiting dispatch or already credited.',
  ),
  p(
    'inventory.invoice.capture',
    'pur_vendor_invoice',
    'capture',
    'financial',
    'medium',
    'Enter a vendor invoice against a purchase order and its receipts.',
  ),
  p(
    'inventory.invoice.match',
    'pur_vendor_invoice',
    'match',
    'financial',
    'medium',
    'Run and work the three-way match between order, receipt and invoice, and resolve its exceptions.',
  ),
  p(
    'inventory.invoice.approve',
    'pur_vendor_invoice',
    'approve',
    'financial',
    'critical',
    'Release a matched vendor invoice to accounts payable. NC-005 §12 keeps this away from whoever posted the goods receipt.',
    { requiresStepUp: true },
  ),
  p(
    'inventory.invoice.read',
    'pur_vendor_invoice',
    'read',
    'financial',
    'low',
    'View a vendor invoice and its match verdict line by line.',
  ),
  p(
    'inventory.invoice.list',
    'pur_vendor_invoice',
    'list',
    'financial',
    'low',
    'List vendor invoices, including the three-way-match exception queue.',
  ),
  p(
    'inventory.purchase.emergency.create',
    'pur_emergency_purchase',
    'create',
    'financial',
    'high',
    'Buy outside the normal cycle in an emergency, starting the clock for post-facto regularisation.',
    { requiresReason: true },
  ),
  p(
    'inventory.purchase.emergency.approve',
    'pur_emergency_purchase',
    'approve',
    'financial',
    'high',
    'Regularise an emergency purchase after the fact, or refuse to.',
    { requiresReason: true },
  ),
  p(
    'inventory.purchase.report.read',
    'report',
    'read',
    'financial',
    'low',
    'View procurement reports: spend, cycle times, vendor performance and exception ageing.',
  ),
  p(
    'inventory.purchase.configure',
    'pur_settings',
    'configure',
    'financial',
    'high',
    'Set match tolerances, minimum vendor counts, RFQ thresholds and regularisation windows. A tolerance is how much difference is allowed to pass unseen.',
  ),
  p(
    'inventory.purchase.export',
    'report',
    'export',
    'financial',
    'high',
    'Export procurement data. Reason mandatory: commercial terms leave the audit boundary with it.',
    { requiresReason: true },
  ),
]);

// ── NC-007 — consignment and implants ────────────────────────────────────────
const NC007 = group('NC-007', 4, [
  p(
    'inventory.consignment.agreement.read',
    'csn_agreement',
    'read',
    'commercial',
    'low',
    'View a consignment agreement, its item list and its agreed prices.',
  ),
  p(
    'inventory.consignment.agreement.list',
    'csn_agreement',
    'list',
    'commercial',
    'low',
    'List consignment agreements, live and expiring. An agreement id has to come from somewhere.',
  ),
  p(
    'inventory.consignment.agreement.manage',
    'csn_agreement',
    'manage',
    'commercial',
    'high',
    'Author consignment agreements, their item lists and their effective-dated prices.',
  ),
  p(
    'inventory.consignment.agreement.approve',
    'csn_agreement',
    'approve',
    'commercial',
    'high',
    'Approve a consignment agreement into force, which allows a vendor’s stock onto our shelves.',
  ),
  p(
    'inventory.consignment.kit.manage',
    'csn_kit',
    'manage',
    'operational',
    'medium',
    'Define and manage consignment kits and loaner sets, including their expected contents.',
  ),
  p(
    'inventory.consignment.receive',
    'csn_receipt',
    'receive',
    'operational',
    'medium',
    'Receive consignment stock, which is booked separately and never valued as ours.',
  ),
  p(
    'inventory.consignment.stock.read',
    'csn_stock',
    'read',
    'operational',
    'low',
    'View consignment stock on hand by agreement, item, batch and serial.',
  ),
  p(
    'inventory.consignment.use',
    'csn_usage',
    'use',
    'phi',
    'high',
    'Record a consignment implant or item as used on a patient. One action posts the ledger movement, the auto-order to the vendor, the charge intent and the implant registry entry, atomically.',
  ),
  p(
    'inventory.consignment.approve',
    'csn_usage',
    'approve',
    'financial',
    'high',
    'Approve a manually entered usage or a wastage above the configured threshold.',
    { requiresReason: true },
  ),
  p(
    'inventory.consignment.usage.read',
    'csn_usage',
    'read',
    'phi',
    'medium',
    'View a consignment usage, including the patient it was used on and the serial that went in.',
    { phiRead: true },
  ),
  p(
    'inventory.consignment.usage.list',
    'csn_usage',
    'list',
    'phi',
    'medium',
    'List consignment usages by agreement, period, theatre or surgeon. Names patients, so it writes a READ_PHI row.',
    { phiRead: true },
  ),
  p(
    'inventory.consignment.po.read',
    'csn_auto_po_batch',
    'read',
    'financial',
    'low',
    'View the automatic replenishment orders that usage raised against a consignment vendor.',
  ),
  p(
    'inventory.consignment.po.list',
    'csn_auto_po_batch',
    'list',
    'financial',
    'low',
    'List automatic consignment replenishment orders, open and closed.',
  ),
  p(
    'inventory.consignment.po.close',
    'csn_auto_po_batch',
    'close',
    'financial',
    'medium',
    'Close an automatic consignment order once it is fully invoiced.',
  ),
  p(
    'inventory.consignment.return.manage',
    'csn_return',
    'manage',
    'operational',
    'medium',
    'Propose and dispatch returns of unused, near-expiry or recalled consignment stock.',
    { requiresReason: true },
  ),
  p(
    'inventory.consignment.count',
    'csn_count',
    'count',
    'operational',
    'medium',
    'Count consignment stock physically and record the discrepancies against the vendor’s book.',
  ),
  p(
    'inventory.consignment.reconcile',
    'csn_reconciliation',
    'reconcile',
    'financial',
    'high',
    'Build and work the period reconciliation statement against a consignment vendor.',
  ),
  p(
    'inventory.consignment.sign',
    'csn_reconciliation',
    'sign',
    'financial',
    'high',
    'Sign a consignment reconciliation on the hospital’s behalf. NC-007 §12 keeps this away from whoever scanned the usages being reconciled.',
    { requiresStepUp: true },
  ),
  p(
    'inventory.consignment.dispute.manage',
    'csn_reconciliation',
    'manage',
    'financial',
    'medium',
    'Raise and resolve disputes on a consignment reconciliation line.',
    { requiresReason: true },
  ),
  p(
    'inventory.consignment.report.read',
    'report',
    'read',
    'financial',
    'low',
    'View consignment reports: stock value held, usage by vendor and reconciliation ageing.',
  ),
  p(
    'inventory.consignment.configure',
    'csn_settings',
    'configure',
    'commercial',
    'high',
    'Set consignment defaults: invoicing cycle, return window, count frequency and wastage approval threshold.',
  ),
]);

// ── NC-008 — consumption and cost centres ────────────────────────────────────
const NC008 = group('NC-008', 4, [
  p(
    'inventory.consumption.record',
    'cons_entry',
    'record',
    'phi',
    'medium',
    'Record consumption against a ward, a department, a procedure or a patient, which posts the stock movement.',
  ),
  p(
    'inventory.consumption.read',
    'cons_entry',
    'read',
    'phi',
    'low',
    'View a consumption entry, including the patient it was recorded against.',
    { phiRead: true },
  ),
  p(
    'inventory.consumption.list',
    'cons_entry',
    'list',
    'phi',
    'low',
    'List consumption entries for a ward, store or period. Patient-linked entries make this a PHI read.',
    { phiRead: true },
  ),
  p(
    'inventory.consumption.reverse',
    'cons_entry',
    'reverse',
    'financial',
    'medium',
    'Reverse a consumption entry. Entries are reversible, never editable — the ledger behind them cannot be rewritten either.',
    { requiresReason: true },
  ),
  p(
    'inventory.consumption.supervise',
    'cons_entry',
    'review',
    'financial',
    'medium',
    'Reverse a consumption entry outside the 24-hour self-service window, or record one against a discharged patient.',
    { requiresReason: true },
  ),
  p(
    'inventory.consumption.configure',
    'cons_kit',
    'configure',
    'operational',
    'medium',
    'Define consumption kits and service bills of material, which decide what is deducted automatically.',
  ),
  p(
    'inventory.consumption.variance.read',
    'cons_variance_alert',
    'read',
    'financial',
    'low',
    'View budget variance alerts for the cost centres in scope.',
  ),
  p(
    'inventory.consumption.variance.explain',
    'cons_variance_alert',
    'explain',
    'financial',
    'medium',
    'Record the explanation a cost-centre owner owes for a budget variance within its SLA.',
  ),
  p(
    'inventory.consumption.report.read',
    'report',
    'read',
    'financial',
    'low',
    'View consumption reports: per department, per bed, per procedure, and wastage analytics.',
  ),
  p(
    'inventory.consumption.export',
    'report',
    'export',
    'financial',
    'high',
    'Export consumption data, which can be patient-linked. Reason mandatory.',
    { requiresReason: true },
  ),
  p(
    'finance.costcentre.read',
    'cost_centre',
    'read',
    'financial',
    'low',
    'View a cost centre, its owner and its allocation basis.',
  ),
  p('finance.costcentre.list', 'cost_centre', 'list', 'financial', 'low', 'List the cost-centre hierarchy.'),
  p(
    'finance.costcentre.manage',
    'cost_centre',
    'manage',
    'financial',
    'high',
    'Create cost centres and maintain their effective-dated mappings. A code is immutable once postings exist against it.',
  ),
  p(
    'finance.allocation.run',
    'cost_centre',
    'run',
    'financial',
    'high',
    'Run the period overhead allocation and review its result before anything is posted.',
  ),
  p(
    'finance.allocation.post',
    'cost_centre',
    'post',
    'financial',
    'critical',
    'Post an allocation run to the general ledger. NC-008 §14 requires the poster to be someone other than the runner.',
    { requiresStepUp: true },
  ),
]);

// ── NC-021 — the vendor master ───────────────────────────────────────────────
const NC021 = group('NC-021', 4, [
  p(
    'vendor.master.read',
    'vnd_vendor',
    'read',
    'commercial',
    'low',
    'View a vendor record, its categories, its status and its documents.',
  ),
  p(
    'vendor.master.list',
    'vnd_vendor',
    'list',
    'commercial',
    'low',
    'Search and page the vendor master — how a buyer finds the vendor to order from.',
  ),
  p(
    'vendor.master.manage',
    'vnd_vendor',
    'manage',
    'commercial',
    'medium',
    'Create and maintain vendor records, contacts, addresses and item mappings. Bank details are a separate, checked grant.',
  ),
  p(
    'vendor.master.approve',
    'vnd_vendor',
    'approve',
    'commercial',
    'high',
    'Approve a vendor for purchasing. NC-021 §12 keeps the approver distinct from whoever onboarded it.',
  ),
  p(
    'vendor.kyc.verify',
    'vnd_document',
    'verify',
    'commercial',
    'high',
    'Verify vendor KYC: PAN, GSTIN, drug licence and the rest of the statutory document set.',
  ),
  p(
    'vendor.bank.approve',
    'vnd_vendor',
    'approve',
    'financial',
    'critical',
    'Approve a change to a vendor’s bank account after call-back verification. Payments keep running to the old account until this is done, because a vendor bank change is the most-abused path in accounts payable.',
    { requiresStepUp: true, requiresReason: true, sensitiveGrant: true },
  ),
  p(
    'vendor.item.read',
    'vnd_item_map',
    'read',
    'commercial',
    'low',
    'View which vendors supply an item, at what lead time and at what last price.',
  ),
  p(
    'vendor.item.manage',
    'vnd_item_map',
    'manage',
    'commercial',
    'medium',
    'Maintain the vendor-to-item mapping, preferred ranks, minimum order quantities and lead times.',
  ),
  p(
    'vendor.contract.read',
    'vnd_rate_contract',
    'read',
    'commercial',
    'low',
    'View a vendor’s contracts and the obligations they carry.',
  ),
  p(
    'vendor.contract.list',
    'vnd_rate_contract',
    'list',
    'commercial',
    'low',
    'List vendor contracts, including those approaching expiry.',
  ),
  p(
    'vendor.contract.manage',
    'vnd_rate_contract',
    'manage',
    'commercial',
    'high',
    'Author vendor contracts, their terms, penalties and delivery service levels.',
  ),
  p(
    'vendor.contract.approve',
    'vnd_rate_contract',
    'approve',
    'commercial',
    'high',
    'Approve a vendor contract into force.',
  ),
  p(
    'vendor.score.read',
    'vnd_score_period',
    'read',
    'commercial',
    'low',
    'View a vendor’s performance score and the events behind it.',
  ),
  p(
    'vendor.score.manage',
    'vnd_score_period',
    'manage',
    'commercial',
    'medium',
    'Configure scoring weights and publish a scoring period. What is weighted is what vendors optimise for.',
  ),
  p(
    'vendor.audit.manage',
    'vnd_document',
    'manage',
    'commercial',
    'medium',
    'Plan and record vendor audits and the corrective actions arising from them.',
  ),
  p(
    'vendor.action.propose',
    'vnd_action',
    'propose',
    'commercial',
    'high',
    'Propose a sanction — watch-list, hold, show-cause or blacklist — against a vendor.',
    { requiresReason: true },
  ),
  p(
    'vendor.action.approve',
    'vnd_action',
    'approve',
    'commercial',
    'critical',
    'Approve a sanction against a vendor. The proposer may never be the approver: a blacklist ends a commercial relationship and is contestable.',
    { requiresReason: true, requiresStepUp: true },
  ),
  p(
    'vendor.report.read',
    'report',
    'read',
    'commercial',
    'low',
    'View vendor reports: performance, spend concentration, document expiry and sanction history.',
  ),
  p(
    'vendor.export',
    'report',
    'export',
    'commercial',
    'high',
    'Export vendor data, which carries commercial terms and masked financial identifiers. Reason mandatory.',
    { requiresReason: true },
  ),
  p(
    'vendor.configure',
    'vnd_settings',
    'configure',
    'commercial',
    'high',
    'Set vendor defaults: grade thresholds, document alert windows and onboarding approval chains.',
  ),
]);

// ── OP-003 — the pharmacy counter ────────────────────────────────────────────
const OP003 = group('OP-003', 4, [
  p(
    'pharmacy.queue.read',
    'rx_queue',
    'read',
    'phi',
    'low',
    'See the prescription queue and the patients waiting in it. Never licence-gated: a queue a counter cannot see is a counter that has stopped.',
    { phiRead: true, clinicalSafetyExempt: true },
  ),
  p(
    'pharmacy.queue.list',
    'rx_queue',
    'list',
    'phi',
    'low',
    'Page and filter the prescription queue across counters and priorities.',
    { phiRead: true, clinicalSafetyExempt: true },
  ),
  p(
    'pharmacy.queue.manage',
    'rx_queue',
    'manage',
    'phi',
    'low',
    'Assign, reprioritise, hold and release entries in the prescription queue.',
  ),
  p(
    'pharmacy.dispense.create',
    'dispense',
    'create',
    'phi',
    'medium',
    'Open a dispense against a prescription or a counter sale and scan items onto it. Never licence-gated: this is medicine reaching a patient. It is also the decoratable precondition for `pharmacy.narcotic.dispense`, which needs a co-signer no route decorator can supply.',
    { clinicalSafetyExempt: true },
  ),
  p(
    'pharmacy.dispense.complete',
    'dispense',
    'complete',
    'phi',
    'high',
    'Complete a dispense: the stock leaves, the labels print and the prescriber is told. Requires a registered pharmacist profile, and is never licence-gated.',
    { clinicalSafetyExempt: true },
  ),
  p(
    'pharmacy.dispense.read',
    'dispense',
    'read',
    'phi',
    'low',
    'View a dispense, its lines and the batches that went out on it.',
    { phiRead: true },
  ),
  p(
    'pharmacy.dispense.list',
    'dispense',
    'list',
    'phi',
    'low',
    'List and search dispensing history for a patient, a counter or a period — including "what did this patient receive", which a recall asks first.',
    { phiRead: true },
  ),
  p(
    'pharmacy.dispense.bill',
    'dispense',
    'capture',
    'financial',
    'medium',
    'Raise the charge for a dispense and hand it to the billing counter.',
  ),
  p(
    'pharmacy.dispense.cancel',
    'dispense',
    'cancel',
    'phi',
    'medium',
    'Cancel a dispense before it completes. After completion the only path is a return, because the medicine has left the counter.',
    { requiresReason: true },
  ),
  p(
    'pharmacy.substitution.request',
    'substitution_request',
    'request',
    'phi',
    'medium',
    'Propose a generic or brand substitution to the prescriber and start the response clock.',
  ),
  p(
    'pharmacy.substitution.read',
    'substitution_request',
    'read',
    'phi',
    'low',
    'View substitution requests and their outcomes.',
    { phiRead: true },
  ),
  p(
    'pharmacy.substitution.list',
    'substitution_request',
    'list',
    'phi',
    'low',
    'List substitution requests awaiting a prescriber’s decision — the queue the two-minute timeout runs against.',
    { phiRead: true },
  ),
  p(
    'rx.substitution.approve',
    'substitution_request',
    'approve',
    'phi',
    'high',
    'Approve or refuse a pharmacist’s proposed substitution. Held by prescribers: the pharmacist proposes, the prescriber decides.',
  ),
  p(
    'pharmacy.batch.override',
    'dispense_item',
    'override',
    'operational',
    'high',
    'Dispense a batch other than the one FEFO suggested. The reason is stored on the line — a batch override is how stock quietly ages into a write-off.',
    { requiresReason: true },
  ),
  p(
    'pharmacy.label.print',
    'label',
    'print',
    'phi',
    'low',
    'Print dispensing labels carrying dosage instructions in the patient’s language.',
  ),
  p(
    'pharmacy.label.reprint',
    'label',
    'reprint',
    'phi',
    'low',
    'Reprint a dispensing label. Audited and reasoned, because a second label on a second box is how a dose gets taken twice.',
    { requiresReason: true },
  ),
  p(
    'pharmacy.otc.sell',
    'dispense',
    'sell',
    'financial',
    'medium',
    'Sell over the counter without a prescription. The database refuses a Schedule H, H1 or X drug on this path, with the rule quoted.',
  ),
  p(
    'pharmacy.return.create',
    'sale_return',
    'create',
    'phi',
    'medium',
    'Accept a patient or ward return against a dispense, with its coded reason.',
    { requiresReason: true },
  ),
  p(
    'pharmacy.return.read',
    'sale_return',
    'read',
    'phi',
    'low',
    'View a pharmacy return and whether its lines were restocked or quarantined.',
    { phiRead: true },
  ),
  p(
    'pharmacy.return.list',
    'sale_return',
    'list',
    'phi',
    'low',
    'List pharmacy returns awaiting approval or already completed.',
    { phiRead: true },
  ),
  p(
    'pharmacy.return.approve',
    'sale_return',
    'approve',
    'financial',
    'medium',
    'Approve a return above the counter’s own value threshold, and the refund that follows it.',
    { requiresReason: true },
  ),
  p(
    'pharmacy.stock.read',
    'stock_balance',
    'read',
    'operational',
    'low',
    'View stock on hand at a pharmacy counter, by item, batch and expiry.',
  ),
  p(
    'pharmacy.stock.list',
    'stock_balance',
    'list',
    'operational',
    'low',
    'Page pharmacy stock balances — the shelf view a counter works from.',
  ),
  p(
    'pharmacy.stock.adjust',
    'adjustment',
    'adjust',
    'financial',
    'high',
    'Adjust pharmacy stock outside the ordinary movements. Reason mandatory: an unexplained adjustment at a counter is indistinguishable from a loss.',
    { requiresReason: true },
  ),
  p(
    'pharmacy.indent.create',
    'store_indent',
    'create',
    'operational',
    'low',
    'Raise a replenishment indent from a pharmacy counter on its supplying store.',
  ),
  p(
    'pharmacy.indent.approve',
    'store_indent',
    'approve',
    'operational',
    'medium',
    'Approve a pharmacy replenishment indent.',
  ),
  p(
    'pharmacy.expiry.read',
    'expiry_action',
    'read',
    'operational',
    'low',
    'View the near-expiry working list and the actions already taken on it.',
  ),
  p(
    'pharmacy.expiry.manage',
    'expiry_action',
    'manage',
    'financial',
    'high',
    'Decide near-expiry stock: return to supplier, transfer, discount, quarantine, write off or dispose.',
    { requiresReason: true },
  ),
  p(
    'pharmacy.recall.read',
    'recall',
    'read',
    'operational',
    'low',
    'View a recall, its source, its severity and its progress.',
  ),
  p('pharmacy.recall.list', 'recall', 'list', 'operational', 'low', 'List open and closed recalls.'),
  p(
    'pharmacy.recall.manage',
    'recall',
    'manage',
    'operational',
    'critical',
    'Raise, progress and close a batch recall. Never licence-gated: a recall does not wait for an invoice.',
    { clinicalSafetyExempt: true },
  ),
  p(
    'pharmacy.recall.trace',
    'recall_trace',
    'trace',
    'phi',
    'critical',
    'Produce the list of patients who received a recalled batch, so they can be contacted. Reads patient data by design, and is never licence-gated.',
    { phiRead: true, clinicalSafetyExempt: true },
  ),
  p(
    'pharmacy.narcotic.read',
    'controlled_drug_register',
    'read',
    'phi',
    'high',
    'Read an entry in the NDPS, Schedule X or Schedule H1 register. The register names patients and prescribers, so it is a PHI read behind fresh strong auth.',
    { phiRead: true, requiresStepUp: true },
  ),
  p(
    'pharmacy.narcotic.list',
    'controlled_drug_register',
    'list',
    'phi',
    'high',
    'Page a controlled-drug register — the running-balance view a drug inspector asks for. Held wherever `pharmacy.narcotic.read` is: a serial number has to be found before it can be read.',
    { phiRead: true, requiresStepUp: true },
  ),
  p(
    'pharmacy.narcotic.prepare',
    'controlled_drug_register',
    'prepare',
    'phi',
    'high',
    'Open a controlled-drug transaction and present it for a second pharmacist’s signature. This is the single-signature authority a route can be decorated with; the co-signed keys below are asserted inside the service once the second person has authenticated. Never licence-gated: a controlled drug still has to reach the patient who needs it.',
    { requiresStepUp: true, clinicalSafetyExempt: true },
  ),
  p(
    'pharmacy.narcotic.dispense',
    'controlled_drug_register',
    'dispense',
    'phi',
    'critical',
    'Dispense a narcotic or psychotropic drug under two-person authorisation. Cannot decorate a route — decorate with `pharmacy.dispense.create` and assert this inside the service with the co-signer attached (see frontoffice/cash/cosign.service.ts). Never licence-gated.',
    {
      requiresSecondPerson: true,
      requiresStepUp: true,
      sensitiveGrant: true,
      clinicalSafetyExempt: true,
    },
  ),
  p(
    'pharmacy.narcotic.issue',
    'controlled_drug_register',
    'issue',
    'phi',
    'critical',
    'Receive into or issue from the controlled-drug safe under two-person authorisation. Cannot decorate a route — decorate with `pharmacy.narcotic.prepare` and assert this inside the service with the co-signer attached.',
    { requiresSecondPerson: true, requiresStepUp: true, sensitiveGrant: true },
  ),
  p(
    'pharmacy.narcotic.custody',
    'narcotic_custody_check',
    'verify',
    'phi',
    'critical',
    'Sign off a physical count of the controlled-drug safe. Two counters, and the database refuses the row if they are the same person. Cannot decorate a route — decorate with `pharmacy.narcotic.prepare` and assert this inside the service with the co-signer attached.',
    { requiresSecondPerson: true, requiresStepUp: true, sensitiveGrant: true },
  ),
  p(
    'pharmacy.narcotic.destroy',
    'controlled_drug_register',
    'void',
    'phi',
    'critical',
    'Witness and record the destruction of controlled-substance stock or wastage. Cannot decorate a route — decorate with `pharmacy.narcotic.prepare` and assert this inside the service with the co-signer attached.',
    {
      requiresSecondPerson: true,
      requiresStepUp: true,
      requiresReason: true,
      sensitiveGrant: true,
    },
  ),
  p(
    'pharmacy.coldchain.record',
    'temp_reading',
    'record',
    'operational',
    'low',
    'Log a manual refrigerator temperature reading at a pharmacy counter.',
  ),
  p(
    'pharmacy.coldchain.decide',
    'temp_excursion',
    'decide',
    'operational',
    'high',
    'Decide whether cold-chain stock held through an excursion may still be given to a patient.',
    { requiresReason: true },
  ),
  p(
    'pharmacy.price.update',
    'item_price',
    'update',
    'financial',
    'high',
    'Date a new selling price into force. Never retroactive: a bill already printed stays reproducible.',
  ),
  p(
    'pharmacy.discount.apply',
    'dispense',
    'apply',
    'financial',
    'medium',
    'Apply a discount to a pharmacy sale, within the ABAC amount limit on the role. Anything beyond it is an approval, not a keystroke.',
    { requiresReason: true },
  ),
  p(
    'pharmacy.day_close.read',
    'pharmacy_day_close',
    'read',
    'financial',
    'low',
    'View a counter’s day-close statement and its exception list.',
  ),
  p(
    'pharmacy.day_close.list',
    'pharmacy_day_close',
    'list',
    'financial',
    'low',
    'List day-close statements by counter and date.',
  ),
  p(
    'pharmacy.day_close.complete',
    'pharmacy_day_close',
    'complete',
    'financial',
    'high',
    'Close a pharmacy counter’s day, reconciling cash, credit and stock. The database refuses the close over an unresolved narcotic variance.',
  ),
  p(
    'pharmacy.intervention.record',
    'pharmacy_intervention',
    'record',
    'phi',
    'low',
    'Record a pharmacist intervention on a prescription — a dose queried, an interaction caught, a duplicate stopped.',
  ),
  p(
    'pharmacy.intervention.read',
    'pharmacy_intervention',
    'read',
    'phi',
    'low',
    'View recorded pharmacist interventions and their outcomes.',
    { phiRead: true },
  ),
  p(
    'pharmacy.intervention.list',
    'pharmacy_intervention',
    'list',
    'phi',
    'low',
    'List pharmacist interventions for review — the clinical-pharmacy audit a NABH assessor asks for.',
    { phiRead: true },
  ),
  p(
    'pharmacy.report.read',
    'report',
    'read',
    'financial',
    'low',
    'View pharmacy reports: sales, turnaround, substitution rate, expiry loss and register summaries.',
  ),
  p(
    'pharmacy.report.export',
    'report',
    'export',
    'financial',
    'high',
    'Export pharmacy data, including statutory register extracts. Reason mandatory.',
    { requiresReason: true },
  ),
  p(
    'pharmacy.configure',
    'pharmacy_store',
    'configure',
    'operational',
    'high',
    'Configure pharmacy counters: licences, counters, label locales, substitution policy and approval thresholds.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5
// ─────────────────────────────────────────────────────────────────────────────

// ── RC-003 — tariff management, the pricing authority ────────────────────────
//
// `tariff.rate.resolve` is the hot path every bill line calls, so it is `low`
// risk and widely granted: a clinician who cannot resolve a rate sees an
// estimate they cannot explain. Everything that *changes* a price is `high` or
// `critical` and split three ways — configure, submit, publish — because
// RC-003 §5's approval matrix is worthless if one person holds the whole chain.
const RC003 = group('RC-003', 5, [
  p('tariff.plan.list', 'tariff_plan', 'list', 'commercial', 'low', 'List rate plans and their scope.'),
  p('tariff.plan.read', 'tariff_plan', 'read', 'commercial', 'low', 'View one rate plan and its derivation.'),
  p(
    'tariff.plan.configure',
    'tariff_plan',
    'configure',
    'commercial',
    'high',
    'Create and amend rate plans: payer linkage, derivation formula, rounding and priority.',
  ),
  p('tariff.version.list', 'tariff_version', 'list', 'commercial', 'low', 'List the versions of a plan.'),
  p('tariff.version.read', 'tariff_version', 'read', 'commercial', 'low', 'View one tariff version header.'),
  p(
    'tariff.version.create',
    'tariff_version',
    'create',
    'commercial',
    'medium',
    'Open a draft version — fresh, cloned from a published one, or derived from another plan.',
  ),
  p(
    'tariff.version.update',
    'tariff_version',
    'update',
    'commercial',
    'medium',
    'Amend a draft version header. A published version is immutable and this key cannot touch one.',
  ),
  p(
    'tariff.version.simulate',
    'tariff_version',
    'read',
    'commercial',
    'low',
    'Run the revenue-impact simulation for a draft against historical volumes.',
  ),
  p(
    'tariff.version.submit',
    'tariff_version',
    'request',
    'commercial',
    'medium',
    'Submit a draft for approval. Deliberately not the key that publishes it.',
    { requiresReason: true },
  ),
  p(
    'tariff.version.publish',
    'tariff_version',
    'publish',
    'commercial',
    'critical',
    'Publish an approved version. From that instant every bill line in the window prices from it.',
    { requiresReason: true },
  ),
  p(
    'tariff.version.withdraw',
    'tariff_version',
    'withdraw',
    'commercial',
    'critical',
    'Withdraw a published version that no bill line has referenced yet.',
    { requiresReason: true },
  ),
  p('tariff.item.list', 'tariff_item', 'list', 'commercial', 'low', 'Read the rate grid of a version.'),
  p(
    'tariff.item.update',
    'tariff_item',
    'update',
    'commercial',
    'high',
    'Upsert rate rows into a draft version.',
  ),
  p(
    'tariff.bulk.revise',
    'tariff_item',
    'update',
    'commercial',
    'high',
    'Apply an uplift, formula or copy across a draft, behind a preview token.',
    { requiresReason: true },
  ),
  p(
    'tariff.package.read',
    'tariff_package',
    'read',
    'commercial',
    'low',
    'Read package pricing and its cap rules.',
  ),
  p(
    'tariff.package.update',
    'tariff_package',
    'update',
    'commercial',
    'high',
    'Price a package: rate, caps, exclusions and the component split.',
  ),
  p(
    'tariff.payer_sheet.upload',
    'tariff_payer_sheet',
    'create',
    'commercial',
    'medium',
    'Upload a payer rate sheet for mapping.',
  ),
  p(
    'tariff.payer_sheet.map',
    'tariff_payer_sheet',
    'update',
    'commercial',
    'medium',
    'Match payer rate rows to services and accept, edit or reject each one.',
  ),
  p(
    'tariff.payer_sheet.publish',
    'tariff_payer_sheet',
    'publish',
    'commercial',
    'high',
    'Turn a mapped payer sheet into a plan version.',
  ),
  p(
    'tariff.scheme.import',
    'tariff_scheme_import',
    'create',
    'commercial',
    'high',
    'Import a PMJAY, CGHS, ECHS, ESIC or state package list from a circular.',
  ),
  /**
   * The hot path. Every bill line, every estimate and every pre-auth calls it,
   * so it is granted widely and carries no reason requirement — it reads a
   * price, it does not set one.
   */
  p(
    'tariff.rate.resolve',
    'tariff_item',
    'read',
    'commercial',
    'low',
    'Resolve the applicable rate for a service, payer, bed class and date.',
  ),
  p(
    'tariff.rate.explain',
    'tariff_item',
    'read',
    'commercial',
    'low',
    'Show the resolution chain behind a priced bill line — why this price.',
  ),
  p(
    'tariff.report.compare',
    'tariff_item',
    'read',
    'commercial',
    'medium',
    'Compare a service across plans with cost and margin.',
  ),
  p(
    'tariff.missing.read',
    'tariff_missing_rate',
    'list',
    'commercial',
    'medium',
    'Read the missing-rate worklist — the services a bill could not price.',
  ),
  p(
    'tariff.missing.resolve',
    'tariff_missing_rate',
    'update',
    'commercial',
    'high',
    'Close a missing-rate entry by pricing it or waiving it.',
    { requiresReason: true },
  ),
  p(
    'tariff.audit.read',
    'tariff_change_log',
    'list',
    'commercial',
    'medium',
    'Read the append-only log of every rate change.',
  ),
  p(
    'tariff.ratecard.publish',
    'tariff_rate_card',
    'publish',
    'commercial',
    'medium',
    'Publish the statutory public rate card required by the Clinical Establishments Act.',
  ),
  p(
    'tariff.export',
    'tariff_item',
    'export',
    'commercial',
    'medium',
    'Export a published or draft price list as a spreadsheet.',
    { requiresReason: true },
  ),
]);

// ── OP-005 — OP billing ──────────────────────────────────────────────────────
//
// `bill.finalize` is the moment a draft becomes a demand for money and a GST
// document, so it is `critical` and separate from every key that assembles the
// bill. `bill.discount.request` and `bill.discount.approve` are two keys and
// carry a `block` rule for the same reason RC-003's submit/publish pair does:
// OP-005 §5 says "requester ≠ approver", and a role holding both makes the
// approval matrix a formality performed on oneself.
const OP005 = group('OP-005', 5, [
  p('bill.read', 'bill', 'read', 'financial', 'low', 'View a bill, its lines and its tax breakdown.'),
  p('bill.list', 'bill', 'list', 'financial', 'low', 'List and search bills for a branch or a patient.'),
  p(
    'bill.create',
    'bill',
    'create',
    'financial',
    'medium',
    'Open a bill for a visit and post charges onto it.',
  ),
  p(
    'bill.item.post',
    'bill_item',
    'create',
    'financial',
    'medium',
    'Post a charge line onto an open bill, priced through RC-003.',
  ),
  p(
    'bill.item.remove',
    'bill_item',
    'cancel',
    'financial',
    'high',
    'Cancel a line on a bill that has not been finalised.',
    { requiresReason: true },
  ),
  p(
    'bill.finalize',
    'bill',
    'approve',
    'financial',
    'critical',
    'Finalise a bill: fix its amounts, issue its GST document and make it collectable. Irreversible except by credit note.',
    { requiresReason: true },
  ),
  p(
    'bill.cancel',
    'bill',
    'cancel',
    'financial',
    'critical',
    'Cancel a bill. The row and its number stay; only the status changes.',
    { requiresReason: true },
  ),
  p(
    'bill.discount.request',
    'discount_request',
    'request',
    'financial',
    'medium',
    'Ask for a discount on a bill or a line, with a coded reason.',
    { requiresReason: true },
  ),
  p(
    'bill.discount.approve',
    'discount_request',
    'approve',
    'financial',
    'high',
    'Approve or refuse a discount. Never the same person who asked for it.',
    { requiresReason: true },
  ),
  p('invoice.read', 'invoice', 'read', 'financial', 'low', 'View an issued GST document.'),
  p(
    'invoice.issue',
    'invoice',
    'create',
    'financial',
    'high',
    'Issue a tax invoice or bill of supply against a finalised bill.',
  ),
  p(
    'invoice.credit_note',
    'invoice',
    'create',
    'financial',
    'critical',
    'Raise a credit note against an issued invoice. The correction path for anything already finalised.',
    { requiresReason: true },
  ),
  p(
    'invoice.cancel',
    'invoice',
    'cancel',
    'financial',
    'critical',
    'Cancel an issued invoice. The number is retained and shown as cancelled in the register.',
    { requiresReason: true },
  ),
  p(
    'invoice.reprint',
    'invoice',
    'reprint',
    'financial',
    'medium',
    'Reprint an invoice. Every reprint is watermarked and audited.',
  ),
  p(
    'billing.report.read',
    'bill',
    'read',
    'financial',
    'medium',
    'Read day-end revenue by department, doctor, service and payer.',
  ),
  p(
    'billing.exception.read',
    'billing_exception',
    'list',
    'financial',
    'medium',
    'Read the billing exception queue — unbilled, underbilled and unpriced findings.',
  ),
  p(
    'billing.gst.configure',
    'gst_profile',
    'configure',
    'financial',
    'high',
    'Configure a branch GSTIN, its place of supply and its e-invoice posture.',
  ),
  p(
    'billing.discount_matrix.configure',
    'discount_matrix',
    'configure',
    'financial',
    'high',
    'Set how much each role may discount before somebody else must approve.',
  ),
]);

// ── EN-010 — payment gateway ─────────────────────────────────────────────────
//
// `pay.webhook.receive` is not here on purpose: a webhook arrives with a
// provider signature, not a user session, and giving it a permission key would
// imply a human could hold it. It is authenticated by HMAC at the edge.
const EN010 = group('EN-010', 5, [
  p('pay.intent.read', 'pay_intent', 'read', 'financial', 'low', 'View a payment intent and its status.'),
  p('pay.intent.list', 'pay_intent', 'list', 'financial', 'low', 'List payment intents for a branch.'),
  p(
    'pay.intent.create',
    'pay_intent',
    'create',
    'financial',
    'medium',
    'Ask the gateway for a QR, a link or a card-machine order against a bill.',
  ),
  p(
    'pay.intent.cancel',
    'pay_intent',
    'cancel',
    'financial',
    'medium',
    'Cancel an unpaid intent so it cannot later be paid against a settled bill.',
    { requiresReason: true },
  ),
  p('pay.payment.read', 'pay_payment', 'read', 'financial', 'low', 'View a captured payment.'),
  p('pay.payment.list', 'pay_payment', 'list', 'financial', 'low', 'List captured payments.'),
  p(
    'pay.refund.request',
    'pay_refund',
    'request',
    'financial',
    'high',
    'Ask for a refund through the original instrument.',
    { requiresReason: true },
  ),
  p(
    'pay.refund.approve',
    'pay_refund',
    'approve',
    'financial',
    'critical',
    'Approve a refund and release it to the gateway. Never the person who asked.',
    { requiresReason: true },
  ),
  p(
    'pay.settlement.read',
    'pay_settlement',
    'list',
    'financial',
    'medium',
    'Read settlement files and what they matched against.',
  ),
  p(
    'pay.settlement.reconcile',
    'pay_settlement',
    'reconcile',
    'financial',
    'high',
    'Match a settlement to receipts and post the difference.',
  ),
  p(
    'pay.recon.read',
    'pay_recon_exception',
    'list',
    'financial',
    'medium',
    'Read the reconciliation exception queue.',
  ),
  p(
    'pay.recon.resolve',
    'pay_recon_exception',
    'resolve',
    'financial',
    'high',
    'Close a reconciliation exception with an explanation.',
    { requiresReason: true },
  ),
  p(
    'pay.gateway.configure',
    'pay_gateway_account',
    'configure',
    'security',
    'critical',
    'Configure a payment gateway account, its keys and its cash policy.',
    { requiresReason: true },
  ),
  p(
    'pay.terminal.manage',
    'pay_terminal',
    'manage',
    'financial',
    'medium',
    'Register and retire card machines against counters.',
  ),
  p(
    'pay.dispute.read',
    'pay_dispute',
    'list',
    'financial',
    'medium',
    'Read chargebacks and the evidence submitted against them.',
  ),
  p(
    'pay.dispute.respond',
    'pay_dispute',
    'update',
    'financial',
    'high',
    'Submit evidence against a chargeback before its deadline.',
  ),
]);

// ── OP-023 — packages ────────────────────────────────────────────────────────
//
// `pkg.variance.approve` is `critical` and separate from everything else: it
// decides who pays for an overrun on a fixed-price promise, and §5.4 requires
// that decision *before* the excess reaches the patient's bill.
const OP023 = group('OP-023', 5, [
  p(
    'pkg.read',
    'package',
    'read',
    'commercial',
    'low',
    'View a package, what it includes and what it excludes.',
  ),
  p('pkg.list', 'package', 'list', 'commercial', 'low', 'List packages available at a branch.'),
  p(
    'pkg.configure',
    'package',
    'configure',
    'commercial',
    'high',
    'Define a package: its components, its caps, its exclusions and its validity.',
  ),
  p(
    'pkg.version.publish',
    'package_version',
    'publish',
    'commercial',
    'critical',
    'Publish a package version. From its effective date this is what a patient buys.',
    { requiresReason: true },
  ),
  p('pkg.price.update', 'package_price', 'update', 'commercial', 'high', 'Price a package for a payer plan.'),
  p('pkg.booking.read', 'package_booking', 'read', 'financial', 'low', 'View a package booking.'),
  p('pkg.booking.list', 'package_booking', 'list', 'financial', 'low', 'List package bookings.'),
  p(
    'pkg.booking.create',
    'package_booking',
    'create',
    'financial',
    'medium',
    'Book a package for a patient and take the advance.',
  ),
  p(
    'pkg.booking.cancel',
    'package_booking',
    'cancel',
    'financial',
    'high',
    'Cancel a booking and start the refund of any advance.',
    { requiresReason: true },
  ),
  p(
    'pkg.activate',
    'package_activation',
    'create',
    'financial',
    'high',
    'Activate a package so charges begin consuming it.',
  ),
  p(
    'pkg.activation.read',
    'package_activation',
    'read',
    'financial',
    'low',
    'View an activation, its caps and what has been consumed.',
  ),
  p(
    'pkg.activation.close',
    'package_activation',
    'close',
    'financial',
    'high',
    'Close an activation and settle the difference between promise and delivery.',
    { requiresReason: true },
  ),
  p(
    'pkg.variance.request',
    'package_variance_request',
    'request',
    'financial',
    'medium',
    'Ask for approval to bill beyond the package.',
    { requiresReason: true },
  ),
  p(
    'pkg.variance.approve',
    'package_variance_request',
    'approve',
    'financial',
    'critical',
    'Decide who pays for an overrun: the patient, the insurer, or the hospital.',
    { requiresReason: true },
  ),
  p(
    'pkg.report.read',
    'package',
    'read',
    'commercial',
    'medium',
    'Read package utilisation and profitability.',
  ),
]);

// ── EN-002 + RC-002 — insurance, TPA and pre-authorisation ───────────────────
//
// `preauth.decision.record` is the key that writes what the payer said. It is
// `critical` and separate from `preauth.submit`: the person who assembles a
// request must not be able to record its approval, because an invented approval
// is a credit limit billing will honour and an insurer will later refuse.
const EN002 = group('EN-002', 5, [
  p(
    'ins.payer.read',
    'ins_payer',
    'read',
    'commercial',
    'low',
    'View a payer, TPA or scheme and its contacts.',
  ),
  p('ins.payer.list', 'ins_payer', 'list', 'commercial', 'low', 'List payers and TPAs.'),
  p(
    'ins.payer.configure',
    'ins_payer',
    'configure',
    'commercial',
    'high',
    'Maintain the payer, TPA and plan masters.',
  ),
  p(
    'ins.empanelment.read',
    'ins_empanelment',
    'read',
    'commercial',
    'low',
    'View an empanelment contract and its SLA.',
  ),
  p(
    'ins.empanelment.manage',
    'ins_empanelment',
    'manage',
    'commercial',
    'high',
    'Maintain empanelment contracts, tariffs and credit terms.',
  ),
  p(
    'ins.policy.read',
    'ins_patient_policy',
    'read',
    'phi',
    'medium',
    'View a patient policy and its remaining sum insured.',
    { phiRead: true },
  ),
  p(
    'ins.policy.manage',
    'ins_patient_policy',
    'update',
    'phi',
    'medium',
    'Capture and correct a patient policy.',
  ),
  p(
    'ins.policy.verify',
    'ins_patient_policy',
    'verify',
    'phi',
    'medium',
    'Record the result of an eligibility check against the payer.',
  ),
  p('ins.case.read', 'ins_case', 'read', 'phi', 'low', 'View an insurance case for an encounter.', {
    phiRead: true,
  }),
  p('ins.case.list', 'ins_case', 'list', 'phi', 'low', 'List insurance cases at the desk.'),
  p('ins.case.manage', 'ins_case', 'update', 'phi', 'medium', 'Open, assign and close an insurance case.'),
  p(
    'ins.nonpayable.read',
    'ins_non_payable_item',
    'list',
    'commercial',
    'low',
    'Read the non-payable item lists.',
  ),
]);

const RC002 = group('RC-002', 5, [
  p(
    'preauth.read',
    'preauth_request',
    'read',
    'phi',
    'low',
    'View a pre-authorisation, its documents and its clock.',
    { phiRead: true },
  ),
  p('preauth.list', 'preauth_request', 'list', 'phi', 'low', 'List pre-authorisations and what is due.'),
  p(
    'preauth.create',
    'preauth_request',
    'create',
    'phi',
    'medium',
    'Assemble a pre-authorisation request from the clinical record.',
  ),
  p(
    'preauth.update',
    'preauth_request',
    'update',
    'phi',
    'medium',
    'Amend a pre-authorisation that has not been submitted.',
  ),
  p(
    'preauth.submit',
    'preauth_request',
    'request',
    'phi',
    'high',
    'Submit a pre-authorisation to the payer and start the decision clock.',
    { requiresReason: true },
  ),
  /**
   * Writes what the payer decided. Never the person who submitted it: an
   * invented approval becomes a credit limit billing honours and the insurer
   * later refuses, and the patient discovers it at discharge.
   */
  p(
    'preauth.decision.record',
    'preauth_request',
    'decide',
    'financial',
    'critical',
    'Record the payer decision: approved amount, room class and validity, or a denial with its reason.',
    { requiresReason: true },
  ),
  p(
    'preauth.query.reply',
    'preauth_query',
    'update',
    'phi',
    'medium',
    'Answer a payer query before its clock runs out.',
  ),
  p(
    'preauth.document.manage',
    'preauth_document',
    'update',
    'phi',
    'medium',
    'Attach and verify the documents a payer requires.',
  ),
  p(
    'preauth.withdraw',
    'preauth_request',
    'withdraw',
    'phi',
    'high',
    'Withdraw a submitted pre-authorisation.',
    { requiresReason: true },
  ),
  p(
    'preauth.sla.read',
    'preauth_sla_event',
    'list',
    'operational',
    'medium',
    'Read the pre-authorisation TAT and breach dashboard.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// RC-007 — Government schemes (PMJAY/Ayushman, CGHS, ECHS, ESIC, state)
//
// The unusual key here is `scheme.cash.attempt.read`. Every refused tender is a
// row, and reading that log is how a hospital answers an NHA audit — so it is a
// permission finance and quality hold, not something buried in a debug screen.
// ─────────────────────────────────────────────────────────────────────────────
const RC007 = group('RC-007', 5, [
  p('scheme.read', 'scheme_master', 'read', 'commercial', 'low', 'View a government scheme and its rules.'),
  p(
    'scheme.list',
    'scheme_master',
    'list',
    'commercial',
    'low',
    'List the schemes this hospital is empanelled for.',
  ),
  p(
    'scheme.configure',
    'scheme_master',
    'configure',
    'commercial',
    'high',
    'Maintain the scheme master, including how far its cash block reaches.',
  ),
  p(
    'scheme.package.read',
    'scheme_package',
    'read',
    'commercial',
    'low',
    'View the HBP rate list and what each package covers.',
  ),
  p(
    'scheme.package.manage',
    'scheme_package',
    'manage',
    'commercial',
    'high',
    'Draft a scheme rate list and its packages. A published list is immutable.',
  ),
  p(
    'scheme.package.publish',
    'scheme_package',
    'approve',
    'commercial',
    'high',
    'Publish a scheme rate list, fixing the rates every claim from that date settles at.',
    { requiresReason: true },
  ),
  p(
    'scheme.beneficiary.read',
    'scheme_beneficiary',
    'read',
    'phi',
    'medium',
    "View a patient's scheme entitlement and what is left of the family floater.",
    { phiRead: true },
  ),
  p(
    'scheme.beneficiary.capture',
    'scheme_beneficiary',
    'create',
    'phi',
    'medium',
    'Record a scheme card against a patient, unverified until the authority confirms it.',
  ),
  p(
    'scheme.beneficiary.verify',
    'scheme_beneficiary',
    'approve',
    'phi',
    'high',
    "Record the authority's eligibility answer. Verification is what turns the cash block on.",
    { requiresReason: true },
  ),
  p('scheme.case.read', 'scheme_case', 'read', 'phi', 'low', 'View a scheme case and its packages.', {
    phiRead: true,
  }),
  p('scheme.case.list', 'scheme_case', 'list', 'phi', 'low', 'List scheme cases in flight.'),
  p('scheme.case.open', 'scheme_case', 'create', 'phi', 'medium', 'Open a scheme case for an episode.'),
  p(
    'scheme.case.manage',
    'scheme_case',
    'update',
    'phi',
    'medium',
    'Select packages, record the authority case number and move the case through treatment.',
  ),
  p(
    'scheme.case.close',
    'scheme_case',
    'update',
    'financial',
    'high',
    'Close a scheme case. Closing releases the cash block, so it is its own key.',
    { requiresReason: true },
  ),
  p(
    'scheme.cash.attempt.read',
    'scheme_cash_attempt',
    'list',
    'financial',
    'medium',
    'Read the log of cash tenders the system refused. This is the evidence an NHA audit asks for.',
  ),
  p('scheme.claim.read', 'scheme_claim', 'read', 'financial', 'low', 'View a scheme claim and its lines.'),
  p(
    'scheme.claim.list',
    'scheme_claim',
    'list',
    'financial',
    'low',
    'List scheme claims and what they are waiting on.',
  ),
  p(
    'scheme.claim.assemble',
    'scheme_claim',
    'create',
    'financial',
    'medium',
    'Assemble a scheme claim from the case and attach its document checklist.',
  ),
  p(
    'scheme.claim.submit',
    'scheme_claim',
    'request',
    'financial',
    'high',
    'Submit a claim to the authority. Refused while a mandatory document is missing.',
    { requiresReason: true },
  ),
  p(
    'scheme.claim.decision.record',
    'scheme_claim',
    'approve',
    'financial',
    'high',
    'Record what the authority decided and paid. Separate from submission for the same reason a pre-auth decision is.',
    { requiresReason: true },
  ),
  p(
    'scheme.shortfall.read',
    'scheme_shortfall',
    'list',
    'financial',
    'low',
    'View the money a scheme did not pay, and why.',
  ),
  p(
    'scheme.shortfall.appeal',
    'scheme_shortfall',
    'request',
    'financial',
    'medium',
    'Appeal a deduction, or ask for a shortfall to be written off.',
    { requiresReason: true },
  ),
  p(
    'scheme.shortfall.writeoff.approve',
    'scheme_shortfall',
    'approve',
    'financial',
    'high',
    'Agree that a shortfall will never be recovered. Maker-checker against the appeal key.',
    { requiresReason: true },
  ),
  p(
    'scheme.recon.manage',
    'scheme_reconciliation',
    'manage',
    'financial',
    'medium',
    "Load and match the authority's settlement batch against submitted claims.",
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// RC-008 — Cost estimator
//
// `est.variance.read` is the unusual one. Measuring the estimator against the
// bills it produced is how a hospital finds out its quotes run 20 % light, and
// the people who need that number are quality and finance, not the desk that
// wrote the quote.
// ─────────────────────────────────────────────────────────────────────────────
const RC008 = group('RC-008', 5, [
  p('est.read', 'estimate', 'read', 'financial', 'low', 'View a cost estimate and what it is made of.', {
    phiRead: true,
  }),
  p('est.list', 'estimate', 'list', 'financial', 'low', 'List estimates and what became of them.'),
  p(
    'est.create',
    'estimate',
    'create',
    'financial',
    'medium',
    'Build a draft estimate, priced through the tariff like any bill line.',
  ),
  p(
    'est.update',
    'estimate',
    'update',
    'financial',
    'medium',
    'Amend a draft estimate. An issued one is immutable and is revised by superseding it.',
  ),
  p(
    'est.issue',
    'estimate',
    'approve',
    'financial',
    'high',
    'Issue an estimate to a family. From here the number is fixed and the hospital is held to it.',
    { requiresReason: true },
  ),
  p(
    'est.share',
    'estimate',
    'export',
    'phi',
    'medium',
    'Send an issued estimate to the family by WhatsApp, SMS, email or print.',
    // EN-024 §5: every `export` carries a reason. Sending a quote is routine,
    // but it puts a costing for a named person onto a phone number somebody
    // typed, and the reason is what makes a misdirected send traceable.
    { requiresReason: true },
  ),
  p(
    'est.outcome.record',
    'estimate',
    'update',
    'financial',
    'medium',
    'Record that a family accepted or declined an estimate, or that it converted to an admission.',
  ),
  p(
    'est.template.read',
    'estimate_template',
    'read',
    'financial',
    'low',
    'View the standing line set for a procedure.',
  ),
  p(
    'est.template.manage',
    'estimate_template',
    'manage',
    'financial',
    'high',
    'Maintain the standing line sets, so two desks quote the same procedure the same way.',
  ),
  p(
    'est.variance.read',
    'estimate_variance',
    'list',
    'financial',
    'medium',
    'Read estimate-versus-actual. This is how a hospital learns its quotes run light.',
  ),
  p(
    'est.variance.record',
    'estimate_variance',
    'create',
    'financial',
    'medium',
    'Reconcile an estimate against the bill it became, and explain the difference.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// RC-006 — Revenue leakage audit
//
// `leak.finding.accept` is the key the whole module turns on. §5.7 says the
// audit never auto-posts, so nothing it finds becomes money without somebody
// holding this key agreeing it is a real gap — and `leak.discharge.override` is
// the one that lets a patient leave with money still on the table, which is a
// decision that needs a name against it.
// ─────────────────────────────────────────────────────────────────────────────
const RC006 = group('RC-006', 5, [
  p(
    'leak.rule.read',
    'leak_rule',
    'read',
    'financial',
    'low',
    'View which reconciliations run and at what threshold.',
  ),
  p(
    'leak.rule.manage',
    'leak_rule',
    'manage',
    'financial',
    'high',
    'Enable a reconciliation and set the gap below which it stays quiet.',
  ),
  p(
    'leak.scan.run',
    'leak_scan',
    'create',
    'financial',
    'medium',
    'Run the reconciliations over a window or one encounter.',
  ),
  p('leak.scan.read', 'leak_scan', 'list', 'financial', 'low', 'View past scans and what they covered.'),
  p(
    'leak.finding.read',
    'leak_finding',
    'read',
    'financial',
    'low',
    'View a suspected gap and the record behind it.',
  ),
  p('leak.finding.list', 'leak_finding', 'list', 'financial', 'low', 'Work the leakage worklist.'),
  p(
    'leak.finding.accept',
    'leak_finding',
    'approve',
    'financial',
    'high',
    'Agree a suspected gap is real. Nothing the audit finds is billed without this.',
    { requiresReason: true },
  ),
  p(
    'leak.finding.dismiss',
    'leak_finding',
    'reject',
    'financial',
    'medium',
    'Say a suspected gap is not one, and why. A dismissal with no reason is ignoring it.',
    { requiresReason: true },
  ),
  p(
    'leak.recovery.record',
    'leak_recovery',
    'create',
    'financial',
    'high',
    'Record that an accepted gap was billed and the money came back.',
    { requiresReason: true },
  ),
  p(
    'leak.discharge.check',
    'leak_discharge_check',
    'create',
    'financial',
    'medium',
    'Run the pre-discharge missed-charge check on an encounter.',
  ),
  p(
    'leak.discharge.override',
    'leak_discharge_check',
    'override',
    'financial',
    'high',
    'Let a patient leave with a gap still open. The hospital is choosing to lose the money, so the decision carries a name.',
    { requiresReason: true },
  ),
  p(
    'leak.report.read',
    'leak_finding',
    'export',
    'financial',
    'medium',
    'Read the recovered-amount dashboard: what the audit found, and what came back.',
    { requiresReason: true },
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// NC-034 — Doctor payouts
//
// `payout.statement.compute` and `payout.statement.approve` are a `block` pair:
// a payout statement is an outbound payment authorised on the strength of a
// calculation nobody else has looked at, so the person who ran it does not also
// release it.
// ─────────────────────────────────────────────────────────────────────────────
const NC034 = group('NC-034', 5, [
  p(
    'payout.contract.read',
    'payout_contract',
    'read',
    'hr',
    'medium',
    "View a doctor's payout arrangement and its rules.",
  ),
  p(
    'payout.contract.manage',
    'payout_contract',
    'manage',
    'hr',
    'high',
    'Maintain payout contracts, fee-share rules and slabs.',
    { requiresReason: true },
  ),
  p(
    'payout.period.read',
    'payout_period',
    'list',
    'financial',
    'low',
    'View payout periods and their totals.',
  ),
  p(
    'payout.period.manage',
    'payout_period',
    'manage',
    'financial',
    'medium',
    'Open and close a payout period.',
  ),
  p(
    'payout.statement.read',
    'payout_statement',
    'read',
    'hr',
    'medium',
    "View a doctor's statement and every line behind it.",
  ),
  p('payout.statement.list', 'payout_statement', 'list', 'hr', 'medium', 'List payout statements.'),
  p(
    'payout.statement.compute',
    'payout_statement',
    'create',
    'financial',
    'high',
    'Compute a period\u2019s statements from what each doctor performed.',
  ),
  p(
    'payout.statement.approve',
    'payout_statement',
    'approve',
    'financial',
    'high',
    'Release a statement for payment. Never the same hands that computed it.',
    { requiresReason: true },
  ),
  p(
    'payout.statement.pay',
    'payout_statement',
    'update',
    'financial',
    'high',
    'Record that an approved statement was paid, with its reference.',
    { requiresReason: true },
  ),
  p(
    'payout.dispute.raise',
    'payout_dispute',
    'create',
    'hr',
    'medium',
    '\u201cThat consultation was mine.\u201d A statement under dispute is not paid.',
  ),
  p(
    'payout.dispute.resolve',
    'payout_dispute',
    'approve',
    'financial',
    'high',
    'Settle a dispute, with the adjustment and the reasoning.',
    { requiresReason: true },
  ),
  p(
    'payout.tds.read',
    'payout_tds_entry',
    'export',
    'financial',
    'high',
    'Read the section 194J register for filing.',
    { requiresReason: true },
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// OP-006 — ER intake, the ER board and dispositions
//
// `er.quickreg` is deliberately `low` risk and held widely. It is the key that
// gets an unconscious patient a tag, a wristband and a bay in under thirty
// seconds, and a permission model that made it hard to reach would be a
// permission model that killed somebody.
// ─────────────────────────────────────────────────────────────────────────────
const OP006 = group('OP-006', 6, [
  p('er.board.read', 'er_visit', 'list', 'phi', 'low', 'See the ER board: who is here, how sick, how long.'),
  p(
    'er.visit.read',
    'er_visit',
    'read',
    'phi',
    'low',
    'View one ER visit: how they arrived, where they are, and what has happened since.',
    { phiRead: true },
  ),
  p(
    'er.quickreg',
    'er_visit',
    'create',
    'phi',
    'low',
    'Register an arrival in seconds — a name or a tag, and nothing else required.',
  ),
  p('er.visit.update', 'er_visit', 'update', 'phi', 'low', 'Amend the arrival details as they become known.'),
  p(
    'er.identity.merge',
    'er_visit',
    'update',
    'phi',
    'high',
    'Reconcile a temporary tag into a real UHID, carrying every ER record with it.',
    { requiresReason: true },
  ),
  p('er.bay.assign', 'er_bay', 'update', 'operational', 'low', 'Put a patient in a bay, or move them.'),
  p(
    'er.bay.manage',
    'er_bay',
    'manage',
    'operational',
    'medium',
    'Maintain ER zones, bays and their equipment.',
  ),
  p(
    'er.disposition.decide',
    'er_disposition',
    'update',
    'phi',
    'high',
    'End the episode: admit, discharge, refer, LAMA, observation or death.',
    { requiresReason: true },
  ),
  p(
    'er.prealert.receive',
    'er_visit',
    'create',
    'phi',
    'low',
    'Take an ambulance pre-alert and put the inbound patient on the board with an ETA.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// TR-001 — triage, trauma team activation and the golden hour
//
// Two keys here are deliberately `low` and held widely, for the same reason
// `er.quickreg` is: `triage.record.create` and `trauma.activation.create`. The
// published failure mode of every trauma system is under-triage — the team not
// called, or called late — and a permission that makes the call harder to place
// is a permission that produces it. Over-triage costs a surgeon a wasted trip
// downstairs; under-triage costs a patient.
//
// The consequential keys are the ones that *undo* something: standing the team
// down, amending a locked score, closing an MCI. Those carry a reason.
// ─────────────────────────────────────────────────────────────────────────────
const TR001 = group('TR-001', 6, [
  p(
    'triage.record.create',
    'triage_record',
    'create',
    'phi',
    'low',
    'Triage a patient, or re-triage one who has deteriorated. Never overwrites the previous record.',
  ),
  p(
    'triage.record.read',
    'triage_record',
    'read',
    'phi',
    'low',
    'View a triage and the observations behind it.',
    {
      phiRead: true,
    },
  ),
  p(
    'triage.record.list',
    'triage_record',
    'list',
    'phi',
    'low',
    'See the triage history of a visit — every level, in the order it was assigned.',
  ),
  p(
    'triage.level.override',
    'triage_record',
    'override',
    'phi',
    'medium',
    'Assign a level other than the one the algorithm computed. The reason is stored on the record, not in an audit row nobody reads.',
    { requiresReason: true },
  ),
  p(
    'trauma.activation.create',
    'trauma_activation',
    'create',
    'phi',
    'low',
    'Call the trauma team. Held widely: under-triage is the failure mode this permission must not cause.',
  ),
  p(
    'trauma.activation.read',
    'trauma_activation',
    'read',
    'phi',
    'low',
    'View one activation and its pages.',
    {
      phiRead: true,
    },
  ),
  p(
    'trauma.activation.list',
    'trauma_activation',
    'list',
    'phi',
    'low',
    'See the activations running now and the ones that ran today.',
  ),
  p(
    'trauma.activation.standdown',
    'trauma_activation',
    'cancel',
    'phi',
    'medium',
    'Stand the team down. Needs the team leader and a reason — a silent stand-down is how the next page gets ignored.',
    { requiresReason: true },
  ),
  p(
    'trauma.page.acknowledge',
    'activation_page',
    'receive',
    'phi',
    'low',
    'Acknowledge a trauma page and give an ETA. The acknowledgement is the whole point of the page.',
  ),
  p(
    'trauma.survey.record',
    'primary_survey',
    'record',
    'phi',
    'low',
    'Record the ATLS primary survey and its timed interventions. Append-only: a timeline that can be rewritten is not a timeline.',
  ),
  p(
    'trauma.survey.read',
    'primary_survey',
    'read',
    'phi',
    'low',
    'View the primary survey and the golden-hour clocks.',
    {
      phiRead: true,
    },
  ),
  p(
    'trauma.injury.record',
    'trauma_injury',
    'record',
    'phi',
    'low',
    'Code the injuries by AIS region and severity. ISS and NISS are computed from these, never typed.',
  ),
  p(
    'trauma.score.compute',
    'trauma_score',
    'run',
    'phi',
    'low',
    'Compute RTS, ISS, NISS, shock index, MGAP and TRISS from the coded injuries and the arrival physiology.',
  ),
  p('trauma.score.read', 'trauma_score', 'read', 'phi', 'low', 'View the trauma scores and their versions.', {
    phiRead: true,
  }),
  p(
    'trauma.score.lock',
    'trauma_score',
    'sign',
    'phi',
    'medium',
    'Sign off a trauma score. From then on it is immutable and a registry submission can rely on it.',
  ),
  p(
    'trauma.score.amend',
    'trauma_score',
    'amend',
    'phi',
    'high',
    'Supersede a locked score with a corrected version. The original stays; the reason is on the amendment.',
    { requiresReason: true },
  ),
  p(
    'mci.incident.declare',
    'mci_incident',
    'activate',
    'operational',
    'high',
    'Declare a mass-casualty incident. Switches triage to START and calls in the surge roster.',
  ),
  p(
    'mci.incident.standdown',
    'mci_incident',
    'close',
    'operational',
    'medium',
    'Close a mass-casualty incident and file the after-action report.',
    { requiresReason: true },
  ),
  p(
    'mci.incident.read',
    'mci_incident',
    'read',
    'operational',
    'low',
    'See whether an MCI is running, and read the after-action reports of the ones that are not.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// TR-008 — the MLC register, police intimation and the evidence chain
//
// The shape of this group is the opposite of TR-001's. There, calling the team
// is cheap and standing it down is considered. Here, *opening* a case is cheap
// — `mlc.case.create` is `low`, because an MLC that nobody opened because the
// key was hard to reach is a case the hospital cannot later prove it saw — and
// everything that closes, releases or discloses is high and reasoned.
//
// `mlc.sensitive.read` gates sexual-assault, POCSO, dowry and custodial cases.
// It is a separate key rather than a filter on `mlc.case.read` so that holding
// the ordinary key grants nothing here: the default for a case nobody has been
// deliberately given is *no access*, which is the only default that survives a
// case being discussed on a ward round.
// ─────────────────────────────────────────────────────────────────────────────
const TR008 = group('TR-008', 6, [
  p(
    'mlc.case.create',
    'mlc_case',
    'create',
    'phi',
    'low',
    'Open a medico-legal case. Held widely on purpose — an MLC nobody opened is a case the hospital cannot prove it saw.',
  ),
  p('mlc.case.read', 'mlc_case', 'read', 'phi', 'low', 'Read a medico-legal case and its register entry.', {
    phiRead: true,
  }),
  p(
    'mlc.case.update',
    'mlc_case',
    'update',
    'phi',
    'low',
    'Record the history as stated, who brought them, and the consents.',
  ),
  p(
    'mlc.case.cancel',
    'mlc_case',
    'cancel',
    'phi',
    'critical',
    'Medical Superintendent only: cancel an MLC that should not have been opened. The number stays burnt and the entry stays in the register.',
    { requiresReason: true, sensitiveGrant: true },
  ),
  p(
    'mlc.register.read',
    'mlc_case',
    'list',
    'phi',
    'medium',
    'Read the medico-legal register for a branch and year.',
  ),
  p(
    'mlc.intimation.create',
    'mlc_intimation',
    'create',
    'phi',
    'low',
    'Generate the police intimation in the state format. The clock on it starts when the case opens.',
  ),
  p(
    'mlc.intimation.dispatch',
    'mlc_intimation',
    'send',
    'phi',
    'low',
    'Send the intimation and capture the receiving officer’s name, number and signature.',
  ),
  p(
    'mlc.injury.write',
    'mlc_injury',
    'record',
    'phi',
    'low',
    'Document an injury on the forensic body map: site, dimensions, BNS classification and weapon opinion.',
  ),
  p(
    'mlc.evidence.capture',
    'mlc_evidence',
    'create',
    'phi',
    'low',
    'Register a piece of evidence — clothing, a projectile, a swab, a photograph — with its seal number and hash.',
  ),
  p(
    'mlc.evidence.read',
    'mlc_evidence',
    'read',
    'phi',
    'medium',
    'Read the evidence list and verify a custody chain.',
    {
      phiRead: true,
    },
  ),
  p(
    'mlc.custody.transfer',
    'mlc_evidence',
    'update',
    'phi',
    'medium',
    'Record a custody transfer. Append-only and hash-chained; the entry cannot be edited afterwards.',
  ),
  p(
    'mlc.evidence.handover',
    'mlc_evidence',
    'issue',
    'phi',
    'high',
    'Hand evidence to the police against a requisition, with a signed memo. Evidence leaves the hospital once.',
    { requiresReason: true },
  ),
  p(
    'mlc.report.create',
    'mlc_report',
    'create',
    'phi',
    'medium',
    'Draft a wound certificate, MLC report or court document.',
  ),
  p(
    'mlc.report.read',
    'mlc_report',
    'read',
    'phi',
    'medium',
    'Read the certificates and court reports on a case.',
    {
      phiRead: true,
    },
  ),
  p(
    'mlc.report.sign',
    'mlc_report',
    'sign',
    'phi',
    'high',
    'Sign a medico-legal report. It becomes immutable; corrections are addenda.',
  ),
  p(
    'mlc.report.export',
    'mlc_report',
    'export',
    'phi',
    'high',
    'Issue a certified copy into the copy register. Every issue is numbered and audited.',
    { requiresReason: true },
  ),
  p(
    'mlc.request.manage',
    'mlc_request',
    'manage',
    'phi',
    'high',
    'Register and answer a police or court request. The clinical record leaves only against a written authority.',
    { requiresReason: true },
  ),
  p(
    'mlc.sensitive.read',
    'mlc_case',
    'read',
    'phi',
    'critical',
    'Read a sexual-assault, POCSO, dowry or custodial case. A separate key, so the ordinary one grants nothing here.',
    { phiRead: true, requiresReason: true, sensitiveGrant: true },
  ),
  p(
    'mlc.sensitive.write',
    'mlc_case',
    'update',
    'phi',
    'critical',
    'Record the MoHFW sexual-assault protocol: consent, examination, SAFE kit, prophylaxis, referrals.',
    { sensitiveGrant: true },
  ),
  p(
    'mlc.death.write',
    'mlc_death',
    'record',
    'phi',
    'high',
    'Record a death or a brought-dead case, the inquest intimation and body custody.',
  ),
  p(
    'mlc.discharge.override',
    'mlc_case',
    'override',
    'phi',
    'critical',
    'Medical Superintendent only: let a patient leave with the medico-legal set incomplete. The reason is stored on the case, where the register shows it.',
    { requiresReason: true, sensitiveGrant: true },
  ),
  p(
    'mlc.configure',
    'mlc_case',
    'configure',
    'operational',
    'medium',
    'Maintain intimation templates, police stations and the disclosure policy matrix.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// TR-009 + NC-013 — the pre-hospital record and the ambulance fleet
//
// Two data classes in one build, and the keys reflect it. `fleet.*` is
// operational: a dispatcher, a workshop clerk and a fuel-card reconciler all
// hold parts of it and none of them reads a patient record. `prehospital.*` is
// PHI: the crew writing the record, and the ER reading it before the ambulance
// arrives.
//
// The one key that crosses is `prehospital.prealert.read`, held by the whole
// emergency floor — the point of a pre-alert is that the receiving team sees it
// without asking anybody.
// ─────────────────────────────────────────────────────────────────────────────
const NC013 = group('NC-013', 6, [
  p(
    'fleet.vehicle.read',
    'fleet_vehicle',
    'read',
    'operational',
    'low',
    'See the fleet, its status and where each vehicle is.',
  ),
  p(
    'fleet.vehicle.manage',
    'fleet_vehicle',
    'manage',
    'operational',
    'medium',
    'Maintain the vehicle register, its statutory documents and its equipment list.',
  ),
  p(
    'fleet.document.manage',
    'fleet_vehicle',
    'update',
    'operational',
    'medium',
    'Record insurance, fitness, permit and licence renewals. An expired mandatory document stops dispatch.',
  ),
  p(
    'fleet.crew.manage',
    'fleet_crew',
    'manage',
    'hr',
    'medium',
    'Maintain the crew roster, licences and shifts.',
  ),
  p(
    'fleet.request.create',
    'fleet_request',
    'create',
    'operational',
    'low',
    'Ask for an ambulance. Held widely — a ward that cannot call one is a ward that phones somebody instead.',
  ),
  p('fleet.request.read', 'fleet_request', 'list', 'operational', 'low', 'See the ambulance queue.'),
  p(
    'fleet.trip.dispatch',
    'fleet_trip',
    'dispatch',
    'operational',
    'medium',
    'Assign a vehicle and a crew to a request. Refused for a vehicle whose mandatory papers have lapsed.',
  ),
  p('fleet.trip.read', 'fleet_trip', 'read', 'operational', 'low', 'Follow a trip and its milestones.'),
  p(
    'fleet.trip.update',
    'fleet_trip',
    'update',
    'operational',
    'low',
    'Record the milestones: en route, at scene, patient on board, arrived.',
  ),
  p(
    'fleet.trip.divert',
    'fleet_trip',
    'override',
    'operational',
    'high',
    'Send an ambulance somewhere other than where it was going. Names the reason and the decider.',
    { requiresReason: true },
  ),
  p(
    'fleet.trip.close',
    'fleet_trip',
    'close',
    'operational',
    'medium',
    'Close a trip: odometer, distance reconciliation and the SLA result.',
  ),
  p(
    'fleet.checklist.record',
    'fleet_vehicle',
    'inspect',
    'operational',
    'low',
    'Run the shift-start or post-trip check. A failed mandatory item stops the vehicle.',
  ),
  p(
    'fleet.checklist.override',
    'fleet_vehicle',
    'override',
    'operational',
    'high',
    'Send a vehicle out with a failed mandatory check. Names who authorised it and why.',
    { requiresReason: true },
  ),
  p(
    'fleet.fuel.record',
    'fleet_vehicle',
    'record',
    'financial',
    'low',
    'Log a refuelling with the odometer reading.',
  ),
  p(
    'fleet.maintenance.manage',
    'fleet_vehicle',
    'manage',
    'operational',
    'medium',
    'Maintain service intervals, record breakdowns and take a vehicle off the road.',
  ),
  p(
    'fleet.incident.record',
    'fleet_vehicle',
    'record',
    'operational',
    'medium',
    'Report an accident, a speeding event, a complaint or an equipment failure.',
  ),
  p(
    'fleet.report.read',
    'fleet_trip',
    'export',
    'operational',
    'medium',
    'Read the response-time, utilisation and fuel reports.',
    { requiresReason: true },
  ),
]);

const TR009 = group('TR-009', 6, [
  p(
    'prehospital.pcr.write',
    'ph_pcr',
    'record',
    'phi',
    'low',
    'Write the patient care record on the road: observations, interventions, drugs. Append-only once written.',
  ),
  p('prehospital.pcr.read', 'ph_pcr', 'read', 'phi', 'low', 'Read the pre-hospital record for a patient.', {
    phiRead: true,
  }),
  p(
    'prehospital.pcr.sign',
    'ph_pcr',
    'sign',
    'phi',
    'low',
    'Sign the record as the attending crew member. An unsigned record is a draft, and a trip cannot close on one.',
  ),
  p(
    'prehospital.prealert.raise',
    'ph_prealert',
    'create',
    'phi',
    'low',
    'Send the ATMIST ahead to the ER. Held by every crew member — a pre-alert nobody could raise is a resus bay nobody prepared.',
  ),
  p(
    'prehospital.prealert.read',
    'ph_prealert',
    'list',
    'phi',
    'low',
    'See what is inbound, with its ETA and what the crew found.',
    { phiRead: true },
  ),
  p(
    'prehospital.prealert.acknowledge',
    'ph_prealert',
    'receive',
    'phi',
    'low',
    'Acknowledge a pre-alert and hold a bay. The two-minute target is measured from the raise.',
  ),
  p(
    'prehospital.prealert.divert',
    'ph_prealert',
    'override',
    'phi',
    'high',
    'Turn an inbound ambulance away. Names where it is going instead and why.',
    { requiresReason: true },
  ),
  p(
    'prehospital.handover.complete',
    'ph_handover',
    'complete',
    'phi',
    'low',
    'Complete the handover: identity, both signatures, and the controlled-drug reconciliation.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// TR-002 + OP-009 — the fracture registry and the orthopaedic OPD
//
// A provisional entry is `low` and held by anybody who sees the film first,
// because a fracture nobody registered is a fracture the registry never counts
// and a follow-up nobody schedules. *Confirming* the classification is the
// surgeon's, because an AO code is a treatment decision written as a number.
// ─────────────────────────────────────────────────────────────────────────────
const TR002 = group('TR-002', 6, [
  p(
    'fracture.record.create',
    'fracture',
    'create',
    'phi',
    'low',
    'Register a fracture provisionally: bone, side, and what the film shows. Held widely — an unregistered fracture is one nobody follows up.',
  ),
  p('fracture.record.read', 'fracture', 'read', 'phi', 'low', 'Open a fracture and its healing timeline.', {
    phiRead: true,
  }),
  p(
    'fracture.record.list',
    'fracture',
    'list',
    'phi',
    'low',
    'See the fracture registry for a patient or a clinic.',
  ),
  p(
    'fracture.record.update',
    'fracture',
    'update',
    'phi',
    'low',
    'Amend the classification. Every change keeps a snapshot of what it said before.',
  ),
  p(
    'fracture.classification.confirm',
    'fracture',
    'validate',
    'phi',
    'medium',
    'Sign off the AO/OTA classification. An open fracture cannot be confirmed without its Gustilo grade.',
  ),
  p(
    'fracture.plan.set',
    'fracture_plan',
    'create',
    'phi',
    'medium',
    'Set the treatment intent and the weight-bearing status. The side is checked against the fracture — a mismatch is refused.',
  ),
  p(
    'fracture.event.record',
    'fracture',
    'record',
    'phi',
    'low',
    'Add to the timeline: reduction, surgery, cast, pin-site care.',
  ),
  p(
    'fracture.imaging.assess',
    'fracture',
    'annotate',
    'phi',
    'low',
    'Attach a film and score the union: RUST, alignment, implant state.',
  ),
  p(
    'fracture.union.declare',
    'fracture',
    'complete',
    'phi',
    'medium',
    // Deliberately *not* `requiresReason`. A fracture that healed at fourteen
    // weeks needs no justification, and demanding one for every declaration
    // teaches people to type "healed" into a reason box — which then means
    // nothing on the declaration that genuinely needs grounds. The early
    // non-union case asks for them in the service, where the six-month rule
    // actually lives.
    'Declare union, or non-union. Non-union before six months needs stated grounds, asked for at the time.',
  ),
  p(
    'fracture.complication.record',
    'fracture',
    'record',
    'phi',
    'low',
    'Record an infection, a non-union, a compartment syndrome.',
  ),
  p(
    'fracture.registry.export',
    'fracture',
    'export',
    'phi',
    'high',
    'Export the registry dataset. Pseudonymised, and every export is audited with its filter and count.',
    { requiresReason: true },
  ),
]);

const OP009 = group('OP-009', 6, [
  p(
    'ortho.episode.create',
    'ortho_episode',
    'create',
    'phi',
    'low',
    'Open an orthopaedic OPD episode with its anchor date.',
  ),
  p(
    'ortho.episode.read',
    'ortho_episode',
    'read',
    'phi',
    'low',
    'Open an orthopaedic episode and its follow-up schedule.',
    {
      phiRead: true,
    },
  ),
  p(
    'ortho.exam.record',
    'ortho_episode',
    'record',
    'phi',
    'low',
    'Record the range-of-motion and power grid.',
  ),
  p(
    'ortho.followup.schedule',
    'ortho_episode',
    'plan',
    'phi',
    'low',
    'Generate the follow-up schedule from a protocol, at offsets from the anchor rather than from today.',
  ),
  p(
    'ortho.prom.collect',
    'ortho_episode',
    'record',
    'phi',
    'low',
    'Collect a patient-reported outcome measure.',
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// TR-003 — implant traceability
//
// The severity here is set by what a mistake costs at recall time, not by how
// consequential the click feels. Recording a device is `low` and held by the
// scrub nurse who is holding the box, because the alternative — the surgeon
// entering it from memory in the evening — is how a lot number becomes wrong.
// Overriding the scan is where the reason is demanded, because a manual entry
// is the one that will not match anything when the field safety notice arrives.
// ─────────────────────────────────────────────────────────────────────────────
const TR003 = group('TR-003', 6, [
  p(
    'implant.catalogue.read',
    'implant_catalogue',
    'read',
    'operational',
    'low',
    'Look up a device: its UDI, its MRI conditionality, what it costs.',
  ),
  p(
    'implant.catalogue.manage',
    'implant_catalogue',
    'update',
    'operational',
    'medium',
    'Add or amend a catalogue entry. The UDI-DI is unique per hospital — two entries for one device is two half-populated recall lists.',
  ),
  p(
    'implant.stock.read',
    'implant_stock',
    'read',
    'operational',
    'low',
    'See what is on the shelf, its lot, and when it expires.',
  ),
  p(
    'implant.stock.receive',
    'implant_stock',
    'create',
    'operational',
    'low',
    'Book a device in against its serial or its lot. A device with neither is refused — it cannot be recalled.',
  ),
  p(
    'implant.stock.adjust',
    'implant_stock',
    'update',
    'operational',
    'medium',
    'Quarantine, waste or return a device. An implanted one cannot go back to available.',
  ),
  p(
    'implant.usage.record',
    'implant_usage',
    'create',
    'phi',
    'low',
    'Record a device into a patient. Held by whoever is at the trolley — the box is in their hand and the barcode is on it.',
  ),
  p(
    'implant.usage.manual',
    'implant_usage',
    'override',
    'phi',
    'medium',
    'Record a device without scanning it. The reason is kept with the record, because a hand-typed serial is the one that will not match a recall.',
    { requiresReason: true },
  ),
  p(
    'implant.usage.read',
    'implant_usage',
    'read',
    'phi',
    'low',
    'See what is inside a patient — and its MRI conditionality before they go in the scanner.',
    { phiRead: true },
  ),
  p(
    'implant.usage.explant',
    'implant_usage',
    'update',
    'phi',
    'medium',
    'Record that a device came out, and why. The record is never deleted; an explant is an ending, not an erasure.',
  ),
  p(
    'implant.recall.manage',
    'implant_recall',
    'create',
    'operational',
    'high',
    'Open a field safety notice against a device or a list of lots, and work it to closure.',
  ),
  p(
    'implant.recall.read',
    'implant_recall',
    'read',
    'phi',
    'medium',
    'See who is carrying a recalled device, and where each of them has got to.',
    { phiRead: true },
  ),
  p(
    'implant.recall.contact',
    'implant_recall',
    'record',
    'phi',
    'low',
    'Record an attempt to reach a patient on a recall, and what came of it.',
  ),
  p(
    'implant.trace.query',
    'implant_usage',
    'export',
    'phi',
    'high',
    'The recall query: given a UDI or a lot, the exact list of patients carrying it. Audited every time, because it is a list of names.',
    { requiresReason: true },
  ),
]);

// ─────────────────────────────────────────────────────────────────────────────
// TR-005 — cast, splint, brace and traction
//
// Applying plaster is a technician's job and reads that way. The one key that
// is not routine is removing a cast against the plan, because a cast that comes
// off three weeks early is a fracture that displaces in the car park.
// ─────────────────────────────────────────────────────────────────────────────
const TR005 = group('TR-005', 6, [
  p(
    'cast.request.create',
    'cast_request',
    'create',
    'phi',
    'low',
    'Ask for a cast, splint, brace or traction. The side is checked against the fracture.',
  ),
  p('cast.request.read', 'cast_request', 'read', 'phi', 'low', 'See the plaster-room list.', {
    phiRead: true,
  }),
  p(
    'cast.apply',
    'cast_application',
    'create',
    'phi',
    'low',
    'Record what was applied, in what position, and when it is next to be checked.',
  ),
  p(
    'cast.check.record',
    'cast_check',
    'record',
    'phi',
    'low',
    'Record a neurovascular check. The red flag is computed from the findings, and a red flag with no action is refused.',
  ),
  p(
    'cast.remove',
    'cast_application',
    'complete',
    'phi',
    'medium',
    'Take a cast off. Before the planned date it needs stated grounds — an early removal is a fracture that can still displace.',
    { requiresReason: true },
  ),
  p(
    'cast.pinsite.manage',
    'pin_site_schedule',
    'update',
    'phi',
    'low',
    'Run the pin-site care schedule and grade the sites, Checketts-Otterburn 1 to 6.',
  ),
]);

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

  // Phase 4
  ...NC006,
  ...NC005,
  ...NC007,
  ...NC008,
  ...NC021,
  ...OP003,

  // Phase 5
  ...RC003,
  ...OP005,
  ...EN010,
  ...OP023,
  ...EN002,
  ...RC002,
  ...RC007,
  ...RC008,
  ...RC006,
  ...NC034,

  // Phase 6
  ...OP006,
  ...TR001,
  ...TR008,
  ...NC013,
  ...TR009,
  ...TR002,
  ...OP009,
  ...TR003,
  ...TR005,
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

  // Phase 4. `docs/04 §3`: "maker ≠ checker for discounts, refunds, POs,
  // payroll, result validation, blood issue, narcotics", and NC-005 §12,
  // NC-006 §12, NC-007 §12, NC-008 §12 and NC-021 §12 name the rest.
  {
    permA: 'inventory.po.create',
    permB: 'inventory.po.approve',
    mode: 'block',
    reason:
      'docs/04 §3 and NC-005 §12: creator ≠ approver on a purchase order. One hand raising and approving an order is the whole of procurement fraud in a single click.',
  },
  {
    permA: 'inventory.grn.post',
    permB: 'inventory.invoice.approve',
    mode: 'block',
    reason:
      'NC-005 §12: "invoice approver ≠ GRN poster". Whoever says the goods arrived must not also be the person who says pay for them — that pair is enough to invent a delivery.',
  },
  {
    permA: 'inventory.grn.post',
    permB: 'inventory.po.create',
    mode: 'warn',
    reason:
      'NC-005 §12 makes "GRN poster ≠ PO creator" configurable rather than absolute, because a small store legitimately does both. It warns so the hospital sees the exposure and decides deliberately.',
  },
  {
    permA: 'inventory.adjustment.create',
    permB: 'inventory.adjustment.approve',
    mode: 'block',
    reason:
      'A write-off that its own author approves is not a control. `inventory.adjustments` already refuses the row; this stops the pair reaching one person in the first place.',
  },
  {
    permA: 'inventory.count.count',
    permB: 'inventory.count.approve',
    mode: 'block',
    reason:
      'NC-006 §5: "SoD for count vs approve". Counting the shelf and approving your own variance means the count can be made to say whatever the balance already says.',
  },
  {
    permA: 'finance.allocation.run',
    permB: 'finance.allocation.post',
    mode: 'warn',
    reason:
      'NC-008 §14 AC-7 requires the management journal to be posted "by a user other than the runner" — but docs/05 row 46 is a single "Accountant / Finance Manager" template that legitimately staffs both chairs, so blocking it at role level would make the role unexpressible. It warns, and the per-run check is the enforcement: `consumption.allocation.posted` carries `runBy` and `postedBy` as separate fields precisely so the service can refuse them being equal.',
  },
  {
    permA: 'vendor.master.manage',
    permB: 'vendor.master.approve',
    mode: 'block',
    reason:
      'NC-021 §12: "onboarding creator ≠ approver". A vendor somebody created and approved alone is a payee with no second pair of eyes on its existence.',
  },
  {
    permA: 'vendor.master.manage',
    permB: 'vendor.bank.approve',
    mode: 'block',
    reason:
      'NC-021 §5 makes a bank change maker-checker with call-back verification. Holding both halves turns the call-back into a formality the same person performs on themselves.',
  },
  {
    permA: 'vendor.action.propose',
    permB: 'vendor.action.approve',
    mode: 'block',
    reason:
      'NC-021 §5: "blacklist proposer ≠ approver", after a show-cause notice and a response window. Ending a commercial relationship on one signature is not defensible when the vendor contests it.',
  },
  {
    permA: 'inventory.consignment.use',
    permB: 'inventory.consignment.sign',
    mode: 'warn',
    reason:
      'NC-007 §12 keeps the usage scanner away from the reconciliation signer for the same case, but makes it configurable — a small theatre has one coordinator. It warns rather than blocks so the exposure is visible.',
  },
  {
    permA: 'preauth.submit',
    permB: 'preauth.decision.record',
    mode: 'block',
    reason:
      'RC-002 §5. The person who assembles and submits a pre-auth must not be the one who records what the payer decided: an invented approval becomes a credit limit billing honours, and the insurer refuses it months later with the patient already discharged.',
  },
  {
    permA: 'payout.statement.compute',
    permB: 'payout.statement.approve',
    mode: 'block',
    reason:
      'NC-034 §5.7. A payout statement is an outbound payment authorised on the strength of a calculation nobody else has looked at. The person who ran it does not also release it.',
  },
  {
    permA: 'scheme.claim.submit',
    permB: 'scheme.claim.decision.record',
    mode: 'block',
    reason:
      'RC-007 §5.6. The person chasing a scheme claim must not be the one who types in what the authority paid: an invented settlement closes a case and stops anybody chasing money that never arrived.',
  },
  {
    permA: 'scheme.shortfall.appeal',
    permB: 'scheme.shortfall.writeoff.approve',
    mode: 'block',
    reason:
      'RC-007 §5.6. A write-off is revenue the hospital gives up. The person who worked the claim has every reason to make an awkward shortfall disappear quietly, so they cannot also be the one who agrees it is gone.',
  },
  {
    permA: 'pkg.variance.request',
    permB: 'pkg.variance.approve',
    mode: 'block',
    reason:
      'OP-023 §5 requires excess approval before the overrun reaches the bill. One person holding both halves can bill a patient past a fixed-price promise on their own signature, which is the complaint package pricing exists to avoid.',
  },
  {
    permA: 'pay.refund.request',
    permB: 'pay.refund.approve',
    mode: 'block',
    reason:
      'A refund moves money out of the hospital through the same instrument it came in on. One person holding both halves can originate and release a payment to an account of their choosing, which is the single largest fraud exposure in the payment path (EN-010 §5, OP-005 §5).',
  },
  {
    permA: 'bill.discount.request',
    permB: 'bill.discount.approve',
    mode: 'block',
    reason:
      'OP-005 §5: "approval matrix mandatory; reason codes; requester ≠ approver". A biller who can approve their own discount is the discount matrix, and the register of who authorised what stops meaning anything.',
  },
  {
    permA: 'tariff.version.submit',
    permB: 'tariff.version.publish',
    mode: 'block',
    reason:
      'RC-003 §5: "Requester ≠ approver, always." A published tariff version prices every bill line in its window from that instant, so one person holding both halves can reprice the hospital unilaterally and the approval matrix becomes a formality performed on themselves.',
  },
  {
    permA: 'pharmacy.dispense.create',
    permB: 'pharmacy.return.approve',
    mode: 'warn',
    reason:
      'A counter that dispenses and approves its own high-value returns can round-trip stock and cash through one till. OP-003 §3 puts returns above the threshold with the in-charge, and this makes a clone that does not do so visible.',
  },
]);
