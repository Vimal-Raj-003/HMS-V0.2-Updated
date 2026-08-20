import { ENFORCEMENT_POINTS, SEVERITY_DEFAULTS } from '@vims/contracts';
import type { SeedContext } from './context.js';
import { SEED_EPOCH, seedId } from './ids.js';
import { jsonb, type SeedRow } from './upsert.js';
import { mainBranchOf, type SeededTenancy } from './tenancy.js';

/**
 * Tier `demo` and above: the module configuration a hospital would have on
 * day one.
 *
 * Everything here is *configuration*, not activity — a notification type, an
 * approval matrix, a print template, a printer, a board. It is what makes the
 * admin console screens in `phase-00 §0.5` render something real instead of an
 * empty state, and what the Phase-1 modules will publish against.
 */
export async function seedModuleConfiguration(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  await seedNotificationCatalogue(ctx, tenancy);
  await seedWorkflowCatalogue(ctx, tenancy);
  await seedTemplates(ctx, tenancy);
  await seedPrinting(ctx, tenancy);
  await seedDisplay(ctx, tenancy);
  await seedLicensing(ctx, tenancy);
  await seedSso(ctx, tenancy);
  await seedIntegration(ctx, tenancy);
  await seedBarcode(ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// EN-037 — notification types and the escalation ladder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `EN-037 §3.1` gives `lab.critical_value` in full; the rest follow the same
 * shape at the severity the spec's table assigns them. Channel sets and the
 * quiet-hours behaviour are read from `SEVERITY_DEFAULTS` in
 * `packages/contracts` rather than restated here, so the database can never
 * disagree with the contract about what `critical` means.
 */
const NOTIFICATION_TYPES: readonly {
  key: string;
  name: string;
  category: string;
  severity: 'info' | 'low' | 'normal' | 'high' | 'critical';
  ownerModule: string;
  retentionDays: number;
  dedupe?: string;
  ladder?: boolean;
}[] = [
  {
    key: 'lab.critical_value',
    name: 'Critical laboratory value',
    category: 'clinical_safety',
    severity: 'critical',
    ownerModule: 'EN-029',
    retentionDays: 3650,
    dedupe: 'patient_id + test_id',
    ladder: true,
  },
  {
    key: 'patient.deterioration',
    name: 'Patient deterioration (NEWS2 ≥ 7)',
    category: 'clinical_safety',
    severity: 'critical',
    ownerModule: 'EN-029',
    retentionDays: 3650,
    dedupe: 'patient_id',
    ladder: true,
  },
  {
    key: 'code.blue.activated',
    name: 'Code blue activated',
    category: 'clinical_safety',
    severity: 'critical',
    ownerModule: 'EN-018',
    retentionDays: 3650,
    ladder: true,
  },
  {
    key: 'workflow.request.raised',
    name: 'Approval requested',
    category: 'approvals',
    severity: 'normal',
    ownerModule: 'EN-038',
    retentionDays: 2555,
    dedupe: 'request_id',
  },
  {
    key: 'workflow.sla.breached',
    name: 'Approval SLA breached',
    category: 'approvals',
    severity: 'high',
    ownerModule: 'EN-038',
    retentionDays: 2555,
    dedupe: 'request_id',
  },
  {
    key: 'integration.circuit.opened',
    name: 'Integration connector unavailable',
    category: 'it_system',
    severity: 'high',
    ownerModule: 'EN-017',
    retentionDays: 365,
    dedupe: 'connector_id',
  },
  {
    key: 'licence.degradation.scheduled',
    name: 'Subscription restrictions scheduled',
    category: 'it_system',
    severity: 'high',
    ownerModule: 'EN-040',
    retentionDays: 2920,
  },
  {
    key: 'print.job.failed',
    name: 'Print job failed',
    category: 'it_system',
    severity: 'normal',
    ownerModule: 'EN-005',
    retentionDays: 365,
    dedupe: 'printer_id',
  },
  {
    key: 'registration.document.expiring',
    name: 'Statutory registration expiring',
    category: 'quality',
    severity: 'low',
    ownerModule: 'EN-041',
    retentionDays: 2555,
  },
  {
    key: 'system.announcement',
    name: 'System announcement',
    category: 'announcement',
    severity: 'info',
    ownerModule: 'EN-007',
    retentionDays: 90,
  },
];

async function seedNotificationCatalogue(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  // The escalation ladder is per hospital (a ladder names that hospital's roles),
  // so it is written first and referenced by key from the system type catalogue.
  const ladders: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    ladders.push({
      id: seedId('notif-ladder', h.code, 'clinical_critical'),
      hospital_id: h.id,
      key: 'clinical_critical',
      name: 'Critical clinical alert ladder',
      scope: jsonb({}),
      // EN-037 §3.1: L1 ordering doctor (0 min) → L2 ward nurse in-charge +
      // duty doctor (10 min) → L3 intensivist (20 min) → L4 Medical
      // Superintendent (30 min). Each rung fires *in addition to* the previous.
      rungs: jsonb([
        {
          level: 1,
          delaySeconds: 0,
          audience: [{ kind: 'care_relation', relation: 'ordering_doctor' }],
          channels: ['inapp', 'web_push', 'sms'],
          repeatEverySeconds: 300,
          maxRepeats: 2,
        },
        {
          level: 2,
          delaySeconds: 600,
          audience: [
            { kind: 'role_in_scope', roleKey: 'nurse_incharge', scope: 'ward', scopeRef: 'patient.ward_id' },
            { kind: 'oncall', roleKey: 'duty_medical_officer' },
          ],
          channels: ['inapp', 'web_push', 'sms'],
          repeatEverySeconds: 300,
          maxRepeats: 2,
        },
        {
          level: 3,
          delaySeconds: 600,
          audience: [{ kind: 'oncall', speciality: 'critical_care', roleKey: 'intensivist' }],
          channels: ['inapp', 'web_push', 'sms', 'voice'],
          repeatEverySeconds: 300,
          maxRepeats: 2,
        },
        {
          level: 4,
          delaySeconds: 600,
          audience: [{ kind: 'role_in_scope', roleKey: 'medical_superintendent', scope: 'hospital' }],
          channels: ['inapp', 'web_push', 'sms', 'voice'],
          repeatEverySeconds: null,
          maxRepeats: 0,
        },
      ]),
      // EN-037 §3.4.6: the system never gives up silently.
      exhausted_action: jsonb({
        raiseEvent: 'notification.escalation.exhausted',
        surfaceOn: ['nursing_command_centre', 'medical_superintendent_dashboard'],
        classify: 'quality_incident',
      }),
      active: true,
      version: 1,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
      deleted_at: null,
    });
  }
  await ctx.write({ table: 'core.notif_escalation_ladders', conflict: ['id'] }, ladders);

  const types: SeedRow[] = NOTIFICATION_TYPES.map((t) => {
    const defaults = SEVERITY_DEFAULTS[t.severity];
    return {
      id: seedId('notif-type', t.key),
      // System catalogue: readable by every tenant, writable by none of them.
      hospital_id: null,
      key: t.key,
      name: t.name,
      category: t.category,
      severity: t.severity,
      must_acknowledge: defaults.mustAcknowledge,
      ack_window_sec: defaults.defaultAckWindowSeconds,
      audience_expr: jsonb(
        t.category === 'clinical_safety'
          ? [{ kind: 'care_relation', relation: 'ordering_doctor' }]
          : [{ kind: 'role_in_scope', roleKey: 'it_admin', scope: 'hospital' }],
      ),
      channels_by_severity: jsonb({ [t.severity]: defaults.channels }),
      quiet_hours_override: defaults.quietHoursOverride,
      dedupe_key_expr: t.dedupe ?? null,
      // EN-037 §5: dedupe and coalescing may never apply to `critical`.
      dedupe_window_sec: t.severity === 'critical' ? 0 : 900,
      coalesce_policy: defaults.mayCoalesce ? 'digest_hourly' : 'none',
      escalation_ladder_id: null,
      // EN-037 §5: an SMS preview may carry location and urgency only.
      external_content_policy: 'minimal',
      payload_schema: jsonb({}),
      payload_fields:
        t.category === 'clinical_safety' ? ['patient_banner', 'location', 'urgency'] : ['summary'],
      retention_days: t.retentionDays,
      owner_module: t.ownerModule,
      status: 'active',
      version: 1,
      rate_ceiling_per_hour: t.severity === 'critical' ? null : 200,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
      deleted_at: null,
    };
  });
  await ctx.write({ table: 'core.notif_types', conflict: ['id'] }, types);
}

// ─────────────────────────────────────────────────────────────────────────────
// EN-038 — processes and their matrices
// ─────────────────────────────────────────────────────────────────────────────

const PROCESSES: readonly (readonly [
  key: string,
  name: string,
  domain: string,
  nonDelegable: boolean,
  breachDefault: string,
  ownerModule: string,
])[] = [
  ['admin.role.grant', 'Sensitive role grant', 'it', true, 'escalate', 'EN-007'],
  ['admin.settings.change', 'Settings change requiring approval', 'it', false, 'escalate', 'EN-007'],
  ['mdm.change_set.activate', 'Master data change set', 'master_data', false, 'escalate', 'EN-027'],
  ['tpl.template.publish', 'Template publication', 'quality', false, 'escalate', 'EN-039'],
  ['lic.override.grant', 'Licence entitlement override', 'finance', true, 'escalate', 'EN-040'],
  ['ihub.connector.activate', 'Integration connector activation', 'it', true, 'escalate', 'EN-017'],
  ['wf.bypass.ratify', 'Emergency bypass ratification', 'quality', true, 'escalate', 'EN-038'],
];

async function seedWorkflowCatalogue(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const processes: SeedRow[] = PROCESSES.map(([key, name, domain, nonDelegable, breach, owner]) => ({
    id: seedId('wf-process', key),
    hospital_id: null,
    key,
    name,
    domain,
    context_schema: jsonb({}),
    outcome_contract: jsonb({ callback: `${owner}.on_decision` }),
    allows_modification: false,
    non_delegable: nonDelegable,
    requires_esign: false,
    sod_rules: jsonb([]),
    // EN-038 §5: auto-approve on SLA breach is prohibited for clinical safety,
    // financial disbursement, statutory and narcotic processes. Every Phase-0
    // process escalates instead.
    breach_default: breach,
    urgency_allowed: true,
    bypass_allowed: key === 'ihub.connector.activate' ? false : true,
    active_matrix_id: null,
    status: 'active',
    owner_module: owner,
    created_at: SEED_EPOCH,
    created_by: null,
    updated_at: SEED_EPOCH,
    updated_by: null,
    deleted_at: null,
  }));
  await ctx.write({ table: 'core.wf_processes', conflict: ['id'] }, processes);

  const matrices: SeedRow[] = [];
  const versions: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const [key, name] of PROCESSES) {
      const matrixId = seedId('wf-matrix', h.code, key);
      matrices.push({
        id: matrixId,
        hospital_id: h.id,
        branch_id: null,
        process_key: key,
        name: `${name} — default matrix`,
        current_version: 1,
        status: 'active',
        owner_role: 'hospital_admin',
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
        deleted_at: null,
      });

      const rules = [
        {
          priority: 100,
          conditionAst: { op: 'always' },
          continueEvaluation: false,
          stages: [
            {
              kind: 'serial',
              approvers: [{ kind: 'role', roleKey: 'hospital_admin', scope: 'hospital' }],
              quorumN: null,
              sla: { hours: 24, calendar: 'standard' },
              reminders: [{ afterHours: 8 }, { afterHours: 16 }],
              breachAction: 'escalate',
              skipCondition: null,
              requiresEsign: false,
            },
          ],
        },
      ];

      versions.push({
        id: seedId('wf-matrix-version', h.code, key, '1'),
        hospital_id: h.id,
        matrix_id: matrixId,
        version: 1,
        rules: jsonb(rules),
        effective_from: SEED_EPOCH,
        effective_to: null,
        published_by: null,
        published_at: SEED_EPOCH,
        approval_ref: null,
        simulation_ref: null,
        // A real checksum is computed over the canonicalised rules at publish
        // time; the seed derives it the same deterministic way.
        checksum: seedId('wf-matrix-checksum', h.code, key, '1').replace(/-/g, ''),
        immutable: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
      });
    }
  }
  await ctx.write({ table: 'core.wf_matrices', conflict: ['id'] }, matrices);
  await ctx.write({ table: 'core.wf_matrix_versions', conflict: ['id'] }, versions);
}

// ─────────────────────────────────────────────────────────────────────────────
// EN-039 — form and print templates, and the branding a document carries
// ─────────────────────────────────────────────────────────────────────────────

async function seedTemplates(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const forms: readonly (readonly [string, string, string, boolean])[] = [
    ['intake.registration', 'Patient registration intake', 'intake', false],
    ['assessment.vitals', 'Vitals record', 'flowsheet', false],
    ['checklist.who_surgical_safety', 'WHO surgical safety checklist', 'checklist', true],
    ['consent.general_treatment', 'General treatment consent', 'consent_body', true],
  ];

  const templates: SeedRow[] = [];
  const versions: SeedRow[] = [];
  for (const [key, name, category, signable] of forms) {
    const templateId = seedId('tpl-form', key);
    templates.push({
      id: templateId,
      hospital_id: null,
      key,
      name,
      category,
      scope: 'system',
      console_code: null,
      department_ids: [],
      produces_clinical_document: signable,
      signable,
      roles_allowed: [],
      current_version: 1,
      review_due_at: null,
      owner_user_id: null,
      status: 'published',
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
      deleted_at: null,
    });
    versions.push({
      id: seedId('tpl-form-version', key, '1'),
      hospital_id: null,
      template_id: templateId,
      version: 1,
      schema_def: jsonb({
        sections: [{ key: 'main', label: { 'en-IN': name } }],
        fields: [
          {
            key: 'notes',
            type: 'text',
            label: { 'en-IN': 'Notes' },
            required: false,
            phiClass: 'phi',
            promoteToColumn: false,
          },
        ],
      }),
      logic: jsonb({}),
      calculations: jsonb({}),
      layout: jsonb({ desktop: '1-col', tablet: '1-col', phone: '1-col' }),
      fixtures: jsonb({}),
      migration_rules: jsonb({}),
      fhir_mapping: jsonb({}),
      effective_from: SEED_EPOCH,
      effective_to: null,
      published_by: null,
      published_at: SEED_EPOCH,
      approval_ref: null,
      checksum: seedId('tpl-form-checksum', key, '1').replace(/-/g, ''),
      immutable: true,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
    });
  }
  await ctx.write({ table: 'core.tpl_form_templates', conflict: ['id'] }, templates);
  await ctx.write({ table: 'core.tpl_form_versions', conflict: ['id'] }, versions);

  // EN-005 §4.1 document-type catalogue → the print templates that render them.
  const printFamilies: readonly (readonly [string, string, string, string])[] = [
    ['token', 'Queue token', 'thermal', 'escpos'],
    ['op_receipt', 'OP receipt', 'billing', 'escpos'],
    ['gst_invoice', 'GST invoice (A4)', 'billing', 'pdf'],
    ['lab_label', 'Specimen label', 'label', 'zpl'],
    ['wristband', 'Patient wristband', 'wristband', 'zpl'],
    ['prescription', 'Prescription', 'clinical', 'pdf'],
    ['discharge_summary', 'Discharge summary', 'clinical', 'pdf'],
    ['consent_form', 'Consent form', 'consent', 'pdf'],
  ];

  const printTemplates: SeedRow[] = [];
  const printVersions: SeedRow[] = [];
  const branding: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    for (const [key, name, family, output] of printFamilies) {
      const id = seedId('tpl-print', h.code, key);
      printTemplates.push({
        id,
        hospital_id: h.id,
        branch_id: null,
        key,
        name,
        family,
        page:
          output === 'pdf'
            ? {
                size: 'A4',
                orientation: 'portrait',
                margins: { top: 18, right: 12, bottom: 18, left: 12 },
                duplex: true,
              }
            : { size: output === 'zpl' ? 'label_2x1' : '80mm', orientation: 'portrait' },
        header: { branding: true, patientBanner: family === 'clinical' },
        footer: { pageXofY: output === 'pdf' },
        // EN-039 §5: a reprint of a financial or clinical document prints
        // COPY/DUPLICATE unless the user holds an override permission.
        watermark: { duplicate: 'DUPLICATE', cancelled: 'CANCELLED', draft: 'DRAFT — NOT FOR CLINICAL USE' },
        blocks: jsonb([{ type: 'body', binding: 'context' }]),
        languages: ['en-IN'],
        bilingual_mode: 'none',
        output,
        target_device_profile: output === 'pdf' ? null : output,
        current_version: 1,
        status: 'published',
        review_due_at: null,
        owner_user_id: null,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
        deleted_at: null,
      });
      printVersions.push({
        id: seedId('tpl-print-version', h.code, key, '1'),
        hospital_id: h.id,
        print_template_id: id,
        version: 1,
        definition: jsonb({ blocks: [{ type: 'body', binding: 'context' }] }),
        css: null,
        sample_context: jsonb({ demo: true }),
        effective_from: SEED_EPOCH,
        published_by: null,
        published_at: SEED_EPOCH,
        approval_ref: null,
        checksum: seedId('tpl-print-checksum', h.code, key, '1').replace(/-/g, ''),
        immutable: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
      });
    }

    branding.push({
      id: seedId('tpl-branding', h.code),
      hospital_id: h.id,
      branch_id: null,
      logo_light_file_id: null,
      logo_dark_file_id: null,
      legal_name: h.legalName,
      address: { line1: `1 Demo Road, ${h.code}`, country: 'IN' },
      contacts: { phone: '+918000000000' },
      gstin: h.gstin,
      licences: { clinicalEstablishment: `KA/CE/DEMO/${h.code}`, nabh: `NABH-DEMO-${h.code}` },
      colours: { primary: 'brand-primary', accent: 'brand-accent' },
      fonts: { body: 'Inter', mono: 'JetBrains Mono' },
      footer_disclaimer_i18n: {
        'en-IN': 'This document is computer generated and valid without signature unless otherwise stated.',
      },
      effective_from: SEED_EPOCH,
      effective_to: null,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
    });
  }

  await ctx.write({ table: 'core.tpl_print_templates', conflict: ['id'] }, printTemplates);
  await ctx.write({ table: 'core.tpl_print_versions', conflict: ['id'] }, printVersions);
  await ctx.write({ table: 'core.tpl_branding', conflict: ['id'] }, branding);
}

// ─────────────────────────────────────────────────────────────────────────────
// EN-005 — print agents, printers, mappings and auto-print rules
// ─────────────────────────────────────────────────────────────────────────────

async function seedPrinting(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const agents: SeedRow[] = [];
  const printers: SeedRow[] = [];
  const mappings: SeedRow[] = [];
  const rules: SeedRow[] = [];
  const workstations: SeedRow[] = [];

  const printerSpecs: readonly (readonly [string, string, string, string, string])[] = [
    ['THERMAL-1', 'Front office thermal', 'thermal', 'raw_escpos', '80mm'],
    ['LABEL-1', 'Sample collection label', 'label', 'raw_zpl', 'label_2x1'],
    ['LASER-1', 'Billing laser', 'laser', 'pdf', 'A4'],
    ['BAND-1', 'Admission wristband', 'label', 'raw_zpl', 'wristband'],
  ];

  for (const h of tenancy.hospitals) {
    for (const b of h.branches) {
      const agentId = seedId('print-agent', h.code, b.code);
      agents.push({
        id: agentId,
        hospital_id: h.id,
        branch_id: b.id,
        name: `${b.shortName} print agent`,
        host: `print-agent-${b.code.toLowerCase()}.demo.local`,
        os: 'linux',
        agent_version: '0.1.0',
        device_id: null,
        last_heartbeat_at: null,
        status: 'unpaired',
        ip: null,
        capabilities: { escpos: true, zpl: true, pdf: true },
        pairing_code: null,
        pairing_expires_at: null,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        deleted_at: null,
      });

      for (const [code, name, kind, driverMode, paper] of printerSpecs) {
        const printerId = seedId('print-printer', h.code, b.code, code);
        printers.push({
          id: printerId,
          hospital_id: h.id,
          branch_id: b.id,
          agent_id: agentId,
          name: `${b.shortName} ${name}`,
          kind,
          connection: 'agent_os_printer',
          address: `${code.toLowerCase()}.${b.code.toLowerCase()}`,
          driver_mode: driverMode,
          paper,
          dpi: kind === 'label' ? 203 : 300,
          location_id: null,
          department_id: null,
          counter_id: null,
          capabilities: {},
          cost_per_page: { mono: '0.40', colour: '2.50' },
          status: 'unknown',
          last_status_at: null,
          active: true,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          deleted_at: null,
        });
      }

      // EN-005 §3.2: document type → printer, at branch scope. Narrower scopes
      // (workstation, counter, user) override these at resolution time.
      const docMap: readonly (readonly [string, string])[] = [
        ['token', 'THERMAL-1'],
        ['op_receipt', 'THERMAL-1'],
        ['gst_invoice', 'LASER-1'],
        ['lab_label', 'LABEL-1'],
        ['wristband', 'BAND-1'],
        ['prescription', 'LASER-1'],
        ['discharge_summary', 'LASER-1'],
        ['consent_form', 'LASER-1'],
      ];
      for (const [docType, printerCode] of docMap) {
        mappings.push({
          id: seedId('print-mapping', h.code, b.code, docType),
          hospital_id: h.id,
          branch_id: b.id,
          doc_type: docType,
          scope_type: 'branch',
          scope_id: b.id,
          printer_id: seedId('print-printer', h.code, b.code, printerCode),
          template_key: docType,
          copies: 1,
          options: { duplex: docType === 'discharge_summary' },
          priority: 100,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          deleted_at: null,
        });
      }

      workstations.push({
        id: seedId('print-workstation', h.code, b.code),
        hospital_id: h.id,
        branch_id: b.id,
        name: `${b.shortName} front office counter 1`,
        fingerprint: seedId('workstation-fp', h.code, b.code).replace(/-/g, ''),
        counter_id: null,
        location_id: null,
        default_printers: { token: seedId('print-printer', h.code, b.code, 'THERMAL-1') },
        last_seen_at: null,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        deleted_at: null,
      });
    }

    // EN-005 §3.4: auto-print only for whitelisted events.
    const autoPrint: readonly (readonly [string, string])[] = [
      ['queue.token.issued', 'token'],
      ['receipt.created', 'op_receipt'],
      ['lab.order.collection_started', 'lab_label'],
      ['ip.admission.created', 'wristband'],
    ];
    for (const [eventType, docType] of autoPrint) {
      rules.push({
        id: seedId('print-rule', h.code, eventType),
        hospital_id: h.id,
        branch_id: null,
        event_type: eventType,
        doc_type: docType,
        condition: {},
        target_scope: { scopeType: 'workstation' },
        copies: 1,
        active: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        deleted_at: null,
      });
    }
  }

  await ctx.write({ table: 'core.print_agents', conflict: ['id'] }, agents);
  await ctx.write({ table: 'core.print_printers', conflict: ['id'] }, printers);
  await ctx.write({ table: 'core.print_mappings', conflict: ['id'] }, mappings);
  await ctx.write({ table: 'core.print_rules', conflict: ['id'] }, rules);
  await ctx.write({ table: 'core.print_workstations', conflict: ['id'] }, workstations);
}

// ─────────────────────────────────────────────────────────────────────────────
// EN-018 — boards, layouts, devices and the emergency code register
// ─────────────────────────────────────────────────────────────────────────────

async function seedDisplay(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const boards: SeedRow[] = [];
  const layouts: SeedRow[] = [];
  const devices: SeedRow[] = [];
  const codes: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    const main = mainBranchOf(h);

    const boardSpecs: readonly (readonly [string, string, string, string, string])[] = [
      ['OPD-TOKEN-1', 'OPD token board — Block A', 'opd_token', 'public', 'token_only'],
      ['WARD-4B', 'Ward 4B status board', 'ward_status', 'staff_only', 'initial'],
      ['MGMT-KPI', 'Management KPI board', 'management_kpi', 'staff_only', 'token_only'],
    ];

    for (const [code, name, purpose, privacy, mask] of boardSpecs) {
      const boardId = seedId('display-board', h.code, code);
      const layoutId = seedId('display-layout', h.code, code, 'v1');
      boards.push({
        id: boardId,
        hospital_id: h.id,
        branch_id: main.id,
        code,
        name,
        purpose_type: purpose,
        location_text: name,
        location_privacy: privacy,
        floor: 'G',
        orientation: 'landscape',
        resolution_profile: 'fhd',
        theme_key: privacy === 'public' ? 'light-clinical' : 'dark-teal',
        audio_enabled: purpose === 'opd_token',
        tts_languages: purpose === 'opd_token' ? ['en-IN', 'kn'] : [],
        tts_voice: purpose === 'opd_token' ? 'in-female-1' : null,
        volume_schedule: {},
        stale_threshold_sec: 60,
        mask_mode: mask,
        idle_minutes: 10,
        active_layout_id: layoutId,
        fallback_layout_id: null,
        emergency_scope: 'branch',
        status: 'active',
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
        deleted_at: null,
      });

      layouts.push({
        id: layoutId,
        hospital_id: h.id,
        board_id: boardId,
        name: `${name} layout`,
        is_template: false,
        version: 1,
        grid: { cols: 12, rows: 8, gap: 8 },
        widgets: jsonb(
          purpose === 'opd_token'
            ? [
                {
                  id: 'w1',
                  type: 'now_serving',
                  x: 0,
                  y: 0,
                  w: 8,
                  h: 5,
                  params: {},
                  style: {},
                  refresh_sec: 2,
                },
                {
                  id: 'w2',
                  type: 'next_tokens',
                  x: 8,
                  y: 0,
                  w: 4,
                  h: 5,
                  params: {},
                  style: {},
                  refresh_sec: 5,
                },
                {
                  id: 'w3',
                  type: 'announcement_ticker',
                  x: 0,
                  y: 5,
                  w: 12,
                  h: 1,
                  params: {},
                  style: {},
                  refresh_sec: 30,
                },
                {
                  id: 'w4',
                  type: 'clock_date',
                  x: 0,
                  y: 6,
                  w: 12,
                  h: 2,
                  params: {},
                  style: {},
                  refresh_sec: 30,
                },
              ]
            : purpose === 'ward_status'
              ? [
                  {
                    id: 'w1',
                    type: 'ward_status',
                    x: 0,
                    y: 0,
                    w: 12,
                    h: 8,
                    params: { unit: 'W-4B' },
                    style: {},
                    refresh_sec: 10,
                  },
                ]
              : [
                  {
                    id: 'w1',
                    type: 'kpi_tile',
                    x: 0,
                    y: 0,
                    w: 12,
                    h: 8,
                    params: {},
                    style: {},
                    refresh_sec: 60,
                  },
                ],
        ),
        theme_overrides: {},
        status: 'active',
        activated_at: SEED_EPOCH,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        deleted_at: null,
      });

      devices.push({
        id: seedId('display-device', h.code, code),
        hospital_id: h.id,
        branch_id: main.id,
        device_id: null,
        board_id: boardId,
        name: `${name} display`,
        kind: 'android_tv',
        serial: null,
        mac: null,
        resolution: '1920x1080',
        audio_capable: purpose === 'opd_token',
        app_version: null,
        last_heartbeat_at: null,
        status: 'unpaired',
        pairing_code: null,
        pairing_expires_at: null,
        pairing_attempts: 0,
        network: {},
        last_error: null,
        paired_by: null,
        paired_at: null,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        deleted_at: null,
      });
    }

    // NABH emergency codes. Colours are semantic tokens, never hex literals
    // (docs/06 §11).
    const codeSpecs: readonly (readonly [string, string, string, string])[] = [
      ['code_blue', 'Code Blue — cardiac arrest', 'status-critical', 'critical'],
      ['code_red', 'Code Red — fire', 'status-danger', 'critical'],
      ['code_pink', 'Code Pink — infant abduction', 'status-warning', 'critical'],
      ['code_orange', 'Code Orange — mass casualty', 'status-warning', 'critical'],
      ['code_brown', 'Code Brown — external disaster', 'status-info', 'high'],
    ];
    for (const [key, label, colour, severity] of codeSpecs) {
      codes.push({
        id: seedId('display-code', h.code, key),
        hospital_id: h.id,
        code_key: key,
        label: { 'en-IN': label },
        colour_token: colour,
        severity,
        default_scope: 'branch',
        instruction: { 'en-IN': 'Follow the hospital emergency response protocol.' },
        audio_pattern: 'triple-chime',
        auto_expire_min: 30,
        active: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        deleted_at: null,
      });
    }
  }

  await ctx.write({ table: 'core.display_boards', conflict: ['id'] }, boards);
  await ctx.write({ table: 'core.display_layouts', conflict: ['id'] }, layouts);
  await ctx.write({ table: 'core.display_devices', conflict: ['id'] }, devices);
  await ctx.write({ table: 'core.display_emergency_codes', conflict: ['id'] }, codes);
}

// ─────────────────────────────────────────────────────────────────────────────
// EN-040 — plans, subscriptions and the materialised entitlement document
// ─────────────────────────────────────────────────────────────────────────────

const PLANS: readonly (readonly [key: string, name: string, tier: string, base: string, beds: number])[] = [
  ['starter', 'Starter (single clinic)', 'starter', '25000.00', 50],
  ['hospital', 'Hospital', 'hospital', '150000.00', 300],
  ['enterprise', 'Enterprise Group', 'enterprise', '450000.00', 2000],
];

async function seedLicensing(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const plans: SeedRow[] = [];
  const planVersions: SeedRow[] = [];

  for (const [key, name, tier, base, beds] of PLANS) {
    const planId = seedId('lic-plan', key);
    plans.push({
      id: planId,
      key,
      name,
      tier,
      currency: 'INR',
      status: 'active',
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      deleted_at: null,
    });
    planVersions.push({
      id: seedId('lic-plan-version', key, '1'),
      plan_id: planId,
      version: 1,
      billing_frequency: 'annual',
      currency: 'INR',
      base_price: base,
      per_bed_price: { '0-100': '150.00', '101-300': '120.00', '301+': '90.00' },
      per_branch_price: '25000.00',
      per_seat_price: { clinical: '600.00', front_office: '400.00', admin: '400.00', read_only: '150.00' },
      module_bundle: tier === 'starter' ? ['module.admin.enabled', 'module.print.enabled'] : [],
      capacity: { beds, branches: tier === 'enterprise' ? 25 : tier === 'hospital' ? 3 : 1 },
      quotas: { 'quota.sms.monthly': 25_000, 'quota.storage_gb': 500 },
      overage_rates: { 'quota.sms.monthly': '0.18' },
      // SAC 998439 — "other online content"; the real code is confirmed with the
      // hospital's auditor before the first invoice is issued (EN-040 §16).
      tax: { sac: '998439', gstRate: 18 },
      min_commitment: 12,
      trial_days: 30,
      grace_days: 15,
      degrade_ladder_ref: 'default',
      status: 'active',
      effective_from: SEED_EPOCH,
      immutable: true,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
    });
  }
  await ctx.write({ table: 'core.lic_plans', conflict: ['id'] }, plans);
  await ctx.write({ table: 'core.lic_plan_versions', conflict: ['id'] }, planVersions);

  const subscriptions: SeedRow[] = [];
  const items: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    const planKey = h.code === 'VIMS-BLR' ? 'enterprise' : 'hospital';
    const subscriptionId = seedId('lic-subscription', h.code);
    subscriptions.push({
      id: subscriptionId,
      hospital_id: h.id,
      plan_version_id: seedId('lic-plan-version', planKey, '1'),
      status: 'active',
      starts_at: SEED_EPOCH,
      ends_at: new Date(Date.UTC(2027, 0, 1)),
      renewal_mode: 'manual',
      term_months: 12,
      currency: 'INR',
      contract_ref: `DEMO/${h.code}/2026`,
      sales_owner: 'demo',
      po_ref: null,
      degrade_tier: 0,
      grace_until: null,
      suspend_at: null,
      terminate_at: null,
      notes: 'Seeded demo subscription.',
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
      version: 0,
    });
    items.push({
      id: seedId('lic-subscription-item', h.code, 'beds'),
      hospital_id: h.id,
      subscription_id: subscriptionId,
      kind: 'bed_band',
      key: 'capacity.beds',
      quantity: 250,
      unit_price: '120.00',
      discount_pct: 0,
      effective_from: SEED_EPOCH,
      effective_to: null,
      amendment_ref: null,
      created_at: SEED_EPOCH,
      updated_at: SEED_EPOCH,
    });
    items.push({
      id: seedId('lic-subscription-item', h.code, 'branches'),
      hospital_id: h.id,
      subscription_id: subscriptionId,
      kind: 'branch',
      key: 'capacity.branches',
      quantity: h.branches.length,
      unit_price: '25000.00',
      discount_pct: 0,
      effective_from: SEED_EPOCH,
      effective_to: null,
      amendment_ref: null,
      created_at: SEED_EPOCH,
      updated_at: SEED_EPOCH,
    });
  }
  await ctx.write({ table: 'core.lic_subscriptions', conflict: ['id'] }, subscriptions);
  await ctx.write({ table: 'core.lic_subscription_items', conflict: ['id'] }, items);

  // The materialised entitlement document every request resolves against.
  const entitlements: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const point of ENFORCEMENT_POINTS) {
      entitlements.push({
        id: seedId('lic-entitlement', h.code, point.key),
        hospital_id: h.id,
        branch_id: null,
        key: point.key,
        // EN-040 §5: "Clinical safety is never gated." An exempt key is allowed
        // at every tier, which is what the safety suite asserts.
        allowed: true,
        limit_value: point.family === 'capacity' || point.family === 'quota' ? '1000000.00' : null,
        degrade_mode: 0,
        source: 'plan',
        effective_from: SEED_EPOCH,
        effective_to: null,
        document_version: 1,
        signature: null,
        created_at: SEED_EPOCH,
        updated_at: SEED_EPOCH,
      });
    }
  }
  await ctx.write({ table: 'core.lic_entitlements', conflict: ['id'] }, entitlements);
}

// ─────────────────────────────────────────────────────────────────────────────
// EN-025 — step-up policies (the SSO providers themselves are customer config)
// ─────────────────────────────────────────────────────────────────────────────

async function seedSso(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  // Seeding a provider would mean seeding an issuer and a secrets path that do
  // not exist; a half-configured provider on the login screen is worse than
  // none. Step-up policies, by contrast, are product policy and must be present
  // before the first high-risk action is possible.
  const actions: readonly (readonly [string, number])[] = [
    ['admin.role.assign', 300],
    ['admin.impersonate', 120],
    ['admin.settings.configure', 300],
    ['audit.export', 300],
    ['lic.subscription.manage', 300],
    ['ihub.connector.manage', 300],
  ];
  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const [actionKey, maxAge] of actions) {
      rows.push({
        id: seedId('sso-stepup', h.code, actionKey),
        hospital_id: h.id,
        action_key: actionKey,
        required_acr: 'urn:mace:incommon:iap:silver',
        required_amr: ['mfa'],
        max_age_sec: maxAge,
        fallback_method: 'totp',
        enabled: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        deleted_at: null,
      });
    }
  }
  await ctx.write({ table: 'core.sso_step_up_policies', conflict: ['id'] }, rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// EN-017 — a draft connector per hospital, and its health check
// ─────────────────────────────────────────────────────────────────────────────

async function seedIntegration(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const connectors: SeedRow[] = [];
  const operations: SeedRow[] = [];
  const checks: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    const connectorId = seedId('ihub-connector', h.code, 'smtp');
    connectors.push({
      id: connectorId,
      hospital_id: h.id,
      branch_id: null,
      key: 'smtp',
      name: 'Transactional email (SMTP)',
      category: 'messaging',
      template_id: null,
      adapter: '@vims/connector-smtp@0.1.0',
      protocol: 'rest',
      direction: 'out',
      environment: 'sandbox',
      endpoint: { host: 'mailpit', port: 1025 },
      auth_type: 'none',
      // EN-017 §5: credentials are write-only from the UI and never stored here.
      credentials_ref: null,
      tls: { verify: false },
      egress: {},
      // Draft, not active: EN-017 §5 forbids activation without credentials, an
      // activated mapping with passing samples, a health check and an owner.
      status: 'draft',
      version: 1,
      owner_user_id: null,
      vendor_contact: {},
      dpdp: { purpose: 'transactional notifications', dataCategories: ['contact'], crossBorder: false },
      contains_phi: false,
      cross_border: false,
      sla: { successPct: 99, latencyP95Ms: 2000 },
      requires_internet: false,
      retain_payload_days: 30,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
      deleted_at: null,
    });

    operations.push({
      id: seedId('ihub-operation', h.code, 'smtp', 'send'),
      hospital_id: h.id,
      connector_id: connectorId,
      key: 'send',
      name: 'Send message',
      method: 'POST',
      path: '/send',
      request_schema_ref: null,
      response_schema_ref: null,
      timeout_ms: 10_000,
      idempotency: 'key_header',
      partition_key_expr: null,
      retry_policy: { attempts: 5, backoff: 'exponential', baseMs: 1000 },
      circuit_policy: { failureThreshold: 5, resetMs: 60_000 },
      rate_limit: { perMinute: 600 },
      active: true,
      created_at: SEED_EPOCH,
      updated_at: SEED_EPOCH,
      deleted_at: null,
    });

    checks.push({
      id: seedId('ihub-health', h.code, 'smtp'),
      hospital_id: h.id,
      connector_id: connectorId,
      kind: 'ping',
      config: { intervalSec: 60 },
      last_run_at: null,
      last_status: null,
      consecutive_failures: 0,
      uptime_24h: 0,
      uptime_7d: 0,
      uptime_30d: 0,
      latency_p95_ms: null,
      created_at: SEED_EPOCH,
      updated_at: SEED_EPOCH,
    });
  }

  await ctx.write({ table: 'integration.ihub_connectors', conflict: ['id'] }, connectors);
  await ctx.write({ table: 'integration.ihub_operations', conflict: ['id'] }, operations);
  await ctx.write({ table: 'integration.ihub_health_checks', conflict: ['id'] }, checks);
}

// ─────────────────────────────────────────────────────────────────────────────
// EN-013 — the shipped barcode schemes
// ─────────────────────────────────────────────────────────────────────────────

async function seedBarcode(ctx: SeedContext): Promise<void> {
  const schemes: readonly (readonly [string, string, string, string, string])[] = [
    ['patient', 'uhid', 'code128', 'P{UHID}', 'P'],
    ['visit', 'visit_qr', 'qr', '{DEEP_LINK}', ''],
    ['sample', 'accession', 'code128', '{ACCESSION}-{SEQ}', ''],
    ['medication', 'dispense', 'gs1_datamatrix', '(01){GTIN}(10){BATCH}(17){EXPIRY}(21){SERIAL}', ''],
    ['item', 'stock', 'gs1_128', '(01){GTIN}(10){BATCH}(17){EXPIRY}', ''],
    ['asset', 'tag', 'code128', 'AS-{TAG}', 'AS-'],
    ['document', 'verify', 'qr', '{VERIFY_URL}', ''],
  ];

  const rows: SeedRow[] = schemes.map(([entityType, key, symbology, payload, prefix]) => ({
    id: seedId('bc-scheme', entityType, key),
    hospital_id: null,
    entity_type: entityType,
    key,
    symbology,
    payload_format: payload,
    prefix: prefix === '' ? null : prefix,
    ai_map: {},
    check_digit: symbology.startsWith('gs1') ? 'mod10' : null,
    label_template_id: null,
    signed: entityType === 'document',
    version: 1,
    active: true,
    created_at: SEED_EPOCH,
    created_by: null,
    updated_at: SEED_EPOCH,
    deleted_at: null,
  }));

  await ctx.write({ table: 'core.bc_schemes', conflict: ['id'] }, rows);
}
