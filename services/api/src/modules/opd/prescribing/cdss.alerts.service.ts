import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { PolicyService } from '../../../core/policy/policy.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { CdssService } from './cdss.service.js';
import { prescribingEvent } from './prescribing.events.js';
import type { AlertQuery, AlertResponseRequest, FatigueQuery } from './prescribing.schemas.js';
import type { AlertFatigueReport } from './prescribing.types.js';

/**
 * EN-029 §6 — the clinician's response to an alert, the alert history, and the
 * alert-fatigue numbers.
 *
 * The interesting method is `respond`, because it is the only lawful way past a
 * product hard stop, and EN-029 §3.2.7 is explicit that it is **not an
 * override**: "it requires either (a) a different order, or (b) a countersign by
 * an authorised role captured as a second signature". So the endpoint enforces
 * three things the database cannot:
 *
 *  * the caller must hold `rx.cosign` — the consultant key;
 *  * the caller must not be the prescriber whose order fired the alert, because
 *    a second signature by the same person is one signature;
 *  * the floor entry must actually admit a countersignature. Three of the six
 *    (pregnancy X, the NDPS cap, the missing paediatric weight) carry no
 *    `countersign_role` at all, and for those the answer is to change the order.
 *    The database refuses them too; this produces a sentence instead of a
 *    constraint name.
 */
@Injectable()
export class CdssAlertsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(CdssService) private readonly cdss: CdssService,
  ) {}

  async respond(alertEventId: string, body: AlertResponseRequest): Promise<{ readonly actionId: string }> {
    const alert = await this.db.withTenant(currentTenantContext(), async (tx) =>
      tx.maybeOne<AlertEventRow>(
        `SELECT e.id, e.patient_id, e.encounter_id, e.safety_floor_key, e.family::text AS family,
                e.severity::text AS severity, e.interruption::text AS interruption,
                e.actor_user_id, e.fired_at::text AS fired_at, e.title,
                f.countersign_role
           FROM clinical.cdss_alert_events e
           LEFT JOIN clinical.cdss_safety_floor f ON f.key = e.safety_floor_key
          WHERE e.id = $1 AND e.fired_at = $2::timestamptz`,
        [alertEventId, body.firedAt],
      ),
    );
    if (alert === undefined) throw AppError.notFound('The alert');

    const ctx = getContext();
    const isFloor = alert.safety_floor_key !== null;

    if (isFloor) {
      if (body.kind !== 'overridden') {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          'A hard stop cannot be acknowledged away. Change the order, or record a countersigned override.',
        );
      }
      if (alert.countersign_role === null) {
        throw new AppError(
          ProblemType.CLINICAL_HARD_STOP,
          `This safety rule (${alert.safety_floor_key ?? ''}) admits no override at all. The order must change.`,
          {
            clinicalImpact: alert.title,
            nextAction: 'Change the prescription — there is no countersignature that clears this one.',
          },
        );
      }
      // The consultant key, asserted through the policy engine so the
      // catalogue's own conditions on it apply.
      await this.policy.assert('rx.cosign');
      if (alert.actor_user_id !== null && alert.actor_user_id === ctx.userId) {
        throw new AppError(
          ProblemType.SECOND_PERSON_REQUIRED,
          'A hard stop is cleared by a second clinician, not by the prescriber who raised it.',
        );
      }
    }

    if (body.kind === 'overridden' && body.reasonCode === undefined) {
      throw AppError.validation([
        {
          path: 'reasonCode',
          code: 'coded_reason_required',
          message: 'An override needs a coded reason. Free text on its own is not accepted (EN-029 §5).',
        },
      ]);
    }

    const actionId = await this.db.withTenant(currentTenantContext(), async (tx) => {
      if (body.kind === 'overridden') {
        const reasonCode = body.reasonCode ?? '';
        const id = await this.cdss.recordOverride(tx, {
          alertEventId,
          firedAt: body.firedAt,
          patientId: alert.patient_id,
          reasonCode,
          note: body.note ?? null,
          countersignedBy: isFloor ? ctx.userId : null,
          actorUserId: isFloor ? alert.actor_user_id : ctx.userId,
        });

        const at = new Date().toISOString();
        if (isFloor) {
          await this.outbox.publish(
            tx,
            prescribingEvent('cdss.hardstop.countersigned', alertEventId, {
              alertEventId,
              alertFiredAt: body.firedAt,
              patientId: alert.patient_id,
              actorUserId: alert.actor_user_id ?? '',
              countersignedBy: ctx.userId ?? '',
              overrideReasonCode: reasonCode,
              at,
            }),
          );
        } else {
          await this.outbox.publish(
            tx,
            prescribingEvent('cdss.alert.overridden', alertEventId, {
              alertEventId,
              alertFiredAt: body.firedAt,
              actionId: id,
              patientId: alert.patient_id,
              overrideReasonCode: reasonCode,
              overrideNote: body.note ?? null,
              actorUserId: ctx.userId ?? '',
              actorRole: ctx.roleKeys[0] ?? null,
              countersignedBy: null,
              timeToActionMs: null,
              at,
            }),
          );
        }
        return id;
      }

      const id = newId();
      const kind =
        body.kind === 'acknowledged'
          ? 'acknowledged'
          : body.kind === 'order_changed'
            ? 'order_changed'
            : 'order_abandoned';
      await tx.query(
        `INSERT INTO clinical.cdss_alert_actions
           (id, hospital_id, alert_event_id, alert_fired_at, kind, actor_user_id, actor_role)
         VALUES ($1, $2, $3, $4::timestamptz, $5::clinical."CdssAlertActionKind", $6, $7)`,
        [id, ctx.hospitalId, alertEventId, body.firedAt, kind, ctx.userId, ctx.roleKeys[0] ?? null],
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.cdss_alert_actions',
        rowId: id,
        businessKey: alert.safety_floor_key ?? alert.family,
        dataClass: 'phi',
        patientId: alert.patient_id,
        before: null,
        after: { kind, alert_event_id: alertEventId },
      });

      if (kind === 'acknowledged') {
        await this.outbox.publish(
          tx,
          prescribingEvent('cdss.alert.acknowledged', alertEventId, {
            alertEventId,
            alertFiredAt: body.firedAt,
            actionId: id,
            patientId: alert.patient_id,
            actorUserId: ctx.userId ?? '',
            actorRole: ctx.roleKeys[0] ?? null,
            timeToActionMs: null,
            at: new Date().toISOString(),
          }),
        );
      }
      return id;
    });

    return { actionId };
  }

  async list(query: AlertQuery): Promise<Page<AlertListItem>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const resource = 'cdss.alerts';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = (value: unknown): string => `$${values.push(value)}`;
      const clauses: string[] = [];
      if (query.patientId !== undefined) clauses.push(`e.patient_id = ${bind(query.patientId)}::uuid`);
      if (query.encounterId !== undefined) clauses.push(`e.encounter_id = ${bind(query.encounterId)}::uuid`);
      if (query.family !== undefined) clauses.push(`e.family = ${bind(query.family)}::clinical."CdssFamily"`);
      if (query.outcome !== undefined) {
        clauses.push(`e.outcome = ${bind(query.outcome)}::clinical."CdssAlertOutcome"`);
      }
      if (after !== null) {
        clauses.push(`(e.fired_at, e.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;

      const rows = await tx.rows<AlertListItem & { cursor_key: string }>(
        `SELECT e.id, e.fired_at::text AS fired_at, e.patient_id, e.encounter_id,
                e.safety_floor_key, e.family::text AS family, e.severity::text AS severity,
                e.interruption::text AS interruption, e.outcome::text AS outcome,
                e.title, e.latency_ms, e.degraded, e.context_ref,
                a.kind::text AS action_kind, a.override_reason_code,
                e.fired_at::text AS cursor_key
           FROM clinical.cdss_alert_events e
           LEFT JOIN LATERAL (
             SELECT kind, override_reason_code
               FROM clinical.cdss_alert_actions x
              WHERE x.alert_event_id = e.id AND x.alert_fired_at = e.fired_at
              ORDER BY x.at DESC LIMIT 1
           ) a ON true
           ${where}
          ORDER BY e.fired_at DESC, e.id DESC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      return this.cursors.keysetPage<AlertListItem>(rows, limit, {
        hospitalId,
        resource,
        direction: 'desc',
      });
    });
  }

  /**
   * `phase-02` exit gate 8 — the alert-fatigue numbers, including the override
   * distribution by coded reason.
   *
   * This aggregates `cdss_alert_events` and `cdss_alert_actions` over a window
   * capped at 31 days. The permanent home for these figures is
   * `clinical.cdss_rule_metrics`, refreshed every fifteen minutes by the worker
   * (`docs/03` §Performance rules: a dashboard never aggregates a partitioned
   * table live) — that refresher belongs to `services/worker` and is not in this
   * module. Until it exists, a bounded governance query is the honest way to
   * make the number real rather than to leave the endpoint returning zeroes.
   */
  async fatigue(query: FatigueQuery): Promise<AlertFatigueReport> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const totals = await tx.one<{
        fires: string;
        displays: string;
        blocks: string;
        overrides: string;
        acknowledgements: string;
      }>(
        `SELECT count(*)::text AS fires,
                count(*) FILTER (WHERE e.displayed)::text AS displays,
                count(*) FILTER (WHERE e.outcome = 'hard_stop_blocked')::text AS blocks,
                count(a.id) FILTER (WHERE a.kind = 'overridden')::text AS overrides,
                count(a.id) FILTER (WHERE a.kind = 'acknowledged')::text AS acknowledgements
           FROM clinical.cdss_alert_events e
           LEFT JOIN clinical.cdss_alert_actions a
                  ON a.alert_event_id = e.id AND a.alert_fired_at = e.fired_at
          WHERE e.fired_at > now() - make_interval(days => $1::int)`,
        [query.days],
      );

      const byFamily = await tx.rows<{ family: string; fires: string; overrides: string; blocks: string }>(
        `SELECT e.family::text AS family,
                count(*)::text AS fires,
                count(a.id) FILTER (WHERE a.kind = 'overridden')::text AS overrides,
                count(*) FILTER (WHERE e.outcome = 'hard_stop_blocked')::text AS blocks
           FROM clinical.cdss_alert_events e
           LEFT JOIN clinical.cdss_alert_actions a
                  ON a.alert_event_id = e.id AND a.alert_fired_at = e.fired_at
          WHERE e.fired_at > now() - make_interval(days => $1::int)
          GROUP BY e.family
          ORDER BY count(*) DESC`,
        [query.days],
      );

      const reasons = await tx.rows<{ code: string; count: string }>(
        `SELECT a.override_reason_code AS code, count(*)::text AS count
           FROM clinical.cdss_alert_actions a
          WHERE a.kind = 'overridden'
            AND a.at > now() - make_interval(days => $1::int)
            AND a.override_reason_code IS NOT NULL
          GROUP BY a.override_reason_code
          ORDER BY count(*) DESC`,
        [query.days],
      );

      // "Alerts per 1000 orders" needs a denominator: prescription lines and
      // order lines are the orderable things EN-029 counts.
      const denominator = await tx.one<{ n: string }>(
        `SELECT (
           (SELECT count(*) FROM clinical.prescription_items
             WHERE created_at > now() - make_interval(days => $1::int))
           + (SELECT count(*) FROM clinical.order_items
               WHERE created_at > now() - make_interval(days => $1::int))
         )::text AS n`,
        [query.days],
      );

      const fires = Number(totals.fires);
      const overrides = Number(totals.overrides);
      const displays = Number(totals.displays);
      const orders = Number(denominator.n);

      return {
        windowDays: query.days,
        fires,
        displays,
        blocks: Number(totals.blocks),
        overrides,
        acknowledgements: Number(totals.acknowledgements),
        overrideRatePct: displays === 0 ? 0 : Number(((overrides / displays) * 100).toFixed(2)),
        alertsPer1000Orders: orders === 0 ? 0 : Number(((fires / orders) * 1000).toFixed(2)),
        ordersEvaluated: orders,
        overridesByReason: Object.fromEntries(reasons.map((r) => [r.code, Number(r.count)])),
        byFamily: byFamily.map((f) => ({
          family: f.family,
          fires: Number(f.fires),
          overrides: Number(f.overrides),
          blocks: Number(f.blocks),
        })),
      };
    });
  }
}

interface AlertEventRow {
  readonly id: string;
  readonly patient_id: string;
  readonly encounter_id: string | null;
  readonly safety_floor_key: string | null;
  readonly family: string;
  readonly severity: string;
  readonly interruption: string;
  readonly actor_user_id: string | null;
  readonly fired_at: string;
  readonly title: string;
  readonly countersign_role: string | null;
}

export interface AlertListItem {
  readonly id: string;
  readonly fired_at: string;
  readonly patient_id: string;
  readonly encounter_id: string | null;
  readonly safety_floor_key: string | null;
  readonly family: string;
  readonly severity: string;
  readonly interruption: string;
  readonly outcome: string;
  readonly title: string;
  readonly latency_ms: number | null;
  readonly degraded: boolean;
  readonly context_ref: Record<string, unknown>;
  readonly action_kind: string | null;
  readonly override_reason_code: string | null;
}
