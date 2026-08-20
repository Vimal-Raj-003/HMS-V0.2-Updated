import type { SeedContext } from './context.js';
import { SEED_EPOCH, seedChoice, seedDate, seedId, seedPick } from './ids.js';
import { jsonb, type SeedRow } from './upsert.js';
import { mainBranchOf, type SeededTenancy } from './tenancy.js';
import { demoUsers } from './users.js';

/**
 * Tiers `hospital` and `volume`: activity rather than configuration.
 *
 * `scale` rows of each kind, per hospital. The `hospital` tier produces enough
 * for a screen to look real; `volume` produces enough for `EXPLAIN` to be
 * honest and for the k6 smoke tests in `docs/09 §8` to mean something.
 *
 * Two properties are load-bearing:
 *
 *   * **No patient-shaped data.** Not one Phase-0 table stores a patient
 *     attribute — no name, no date of birth, no phone, no ABHA. The only
 *     patient-facing columns in this schema are opaque `patient_id` /
 *     `encounter_id` UUIDs (`notif_notifications`, `print_jobs`,
 *     `bc_wristbands`), which are seeded as deterministic synthetic uuids that
 *     reference nothing. `@vims/testing`'s `generatePatients` is therefore not
 *     needed here — and could not be imported anyway: `@vims/testing` already
 *     depends on `@vims/db`, so the reverse edge would be a Turborepo cycle.
 *     When `patient.patients` lands in Phase 1 it is that package's seeder that
 *     will use the generator.
 *
 *   * **Every timestamp is derived from `SEED_EPOCH`,** never from `now()`.
 *     Partitioned tables have a composite primary key `(id, <partition key>)`,
 *     so a moving timestamp would make the same logical row conflict-free and
 *     the second run would insert a duplicate instead of doing nothing.
 */
export async function seedActivity(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  if (ctx.scale === 0) return;

  await ensurePartitions(ctx);
  await seedNotifications(ctx, tenancy);
  await seedApprovals(ctx, tenancy);
  await seedPrintActivity(ctx, tenancy);
  await seedUsage(ctx, tenancy);
  await seedIntegrationMessages(ctx, tenancy);
}

/**
 * The activity window is January 2026 — a fixed month, so the rows always land
 * in the same partition on every machine and in every year. The partitions the
 * migration premakes are relative to *its* run date, so the seed asks for the
 * months it actually needs rather than assuming.
 */
const PARTITIONED_TARGETS: readonly (readonly [string, string])[] = [
  ['core', 'notif_notifications'],
  ['core', 'notif_deliveries'],
  ['core', 'wf_requests'],
  ['core', 'wf_actions'],
  ['core', 'print_jobs'],
  ['core', 'tpl_render_jobs'],
  ['core', 'lic_usage_daily'],
  ['core', 'bc_scan_events'],
  ['integration', 'ihub_messages'],
];

async function ensurePartitions(ctx: SeedContext): Promise<void> {
  for (const [schema, table] of PARTITIONED_TARGETS) {
    for (const month of ['2026-01-01', '2026-02-01']) {
      await ctx.db.query('SELECT core.ensure_month_partition($1, $2, $3::date)', [schema, table, month]);
    }
  }
}

/** A synthetic patient reference. Opaque, deterministic, and points at nothing. */
function syntheticPatientId(hospitalCode: string, index: number): string {
  return seedId('synthetic-patient', hospitalCode, String(index));
}

async function seedNotifications(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const notifications: SeedRow[] = [];
  const recipients: SeedRow[] = [];
  const deliveries: SeedRow[] = [];
  const escalations: SeedRow[] = [];

  const types: readonly [string, string, string][] = [
    ['lab.critical_value', 'critical', 'clinical_safety'],
    ['workflow.request.raised', 'normal', 'approvals'],
    ['print.job.failed', 'normal', 'it_system'],
    ['registration.document.expiring', 'low', 'quality'],
  ];

  for (const hospital of tenancy.hospitals) {
    const main = mainBranchOf(hospital);
    const staff = demoUsers(tenancy).filter((u) => u.hospital.code === hospital.code);
    if (staff.length === 0) continue;

    for (let i = 0; i < ctx.scale; i += 1) {
      const key = `${hospital.code}:${i}`;
      const spec = types[seedPick(types.length, 'notif-type-pick', key)];
      if (spec === undefined) continue;
      const [typeKey, severity, category] = spec;
      const createdAt = seedDate(seedPick(28, 'notif-day', key), seedPick(24, 'notif-hour', key));
      const notificationId = seedId('notif', hospital.code, String(i));
      const isCritical = severity === 'critical';
      const acknowledged = seedPick(10, 'notif-ack', key) < 7;
      const patientId = isCritical
        ? syntheticPatientId(hospital.code, seedPick(200, 'notif-patient', key))
        : null;

      notifications.push({
        id: notificationId,
        hospital_id: hospital.id,
        branch_id: main.id,
        type_key: typeKey,
        type_version: 1,
        severity,
        title: isCritical ? 'Critical result — action required' : 'Action required',
        // EN-037 §5: external channels carry location and urgency only. The
        // in-app body may say more, but the seeded corpus deliberately models
        // the minimised form so a screenshot can never leak a value.
        body_short: isCritical
          ? `Ward 4B · Bed ${1 + seedPick(30, 'notif-bed', key)} · tap to view`
          : 'Tap to view',
        body_rich: null,
        payload: jsonb({ location: 'Ward 4B', urgency: severity }),
        contains_phi: isCritical,
        ref_type: category === 'approvals' ? 'wf_request' : null,
        ref_id: null,
        patient_id: patientId,
        encounter_id: null,
        dedupe_key: `${typeKey}:${i}`,
        occurrence_count: 1,
        first_at: createdAt,
        last_at: createdAt,
        expires_at: null,
        source_module: 'SEED',
        correlation_id: seedId('correlation', hospital.code, String(i)),
        escalation_instance_id: isCritical ? seedId('notif-escalation', hospital.code, String(i)) : null,
        status: acknowledged ? 'acknowledged' : 'open',
        created_at: createdAt,
        created_by: null,
        updated_at: createdAt,
      });

      const recipient = staff[seedPick(staff.length, 'notif-recipient', key)];
      if (recipient === undefined) continue;
      const recipientId = seedId('notif-recipient', hospital.code, String(i));
      recipients.push({
        id: recipientId,
        hospital_id: hospital.id,
        notification_id: notificationId,
        notification_at: createdAt,
        user_id: recipient.id,
        device_id: null,
        audience_reason: isCritical ? 'careteam' : 'role',
        scope: jsonb({ ward: 'W-4B' }),
        read_at: acknowledged ? new Date(createdAt.getTime() + 60_000) : null,
        acknowledged_at: acknowledged ? new Date(createdAt.getTime() + 120_000) : null,
        ack_channel: acknowledged ? 'inapp' : null,
        // EN-037 §3.4.4: "A tap that only dismisses is not an acknowledgement."
        // A critical acknowledgement carries the read-back record.
        ack_response:
          acknowledged && isCritical
            ? jsonb({ readBackConfirmed: true, calledBy: recipient.username, action: 'attending now' })
            : null,
        dismissed_at: null,
        snoozed_until: null,
        escalation_level: acknowledged ? 1 : isCritical ? 2 : 1,
        delivered_any: true,
        handed_over_to_user_id: null,
        handover_note: null,
        created_at: createdAt,
        updated_at: createdAt,
      });

      const channels = isCritical ? ['inapp', 'web_push', 'sms'] : ['inapp'];
      channels.forEach((channel, attemptIndex) => {
        deliveries.push({
          id: seedId('notif-delivery', hospital.code, String(i), channel),
          hospital_id: hospital.id,
          recipient_id: recipientId,
          channel,
          attempt: 1,
          status: 'delivered',
          provider_ref: channel === 'inapp' ? null : `seed-${channel}-${i}`,
          error_class: null,
          error_text: null,
          queued_at: createdAt,
          sent_at: new Date(createdAt.getTime() + 1_000 * (attemptIndex + 1)),
          delivered_at: new Date(createdAt.getTime() + 2_000 * (attemptIndex + 1)),
          latency_ms: 900 + attemptIndex * 300,
          cost_units: channel === 'sms' ? '0.18' : null,
        });
      });

      if (!isCritical) continue;
      escalations.push({
        id: seedId('notif-escalation', hospital.code, String(i)),
        hospital_id: hospital.id,
        notification_id: notificationId,
        notification_at: createdAt,
        ladder_id: seedId('notif-ladder', hospital.code, 'clinical_critical'),
        current_level: acknowledged ? 1 : 2,
        started_at: createdAt,
        next_fire_at: acknowledged ? null : new Date(createdAt.getTime() + 600_000),
        acknowledged_at: acknowledged ? new Date(createdAt.getTime() + 120_000) : null,
        acknowledged_by: acknowledged ? recipient.id : null,
        exhausted_at: null,
        stopped_reason: acknowledged ? 'acknowledged' : null,
        level_log: jsonb([{ level: 1, firedAt: createdAt.toISOString(), resolvedTargets: 1 }]),
        created_at: createdAt,
        updated_at: createdAt,
      });
    }
  }

  await ctx.write({ table: 'core.notif_notifications', conflict: ['id', 'created_at'] }, notifications);
  await ctx.write({ table: 'core.notif_recipients', conflict: ['id'] }, recipients);
  await ctx.write({ table: 'core.notif_deliveries', conflict: ['id', 'queued_at'] }, deliveries);
  await ctx.write({ table: 'core.notif_escalation_instances', conflict: ['id'] }, escalations);
}

async function seedApprovals(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const requests: SeedRow[] = [];
  const stages: SeedRow[] = [];
  const approvers: SeedRow[] = [];
  const actions: SeedRow[] = [];

  const processKeys = ['admin.settings.change', 'mdm.change_set.activate', 'tpl.template.publish'] as const;

  for (const hospital of tenancy.hospitals) {
    const main = mainBranchOf(hospital);
    const requester = seedId('user', hospital.code, 'it_admin');
    const approver = seedId('user', hospital.code, 'hospital_admin');
    const count = Math.max(1, Math.floor(ctx.scale / 4));

    for (let i = 0; i < count; i += 1) {
      const key = `${hospital.code}:${i}`;
      const processKey = processKeys[seedPick(processKeys.length, 'wf-process-pick', key)] ?? processKeys[0];
      const requestedAt = seedDate(seedPick(28, 'wf-day', key), seedPick(12, 'wf-hour', key));
      const decided = seedPick(10, 'wf-decided', key) < 8;
      const decidedAt = decided ? new Date(requestedAt.getTime() + 3_600_000) : null;
      const requestId = seedId('wf-request', hospital.code, String(i));
      const stageId = seedId('wf-stage', hospital.code, String(i), '1');

      requests.push({
        id: requestId,
        hospital_id: hospital.id,
        branch_id: main.id,
        process_key: processKey,
        matrix_version_id: seedId('wf-matrix-version', hospital.code, processKey, '1'),
        ref_type: 'seed_demo',
        ref_id: seedId('wf-ref', hospital.code, String(i)),
        idempotency_key: `seed-${i}`,
        requested_by: requester,
        requested_at: requestedAt,
        context: jsonb({ summary: 'Seeded demonstration request' }),
        context_hash: seedId('wf-context', hospital.code, String(i)).replace(/-/g, ''),
        reason: 'Seeded so the approvals inbox is not empty on a fresh install.',
        urgency: 'normal',
        attachments: jsonb([]),
        status: decided ? 'approved' : 'pending',
        current_stage: 1,
        plan: jsonb({ stages: 1 }),
        decided_at: decidedAt,
        outcome_note: decided ? 'Approved.' : null,
        modified_value: null,
        sla_due_at: new Date(requestedAt.getTime() + 86_400_000),
        escalation_level: 0,
        total_turnaround_sec: decided ? 3600 : null,
        business_turnaround_sec: decided ? 3600 : null,
        amount: null,
        currency: null,
        created_at: requestedAt,
        updated_at: requestedAt,
      });

      stages.push({
        id: stageId,
        hospital_id: hospital.id,
        request_id: requestId,
        request_at: requestedAt,
        stage_no: 1,
        kind: 'serial',
        quorum_n: null,
        required_count: 1,
        received_count: decided ? 1 : 0,
        status: decided ? 'approved' : 'active',
        activated_at: requestedAt,
        completed_at: decidedAt,
        sla_due_at: new Date(requestedAt.getTime() + 86_400_000),
        reminders_sent: 0,
        escalated_to: jsonb([]),
        skip_reason: null,
        created_at: requestedAt,
        updated_at: requestedAt,
        version: 0,
      });

      approvers.push({
        id: seedId('wf-approver', hospital.code, String(i)),
        hospital_id: hospital.id,
        stage_id: stageId,
        user_id: approver,
        resolved_from: 'role',
        on_behalf_of_user_id: null,
        delegation_id: null,
        notified_at: requestedAt,
        viewed_at: decided ? new Date(requestedAt.getTime() + 600_000) : null,
        decision: decided ? 'approved' : 'pending',
        decided_at: decidedAt,
        reason: decided ? 'Reviewed and approved.' : null,
        esign_ref: null,
        decision_latency_sec: decided ? 3000 : null,
        device: 'desktop',
        context_hash_at_decision: decided
          ? seedId('wf-context', hospital.code, String(i)).replace(/-/g, '')
          : null,
        created_at: requestedAt,
        updated_at: requestedAt,
        version: 0,
      });

      actions.push({
        id: seedId('wf-action', hospital.code, String(i), 'created'),
        hospital_id: hospital.id,
        request_id: requestId,
        actor_user_id: requester,
        action: 'created',
        acted_at: requestedAt,
        from_state: null,
        to_state: 'pending',
        reason: null,
        payload: jsonb({}),
        ip_class: 'internal',
      });
      if (!decided || decidedAt === null) continue;
      actions.push({
        id: seedId('wf-action', hospital.code, String(i), 'approved'),
        hospital_id: hospital.id,
        request_id: requestId,
        actor_user_id: approver,
        action: 'approved',
        acted_at: decidedAt,
        from_state: 'pending',
        to_state: 'approved',
        reason: 'Reviewed and approved.',
        payload: jsonb({}),
        ip_class: 'internal',
      });
    }
  }

  await ctx.write({ table: 'core.wf_requests', conflict: ['id', 'requested_at'] }, requests);
  await ctx.write({ table: 'core.wf_stages', conflict: ['id'] }, stages);
  await ctx.write({ table: 'core.wf_stage_approvers', conflict: ['id'] }, approvers);
  await ctx.write({ table: 'core.wf_actions', conflict: ['id', 'acted_at'] }, actions);
}

async function seedPrintActivity(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const jobs: SeedRow[] = [];
  const renders: SeedRow[] = [];
  const labels: SeedRow[] = [];

  for (const hospital of tenancy.hospitals) {
    for (const b of hospital.branches) {
      const count = Math.max(1, Math.floor(ctx.scale / 2));
      for (let i = 0; i < count; i += 1) {
        const key = `${hospital.code}:${b.code}:${i}`;
        const createdAt = seedDate(seedPick(28, 'print-day', key), seedPick(12, 'print-hour', key));
        const docType = seedChoice(
          ['token', 'op_receipt', 'lab_label', 'gst_invoice'] as const,
          'print-doc',
          key,
        );
        const isPdf = docType === 'gst_invoice';

        jobs.push({
          id: seedId('print-job', hospital.code, b.code, String(i)),
          hospital_id: hospital.id,
          branch_id: b.id,
          doc_type: docType,
          template_key: docType,
          printer_id: seedId('print-printer', hospital.code, b.code, isPdf ? 'LASER-1' : 'THERMAL-1'),
          agent_id: seedId('print-agent', hospital.code, b.code),
          requested_by: seedId('user', hospital.code, 'receptionist'),
          workstation_id: seedId('print-workstation', hospital.code, b.code),
          source_module: 'SEED',
          source_ref_type: 'seed_demo',
          source_ref_id: seedId('print-ref', hospital.code, b.code, String(i)),
          patient_id:
            docType === 'lab_label'
              ? syntheticPatientId(hospital.code, seedPick(200, 'print-patient', key))
              : null,
          phi: docType === 'lab_label',
          file_id: null,
          render_job_id: isPdf ? seedId('tpl-render', hospital.code, b.code, String(i)) : null,
          format: isPdf ? 'pdf' : docType === 'lab_label' ? 'zpl' : 'escpos',
          copies: 1,
          pages: isPdf ? 2 : 1,
          status: 'completed',
          priority: docType === 'lab_label' ? 1 : 5,
          attempts: 1,
          error: null,
          is_reprint: false,
          reprint_reason: null,
          created_at: createdAt,
          completed_at: new Date(createdAt.getTime() + 4_000),
          updated_at: createdAt,
        });

        if (isPdf) {
          renders.push({
            id: seedId('tpl-render', hospital.code, b.code, String(i)),
            hospital_id: hospital.id,
            branch_id: b.id,
            print_template_id: seedId('tpl-print', hospital.code, 'gst_invoice'),
            version: 1,
            purpose: 'original',
            data_hash: seedId('render-data', hospital.code, b.code, String(i)).replace(/-/g, ''),
            locale: 'en-IN',
            status: 'rendered',
            artifact_file_id: null,
            sha256: seedId('render-sha', hospital.code, b.code, String(i)).replace(/-/g, ''),
            pages: 2,
            size_bytes: 48_000,
            duration_ms: 850,
            error_class: null,
            requested_by: seedId('user', hospital.code, 'cashier'),
            ref_type: 'seed_demo',
            ref_id: seedId('print-ref', hospital.code, b.code, String(i)),
            delivered_to: jsonb([]),
            created_at: createdAt,
            updated_at: createdAt,
          });
        }

        if (docType !== 'lab_label') continue;
        labels.push({
          id: seedId('bc-label', hospital.code, b.code, String(i)),
          hospital_id: hospital.id,
          branch_id: b.id,
          scheme_key: 'accession',
          entity_type: 'sample',
          entity_id: seedId('sample', hospital.code, b.code, String(i)),
          code_value: `${b.code}/SMP/${String(100_000 + i)}`,
          printer_id: seedId('print-printer', hospital.code, b.code, 'LABEL-1'),
          printed_by: seedId('user', hospital.code, 'phlebotomist'),
          printed_at: createdAt,
          copies: 1,
          is_reprint: false,
          reprint_reason: null,
          template_version: 1,
        });
      }
    }
  }

  await ctx.write({ table: 'core.print_jobs', conflict: ['id', 'created_at'] }, jobs);
  await ctx.write({ table: 'core.tpl_render_jobs', conflict: ['id', 'created_at'] }, renders);
  await ctx.write({ table: 'core.bc_labels_issued', conflict: ['id'] }, labels);
}

/** `EN-040 §5`: metering records counts only, never patient identifiers. */
async function seedUsage(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const meters = [
    'quota.sms.monthly',
    'quota.email.monthly',
    'quota.storage_gb',
    'capacity.seats.clinical',
  ] as const;
  const rows: SeedRow[] = [];

  for (const hospital of tenancy.hospitals) {
    for (let day = 0; day < 28; day += 1) {
      for (const meter of meters) {
        const key = `${hospital.code}:${meter}:${day}`;
        const usageDate = seedDate(day);
        rows.push({
          id: seedId('lic-usage', hospital.code, meter, String(day)),
          hospital_id: hospital.id,
          branch_id: null,
          meter_key: meter,
          usage_date: usageDate,
          value: String(100 + seedPick(900, 'usage-value', key)) + '.00',
          peak: null,
          source: 'seed',
          computed_at: SEED_EPOCH,
        });
      }
    }
  }

  await ctx.write({ table: 'core.lic_usage_daily', conflict: ['id', 'usage_date'] }, rows);
}

async function seedIntegrationMessages(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const messages: SeedRow[] = [];

  for (const hospital of tenancy.hospitals) {
    const connectorId = seedId('ihub-connector', hospital.code, 'smtp');
    const operationId = seedId('ihub-operation', hospital.code, 'smtp', 'send');
    const count = Math.max(1, Math.floor(ctx.scale / 2));

    for (let i = 0; i < count; i += 1) {
      const key = `${hospital.code}:${i}`;
      const createdAt = seedDate(seedPick(28, 'ihub-day', key), seedPick(24, 'ihub-hour', key));
      const failed = seedPick(20, 'ihub-fail', key) === 0;
      messages.push({
        id: seedId('ihub-message', hospital.code, String(i)),
        hospital_id: hospital.id,
        branch_id: null,
        connector_id: connectorId,
        connector_version: 1,
        operation_id: operationId,
        direction: 'out',
        correlation_id: seedId('ihub-correlation', hospital.code, String(i)),
        parent_message_id: null,
        ref_type: 'seed_demo',
        ref_id: seedId('ihub-ref', hospital.code, String(i)),
        idempotency_key: `seed-smtp-${hospital.code}-${i}`,
        partition_key: null,
        priority: 5,
        status: failed ? 'failed' : 'acknowledged',
        attempts: failed ? 3 : 1,
        next_attempt_at: failed ? new Date(createdAt.getTime() + 300_000) : null,
        http_status: failed ? 502 : 202,
        ack_code: failed ? null : 'AA',
        latency_ms: failed ? null : 120,
        error_class: failed ? 'upstream_unavailable' : null,
        error_code: failed ? 'ECONNREFUSED' : null,
        error_text: failed ? 'Connection refused by the seeded sandbox endpoint.' : null,
        // EN-017 §5: the searchable copy carries typed tokens, never PHI.
        payload_redacted: jsonb({ to: '«email»', subject: 'Appointment reminder', body: '«text»' }),
        payload_ref: null,
        response_redacted: jsonb(failed ? { error: '«text»' } : { accepted: true }),
        size_bytes: 480,
        contains_phi: false,
        created_at: createdAt,
        sent_at: createdAt,
        completed_at: failed ? null : new Date(createdAt.getTime() + 120),
        updated_at: createdAt,
      });
    }
  }

  await ctx.write({ table: 'integration.ihub_messages', conflict: ['id', 'created_at'] }, messages);
}
