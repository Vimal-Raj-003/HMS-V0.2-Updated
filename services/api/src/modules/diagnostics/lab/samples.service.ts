import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { actorId, withLabErrors, writeOrderEvent } from './lab.common.js';
import { labEvent } from './lab.events.js';
import type {
  AccessionSampleRequest,
  CollectSampleRequest,
  IssueLabelsRequest,
  ReceiveSampleRequest,
  RejectSampleRequest,
} from './lab.schemas.js';
import type { LabLabelView, LabSampleView } from './lab.types.js';

/**
 * OP-004 §3.2 — the pre-analytical phase.
 *
 * Everything expensive in a laboratory happens after this point, and almost
 * everything that goes wrong happens here: an unlabelled tube, a specimen drawn
 * from the wrong patient, a haemolysed potassium resulted as if it were real.
 * So the shape of this service is deliberately narrow — a specimen moves
 * pending → collected → received → accessioned, or it is rejected with a coded
 * reason and replaced by a traceable recollection, and there is no other path.
 *
 * Two things are worth reading twice.
 *
 * **The two-identifier check is a state, not a click.** `lab_samples` carries
 * `patient_scan_verified`, `container_scan_verified` and an override with a
 * named person and a reason, and the CHECK refuses a collection with none of
 * them. The override exists because a label printer does fail at 3 a.m. and a
 * system that makes the honest answer impossible gets the dishonest one.
 *
 * **A rejection is not a delete.** `OP-004 §3.2.3` makes the rejection rate a
 * NABL indicator, so the specimen stays, with its coded reason and its
 * attribution, and the replacement names it. The database refuses a recollection
 * of a specimen that was never rejected, which is what stops a repeat draw being
 * booked as one and flattering the indicator.
 */
@Injectable()
export class LabSamplesService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
  ) {}

  /**
   * `EN-013 §3` + `OP-004 §3.2.1` — one label per container, with the cap colour
   * on it. The specimen rows are created here because a label and a specimen are
   * the same act: a barcode printed for a tube that does not exist in the system
   * is the unlabelled-specimen problem wearing a different hat.
   */
  async issueLabels(orderId: string, body: IssueLabelsRequest): Promise<{ labels: readonly LabLabelView[] }> {
    const ctx = getContext();

    return withLabErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const order = await tx.maybeOne<{
          id: string;
          branch_id: string;
          patient_id: string;
          accession_no: string;
          status: string;
          is_mlc: boolean;
        }>(
          `SELECT id, branch_id, patient_id, accession_no, status::text AS status, is_mlc
             FROM lab.lab_orders WHERE id = $1`,
          [orderId],
        );
        if (order === undefined) throw AppError.notFound('The laboratory order');
        if (order.status === 'cancelled') {
          throw new AppError(
            ProblemType.ALREADY_DECIDED,
            'This order is cancelled. Printing a label for it would put a barcode on a tube nobody should draw.',
          );
        }

        // Lines still waiting for a container, with the specimen and container
        // the catalogue says they need. Grouped by the pair, because that is
        // exactly what one tube is.
        const pending = await tx.rows<PendingLineRow>(
          `SELECT ot.id AS order_test_id, ot.test_code,
                  t.specimen_type_key, sp.name AS specimen_type_name,
                  t.container_key, ct.name AS container_name, ct.cap_colour,
                  COALESCE(ct.order_of_draw, 99) AS order_of_draw
             FROM lab.lab_order_tests ot
             JOIN LATERAL (
               SELECT DISTINCT ON (x.record_key) x.specimen_type_key, x.container_key
                 FROM mdm.mdm_lab_tests x
                WHERE x.record_key = ot.test_key AND x.status = 'active'
                ORDER BY x.record_key, x.version DESC
             ) t ON true
             LEFT JOIN LATERAL (
               SELECT DISTINCT ON (s.record_key) s.name
                 FROM mdm.mdm_lab_specimen_types s
                WHERE s.record_key = t.specimen_type_key AND s.status = 'active'
                ORDER BY s.record_key, s.version DESC
             ) sp ON true
             LEFT JOIN LATERAL (
               SELECT DISTINCT ON (c.record_key) c.name, c.cap_colour, c.order_of_draw
                 FROM mdm.mdm_lab_containers c
                WHERE c.record_key = t.container_key AND c.status = 'active'
                ORDER BY c.record_key, c.version DESC
             ) ct ON true
            WHERE ot.order_id = $1
              AND ot.status = 'pending'
              AND ot.sample_id IS NULL`,
          [orderId],
        );

        const groups = new Map<string, PendingLineRow[]>();
        for (const line of pending) {
          const key = `${line.specimen_type_key}|${line.container_key ?? ''}`;
          const bucket = groups.get(key);
          if (bucket === undefined) groups.set(key, [line]);
          else bucket.push(line);
        }

        const labels: LabLabelView[] = [];

        // A reprint: no new containers are needed, so re-issue labels for the
        // specimens this order already has. `EN-013 §3` treats it as an audited
        // event because two labels bearing the same accession in circulation is
        // how a specimen ends up on the wrong bench.
        if (groups.size === 0) {
          const existing = await tx.rows<ExistingSampleRow>(
            `SELECT id, barcode, specimen_type_name, container_name, cap_colour
               FROM lab.lab_samples
              WHERE order_id = $1 AND status NOT IN ('disposed')
              ORDER BY sample_no`,
            [orderId],
          );
          if (existing.length === 0) {
            throw new AppError(
              ProblemType.BUSINESS_RULE_VIOLATED,
              'There is nothing to label on this order: every test either already has a container or has been cancelled.',
            );
          }
          if (body.reprintReason === undefined) {
            throw AppError.validation([
              {
                path: 'reprintReason',
                code: 'reprint_reason_required',
                message:
                  'These specimens already have labels. A reprint is audited and says why — two labels bearing one accession in circulation is how a tube reaches the wrong bench.',
              },
            ]);
          }
          for (const sample of existing) {
            labels.push(
              ...(await this.printLabels(tx, {
                sampleId: sample.id,
                barcode: sample.barcode,
                specimenTypeName: sample.specimen_type_name,
                containerName: sample.container_name,
                capColour: sample.cap_colour,
                testCodes: [],
                copies: body.copies,
                isReprint: true,
                reprintReason: body.reprintReason,
                printerId: body.printerId ?? null,
              })),
            );
          }
        }

        const seqRow = await tx.one<{ n: number }>(
          `SELECT COALESCE(max(container_seq), 0)::int AS n FROM lab.lab_samples WHERE order_id = $1`,
          [orderId],
        );
        let containerSeq = seqRow.n;

        const sorted = [...groups.values()].sort(
          (a, b) => (a[0]?.order_of_draw ?? 99) - (b[0]?.order_of_draw ?? 99),
        );

        for (const lines of sorted) {
          const first = lines[0];
          if (first === undefined) continue;
          containerSeq += 1;
          const sampleId = newId();

          const allocation = await this.numbering.allocate(tx, {
            key: 'SAMPLE',
            branchId: order.branch_id,
            refType: 'lab.lab_samples',
            refId: sampleId,
          });

          await tx.query(
            `INSERT INTO lab.lab_samples (
               id, hospital_id, branch_id, order_id, patient_id, sample_no, barcode, container_seq,
               specimen_type_key, specimen_type_name, container_key, container_name, cap_colour,
               status, is_chain_of_custody, seal_no, created_by, updated_by, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $6, $7,
               $8, $9, $10, $11, $12,
               'pending', $13, $14, $15, $15, now()
             )`,
            [
              sampleId,
              ctx.hospitalId,
              order.branch_id,
              orderId,
              order.patient_id,
              allocation.formatted,
              containerSeq,
              first.specimen_type_key,
              first.specimen_type_name ?? 'Unspecified specimen',
              first.container_key,
              first.container_name,
              first.cap_colour,
              order.is_mlc,
              // `lab_samples_custody_seal`: a medico-legal specimen carries a
              // tamper-evident seal, and the seal number is the barcode until a
              // physical seal is recorded against it.
              order.is_mlc ? allocation.formatted : null,
              ctx.userId,
            ],
          );

          await tx.query(
            `UPDATE lab.lab_order_tests
                SET sample_id = $2, updated_by = $3, updated_at = now(), version = version + 1
              WHERE id = ANY($1::uuid[])`,
            [lines.map((l) => l.order_test_id), sampleId, ctx.userId],
          );

          labels.push(
            ...(await this.printLabels(tx, {
              sampleId,
              barcode: allocation.formatted,
              specimenTypeName: first.specimen_type_name ?? 'Unspecified specimen',
              containerName: first.container_name,
              capColour: first.cap_colour,
              testCodes: lines.map((l) => l.test_code),
              copies: body.copies,
              isReprint: false,
              reprintReason: null,
              printerId: body.printerId ?? null,
            })),
          );

          await writeOrderEvent(tx, { orderId, sampleId, to: 'labelled' });
        }

        if (groups.size > 0) {
          await tx.query(
            `UPDATE lab.lab_orders
                SET status = 'awaiting_collection', updated_by = $2, updated_at = now(),
                    version = version + 1
              WHERE id = $1 AND status = 'placed'`,
            [orderId, ctx.userId],
          );
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'lab.lab_sample_labels',
          rowId: orderId,
          businessKey: order.accession_no,
          dataClass: 'phi',
          patientId: order.patient_id,
          before: null,
          after: { labels: labels.length, reprint: groups.size === 0 },
          rowCount: labels.length,
          ...(body.reprintReason === undefined ? {} : { reasonText: body.reprintReason }),
        });

        return { labels };
      }),
    );
  }

  async collect(barcode: string, body: CollectSampleRequest): Promise<LabSampleView> {
    const ctx = getContext();

    const sampleId = await withLabErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const sample = await this.lockByBarcode(tx, barcode);
        if (sample.status !== 'pending') {
          throw new AppError(
            ProblemType.ALREADY_DECIDED,
            `This specimen is already ${sample.status}. Draw a fresh container rather than re-recording this one.`,
          );
        }

        const overridden = body.identityOverrideReason !== undefined;
        await tx.query(
          `UPDATE lab.lab_samples
              SET status = 'collected', collected_by = $2, collected_at = now(),
                  collection_site = $3::lab."LabCollectionSite",
                  fasting = $4, fasting_hours = $5, draw_attempts = $6, draw_site = $7,
                  patient_scan_verified = $8, container_scan_verified = $9,
                  identity_override_reason = $10, identity_override_by = $11,
                  updated_by = $2, updated_at = now(), version = version + 1
            WHERE id = $1`,
          [
            sample.id,
            ctx.userId,
            body.collectionSite,
            body.fasting ?? null,
            body.fastingHours ?? null,
            body.drawAttempts ?? null,
            body.drawSite ?? null,
            body.patientScanVerified,
            body.containerScanVerified,
            body.identityOverrideReason ?? null,
            overridden ? ctx.userId : null,
          ],
        );

        await tx.query(
          `UPDATE lab.lab_order_tests
              SET status = 'collected', updated_by = $2, updated_at = now(), version = version + 1
            WHERE sample_id = $1 AND status = 'pending'`,
          [sample.id, ctx.userId],
        );

        await this.advanceOrder(tx, sample.order_id);
        await writeOrderEvent(tx, {
          orderId: sample.order_id,
          sampleId: sample.id,
          from: 'pending',
          to: 'collected',
          reason: body.identityOverrideReason ?? null,
        });

        await this.audit.write(tx, {
          action: 'update',
          entity: 'lab.lab_samples',
          rowId: sample.id,
          businessKey: sample.sample_no,
          dataClass: 'phi',
          patientId: sample.patient_id,
          before: { status: 'pending' },
          after: {
            status: 'collected',
            patient_scan_verified: body.patientScanVerified,
            container_scan_verified: body.containerScanVerified,
            identity_override: overridden,
          },
          sensitivity: overridden ? 'sensitive' : 'normal',
          ...(body.identityOverrideReason === undefined ? {} : { reasonText: body.identityOverrideReason }),
        });

        await this.outbox.publish(
          tx,
          labEvent('lab.sample.collected', sample.id, {
            sampleId: sample.id,
            orderId: sample.order_id,
            patientId: sample.patient_id,
            specimenTypeKey: sample.specimen_type_key,
            collectedBy: actorId(),
            // False exactly when the two scans did not happen — which is the
            // audited printer-failure override and nothing else.
            identityVerified: body.patientScanVerified && body.containerScanVerified,
            collectedAt: new Date().toISOString(),
          }),
        );

        return sample.id;
      }),
    );

    return this.getSample(sampleId);
  }

  async receive(barcode: string, body: ReceiveSampleRequest): Promise<LabSampleView> {
    const ctx = getContext();

    const sampleId = await withLabErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const sample = await this.lockByBarcode(tx, barcode);
        if (sample.status === 'rejected') {
          throw new AppError(
            ProblemType.ALREADY_DECIDED,
            'This specimen was rejected. Receive the recollection instead.',
          );
        }
        if (!['collected', 'dispatched'].includes(sample.status)) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            `A specimen is received after it has been collected; this one is ${sample.status}.`,
          );
        }

        await tx.query(
          `UPDATE lab.lab_samples
              SET status = 'received', received_by = $2, received_at = now(),
                  condition_on_receipt = $3::lab."LabSampleCondition", receipt_temp_c = $4,
                  updated_by = $2, updated_at = now(), version = version + 1
            WHERE id = $1`,
          [sample.id, ctx.userId, body.conditionOnReceipt, body.receiptTempC ?? null],
        );

        await tx.query(
          `UPDATE lab.lab_order_tests
              SET status = 'received', updated_by = $2, updated_at = now(), version = version + 1
            WHERE sample_id = $1 AND status IN ('pending', 'collected')`,
          [sample.id, ctx.userId],
        );

        await this.startRoutineTatClock(tx, sample.id);
        await this.advanceOrder(tx, sample.order_id);
        await writeOrderEvent(tx, {
          orderId: sample.order_id,
          sampleId: sample.id,
          from: sample.status,
          to: 'received',
          reason: body.conditionOnReceipt === 'satisfactory' ? null : body.conditionOnReceipt,
        });

        await this.audit.write(tx, {
          action: 'update',
          entity: 'lab.lab_samples',
          rowId: sample.id,
          businessKey: sample.sample_no,
          dataClass: 'phi',
          patientId: sample.patient_id,
          before: { status: sample.status },
          after: { status: 'received', condition_on_receipt: body.conditionOnReceipt },
        });

        await this.outbox.publish(
          tx,
          labEvent('lab.sample.received', sample.id, {
            sampleId: sample.id,
            orderId: sample.order_id,
            patientId: sample.patient_id,
            receivedBy: actorId(),
            receivedAt: new Date().toISOString(),
          }),
        );

        return sample.id;
      }),
    );

    return this.getSample(sampleId);
  }

  async accession(barcode: string, body: AccessionSampleRequest): Promise<LabSampleView> {
    const ctx = getContext();

    const sampleId = await withLabErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const sample = await this.lockByBarcode(tx, barcode);
        if (sample.status !== 'received') {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            `A specimen is accessioned after it has been received; this one is ${sample.status}.`,
          );
        }

        const accession = await tx.one<{ accession_no: string }>(
          `SELECT accession_no FROM lab.lab_orders WHERE id = $1`,
          [sample.order_id],
        );

        await tx.query(
          `UPDATE lab.lab_samples
              SET status = 'accessioned', accessioned_by = $2, accessioned_at = now(),
                  storage_location = COALESCE($3, storage_location),
                  updated_by = $2, updated_at = now(), version = version + 1
            WHERE id = $1`,
          [sample.id, ctx.userId, body.storageLocation ?? null],
        );

        await this.advanceOrder(tx, sample.order_id);
        await writeOrderEvent(tx, {
          orderId: sample.order_id,
          sampleId: sample.id,
          from: 'received',
          to: 'accessioned',
        });

        await this.audit.write(tx, {
          action: 'update',
          entity: 'lab.lab_samples',
          rowId: sample.id,
          businessKey: sample.sample_no,
          dataClass: 'phi',
          patientId: sample.patient_id,
          before: { status: 'received' },
          after: { status: 'accessioned' },
        });

        await this.outbox.publish(
          tx,
          labEvent('lab.sample.accessioned', sample.id, {
            sampleId: sample.id,
            orderId: sample.order_id,
            accessionNo: accession.accession_no,
            patientId: sample.patient_id,
            accessionedAt: new Date().toISOString(),
          }),
        );

        return sample.id;
      }),
    );

    return this.getSample(sampleId);
  }

  /**
   * `phase-03` exit gate 3. The rejection carries a coded reason and an
   * attribution; the recollection is a fresh container on the same order whose
   * lines chain back to the ones they replace and are, by CHECK, free.
   */
  async reject(barcode: string, body: RejectSampleRequest): Promise<LabSampleView> {
    const ctx = getContext();

    const result = await withLabErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const sample = await this.lockByBarcode(tx, barcode);
        if (sample.status === 'rejected') {
          throw new AppError(ProblemType.ALREADY_DECIDED, 'This specimen has already been rejected.');
        }

        const resulted = await tx.maybeOne<{ id: string }>(
          `SELECT r.id FROM lab.lab_results r
             JOIN lab.lab_order_tests ot ON ot.id = r.order_test_id
            WHERE ot.sample_id = $1
            LIMIT 1`,
          [sample.id],
        );
        if (resulted !== undefined) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'This specimen has already produced a result. Rejecting it now would leave a value on the report with nothing behind it — amend or cancel the result instead.',
          );
        }

        // The reason must be one this hospital actually uses. The trigger says
        // the same thing and snapshots the code; asking first is what makes the
        // refusal readable.
        const reason = await tx.maybeOne<{
          record_key: string;
          code: string;
          label: string;
          requires_recollection: boolean;
        }>(
          `SELECT DISTINCT ON (r.record_key) r.record_key, r.code, r.label, r.requires_recollection
             FROM lab.lab_rejection_reasons r
            WHERE r.record_key = $1
              AND r.status = 'active'
              AND r.effective_from <= now()
              AND (r.effective_to IS NULL OR r.effective_to > now())
            ORDER BY r.record_key, r.version DESC`,
          [body.rejectionReasonKey],
        );
        if (reason === undefined) {
          throw AppError.validation([
            {
              path: 'rejectionReasonKey',
              code: 'reason_not_active',
              message:
                'That is not an active rejection reason for this laboratory. The rejection rate is a NABL indicator and it is counted by code, so the reason has to come from the list.',
            },
          ]);
        }

        await tx.query(
          `UPDATE lab.lab_samples
              SET status = 'rejected', rejection_reason_key = $2, rejection_note = $3,
                  rejected_by = $4, rejected_at = now(),
                  updated_by = $4, updated_at = now(), version = version + 1
            WHERE id = $1`,
          [sample.id, reason.record_key, body.note ?? null, ctx.userId],
        );

        const affected = await tx.rows<{ id: string }>(
          `UPDATE lab.lab_order_tests
              SET status = 'rejected', updated_by = $2, updated_at = now(), version = version + 1
            WHERE sample_id = $1 AND status NOT IN ('cancelled', 'authorised')
            RETURNING id`,
          [sample.id, ctx.userId],
        );

        const recollect = body.recollect && reason.requires_recollection && affected.length > 0;
        let recollectionSampleId: string | null = null;
        if (recollect) {
          recollectionSampleId = await this.raiseRecollection(
            tx,
            sample,
            affected.map((a) => a.id),
          );
        }

        await writeOrderEvent(tx, {
          orderId: sample.order_id,
          sampleId: sample.id,
          from: sample.status,
          to: 'rejected',
          reason: `${reason.code}: ${reason.label}`,
        });

        await this.audit.write(tx, {
          action: 'update',
          entity: 'lab.lab_samples',
          rowId: sample.id,
          businessKey: sample.sample_no,
          dataClass: 'phi',
          patientId: sample.patient_id,
          before: { status: sample.status },
          after: {
            status: 'rejected',
            rejection_reason_code: reason.code,
            recollection_sample_id: recollectionSampleId,
          },
          reasonCode: reason.code,
          reasonText: body.note ?? reason.label,
        });

        await this.outbox.publish(
          tx,
          labEvent('lab.sample.rejected', sample.id, {
            sampleId: sample.id,
            orderId: sample.order_id,
            patientId: sample.patient_id,
            reasonCode: reason.code,
            reasonText: reason.label,
            recollectionOrdered: recollectionSampleId !== null,
            rejectedBy: actorId(),
            rejectedAt: new Date().toISOString(),
          }),
        );

        return sample.id;
      }),
    );

    return this.getSample(result);
  }

  async getSample(id: string): Promise<LabSampleView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<LabSampleView>(
        `SELECT id, sample_no, barcode, status::text AS status, specimen_type_name, container_name,
                cap_colour, collected_at::text AS collected_at, received_at::text AS received_at,
                accessioned_at::text AS accessioned_at,
                condition_on_receipt::text AS condition_on_receipt, rejection_reason_code,
                rejection_note, rejected_at::text AS rejected_at, recollection_of_sample_id,
                patient_scan_verified, container_scan_verified, identity_override_reason
           FROM lab.lab_samples WHERE id = $1`,
        [id],
      );
      if (row === undefined) throw AppError.notFound('The specimen');
      return row;
    });
  }

  async getByBarcode(barcode: string): Promise<LabSampleView> {
    const id = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<{ id: string }>(`SELECT id FROM lab.lab_samples WHERE barcode = $1`, [
        barcode,
      ]);
      if (row === undefined) throw AppError.notFound('The specimen');
      return row.id;
    });
    return this.getSample(id);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * A barcode resolves to at most one specimen per hospital — the unique index
   * guarantees it, and RLS is what makes "per hospital" true. A scan from
   * another tenant therefore reads as a specimen that does not exist, which is
   * the answer `docs/09 §3.1` requires.
   */
  private async lockByBarcode(tx: TransactionClient, barcode: string): Promise<SampleRow> {
    const row = await tx.maybeOne<SampleRow>(
      `SELECT id, order_id, patient_id, branch_id, sample_no, barcode, status::text AS status,
              specimen_type_key, specimen_type_name, container_key, container_name, cap_colour,
              is_chain_of_custody
         FROM lab.lab_samples
        WHERE barcode = $1
        FOR UPDATE`,
      [barcode],
    );
    if (row === undefined) throw AppError.notFound('The specimen');
    return row;
  }

  private async printLabels(
    tx: TransactionClient,
    input: {
      readonly sampleId: string;
      readonly barcode: string;
      readonly specimenTypeName: string;
      readonly containerName: string | null;
      readonly capColour: string | null;
      readonly testCodes: readonly string[];
      readonly copies: number;
      readonly isReprint: boolean;
      readonly reprintReason: string | null;
      readonly printerId: string | null;
    },
  ): Promise<LabLabelView[]> {
    const ctx = getContext();
    const start = await tx.one<{ n: number }>(
      `SELECT COALESCE(max(copy_no), 0)::int AS n FROM lab.lab_sample_labels WHERE sample_id = $1`,
      [input.sampleId],
    );

    const printed: LabLabelView[] = [];
    for (let i = 1; i <= input.copies; i += 1) {
      const id = newId();
      const copyNo = start.n + i;
      const row = await tx.one<{ printed_at: string }>(
        `INSERT INTO lab.lab_sample_labels
           (id, hospital_id, sample_id, barcode, symbology, copy_no, is_reprint, reprint_reason,
            printer_id, printed_by)
         VALUES ($1, $2, $3, $4, 'code128', $5, $6, $7, $8, $9)
         RETURNING printed_at::text AS printed_at`,
        [
          id,
          ctx.hospitalId,
          input.sampleId,
          input.barcode,
          copyNo,
          input.isReprint,
          input.reprintReason,
          input.printerId,
          ctx.userId,
        ],
      );

      printed.push({
        id,
        sample_id: input.sampleId,
        barcode: input.barcode,
        symbology: 'code128',
        copy_no: copyNo,
        is_reprint: input.isReprint,
        specimen_type_name: input.specimenTypeName,
        container_name: input.containerName,
        cap_colour: input.capColour,
        test_codes: input.testCodes,
        printed_at: row.printed_at,
      });
    }
    return printed;
  }

  /**
   * `OP-004 §5`: the routine turnaround clock starts at receipt, and NABL
   * requires the laboratory to have declared where it starts. A STAT line has
   * already had its clock started at ordering, so this only touches the lines
   * that were still waiting.
   */
  private async startRoutineTatClock(tx: TransactionClient, sampleId: string): Promise<void> {
    await tx.query(
      // A correlated scalar subquery rather than `FROM LATERAL`: the target of
      // an UPDATE is not in the from_list, so a lateral join cannot see `ot`.
      `UPDATE lab.lab_order_tests ot
          SET tat_clock_starts_at = now(),
              tat_due_at = now() + make_interval(mins => COALESCE((
                SELECT CASE ot.priority
                         WHEN 'stat'   THEN x.tat_stat_minutes
                         WHEN 'urgent' THEN x.tat_urgent_minutes
                         ELSE x.tat_routine_minutes
                       END
                  FROM mdm.mdm_lab_tests x
                 WHERE x.record_key = ot.test_key AND x.status = 'active'
                 ORDER BY x.version DESC
                 LIMIT 1
              ), 240)),
              updated_at = now()
        WHERE ot.sample_id = $1 AND ot.tat_clock_starts_at IS NULL AND ot.status <> 'cancelled'`,
      [sampleId],
    );
  }

  /**
   * The order's status is the least-advanced of its live specimens. Computed
   * rather than stepped, because a specimen can be rejected and recollected and
   * the order must fall back rather than march on.
   */
  private async advanceOrder(tx: TransactionClient, orderId: string): Promise<void> {
    await tx.query(
      `UPDATE lab.lab_orders o
          SET status = agg.next_status::lab."LabOrderStatus", updated_at = now(), version = o.version + 1
         FROM (
           SELECT CASE
                    WHEN bool_and(s.status IN ('accessioned', 'in_process', 'consumed', 'stored'))
                      THEN 'in_progress'
                    WHEN bool_and(s.status IN ('received', 'accessioned', 'in_process', 'consumed', 'stored'))
                      THEN 'received'
                    WHEN bool_and(s.status IN ('collected', 'dispatched', 'received', 'accessioned',
                                               'in_process', 'consumed', 'stored'))
                      THEN 'collected'
                    ELSE 'awaiting_collection'
                  END AS next_status
             FROM lab.lab_samples s
            WHERE s.order_id = $1 AND s.status <> 'rejected'
         ) agg
        WHERE o.id = $1
          AND o.status NOT IN ('cancelled', 'partially_reported', 'reported')
          AND o.status IS DISTINCT FROM agg.next_status::lab."LabOrderStatus"`,
      [orderId],
    );
  }

  /**
   * The replacement container, on the same order, naming the specimen it
   * replaces. `lab.enforce_recollection_trace()` refuses anything else — and
   * `lab_order_tests_recollection_free` refuses a chargeable replacement line,
   * which is `OP-004 §5`'s "recollection order at zero charge" as a constraint
   * rather than as a billing habit.
   */
  private async raiseRecollection(
    tx: TransactionClient,
    rejected: SampleRow,
    rejectedLineIds: readonly string[],
  ): Promise<string> {
    const ctx = getContext();
    const sampleId = newId();

    const allocation = await this.numbering.allocate(tx, {
      key: 'SAMPLE',
      branchId: rejected.branch_id,
      refType: 'lab.lab_samples',
      refId: sampleId,
    });

    const seq = await tx.one<{ n: number }>(
      `SELECT COALESCE(max(container_seq), 0)::int AS n FROM lab.lab_samples WHERE order_id = $1`,
      [rejected.order_id],
    );

    await tx.query(
      `INSERT INTO lab.lab_samples (
         id, hospital_id, branch_id, order_id, patient_id, sample_no, barcode, container_seq,
         specimen_type_key, specimen_type_name, container_key, container_name, cap_colour,
         status, recollection_of_sample_id, is_chain_of_custody, seal_no,
         created_by, updated_by, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $6, $7,
         $8, $9, $10, $11, $12,
         'pending', $13, $14, $15, $16, $16, now()
       )`,
      [
        sampleId,
        ctx.hospitalId,
        rejected.branch_id,
        rejected.order_id,
        rejected.patient_id,
        allocation.formatted,
        seq.n + 1,
        rejected.specimen_type_key,
        rejected.specimen_type_name,
        rejected.container_key,
        rejected.container_name,
        rejected.cap_colour,
        rejected.id,
        rejected.is_chain_of_custody,
        rejected.is_chain_of_custody ? allocation.formatted : null,
        ctx.userId,
      ],
    );

    const maxLine = await tx.one<{ n: number }>(
      `SELECT COALESCE(max(line_no), 0)::int AS n FROM lab.lab_order_tests WHERE order_id = $1`,
      [rejected.order_id],
    );

    let lineNo = maxLine.n;
    for (const originalId of rejectedLineIds) {
      lineNo += 1;
      await tx.query(
        `INSERT INTO lab.lab_order_tests (
           id, hospital_id, order_id, line_no, order_item_id, test_key, test_code, test_name,
           loinc_code, discipline, sample_id, priority, status, panel_key,
           recollection_of_order_test_id, recollection_requested_at, is_chargeable,
           tat_clock_starts_at, tat_due_at, created_by, updated_by, updated_at
         )
         SELECT $1, o.hospital_id, o.order_id, $2, o.order_item_id, o.test_key, o.test_code, o.test_name,
                o.loinc_code, o.discipline, $3, o.priority, 'pending', o.panel_key,
                o.id, now(), false,
                o.tat_clock_starts_at, o.tat_due_at, $4, $4, now()
           FROM lab.lab_order_tests o
          WHERE o.id = $5`,
        [newId(), lineNo, sampleId, ctx.userId, originalId],
      );
    }

    await tx.query(
      `UPDATE lab.lab_order_tests
          SET status = 'recollection_requested', recollection_requested_at = now(),
              updated_by = $2, updated_at = now(), version = version + 1
        WHERE id = ANY($1::uuid[])`,
      [rejectedLineIds, ctx.userId],
    );

    await writeOrderEvent(tx, {
      orderId: rejected.order_id,
      sampleId,
      to: 'recollection_requested',
      reason: `replaces ${rejected.sample_no}`,
    });

    return sampleId;
  }
}

interface SampleRow {
  readonly id: string;
  readonly order_id: string;
  readonly patient_id: string;
  readonly branch_id: string;
  readonly sample_no: string;
  readonly barcode: string;
  readonly status: string;
  readonly specimen_type_key: string;
  readonly specimen_type_name: string;
  readonly container_key: string | null;
  readonly container_name: string | null;
  readonly cap_colour: string | null;
  readonly is_chain_of_custody: boolean;
}

interface PendingLineRow {
  readonly order_test_id: string;
  readonly test_code: string;
  readonly specimen_type_key: string;
  readonly specimen_type_name: string | null;
  readonly container_key: string | null;
  readonly container_name: string | null;
  readonly cap_colour: string | null;
  readonly order_of_draw: number;
}

interface ExistingSampleRow {
  readonly id: string;
  readonly barcode: string;
  readonly specimen_type_name: string;
  readonly container_name: string | null;
  readonly cap_colour: string | null;
}
