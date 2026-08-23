import type { Pool } from 'pg';

/**
 * The automatic half of the critical-value loop — `OP-004 §5` line 1, `EN-037`.
 *
 * `lab.raise_critical_value_alert()` creates the obligation in the same
 * transaction as the value, so a critical result and its alert cannot come
 * apart (D-10). What the database cannot do is notice that nobody answered.
 * `due_by` is written at detection and then nothing reads it: an alert raised at
 * 02:00 for a doctor who never opened their inbox stays `open` at 09:00, and the
 * NABL indicator — "% criticals communicated ≤ 30 min" — is missed silently.
 *
 * This is the thing that watches the clock.
 *
 * **The ladder** is `OP-004 §3` as written: raised to the ordering doctor and
 * the ward nurse, **10 minutes** unacknowledged to the HOD / on-call, **20
 * minutes** to the medical superintendent. Tier 0 is the raise itself, so this
 * job only ever moves an alert from 0 to 1 and from 1 to 2.
 *
 * Four properties, each because the obvious version is wrong:
 *
 * **It escalates the level, not the status.** `status` records whether anyone
 * answered; `escalation_level` records how far up the ladder the alert has been
 * shouted. The database enforces the distinction --
 * `lab_critical_value_alerts_communicated_pairing` refuses `escalated` on an
 * alert with no `first_communicated_at` -- and it is right to: an automatic
 * escalation happens *because* nobody was reached, so marking it communicated
 * would be a lie told to the NABL indicator.
 *
 * **It never closes an alert.** Escalation is not acknowledgement. The only
 * things that may set `acknowledged` are a call-back with read-back confirmed
 * and a recorded "clinician unreachable — escalated to <tier>", both entered by
 * a person through `POST /lab/critical-values/:id/acknowledge`. A job that
 * marked an alert done because it had shouted loudly enough would convert a
 * missed phone call into a closed KPI row, which is the exact failure the
 * indicator exists to catch.
 *
 * **It stops climbing but never stops caring.** Past the top tier the alert
 * keeps `status = 'escalated'` and stays on the console; it simply gains no
 * further tiers. Auto-retracting or auto-acknowledging a stale alert would hide
 * the one case that most needs a human.
 *
 * **`due_by` is pushed forward on every escalation.** Without that the alert is
 * overdue on the very next tick and re-escalates every poll interval, which
 * pages the medical superintendent several times a minute and trains everyone
 * to ignore the channel.
 *
 * **`FOR UPDATE SKIP LOCKED`.** Several worker replicas run this. A plain
 * SELECT would hand the same alerts to all of them and escalate each one N
 * times; `SKIP LOCKED` gives each replica a disjoint slice with no waiting —
 * the same reasoning as `outbox-relay.ts`.
 */

/** `OP-004 §3`: 10 minutes to the HOD, 20 to the medical superintendent. */
export interface EscalationTier {
  /** The level written to `escalation_level` when this tier fires. */
  readonly level: number;
  /** Minutes after **detection** at which this tier becomes due. */
  readonly minutesFromDetection: number;
  /**
   * Who is being woken. Carried in the event rather than resolved here: this
   * process has no business deciding who the on-call HOD is, and EN-037 owns
   * the directory.
   */
  readonly notifyRole: string;
}

export const DEFAULT_ESCALATION_LADDER: readonly EscalationTier[] = Object.freeze([
  { level: 1, minutesFromDetection: 10, notifyRole: 'hod_on_call' },
  { level: 2, minutesFromDetection: 20, notifyRole: 'medical_superintendent' },
]);

export interface EscalationOptions {
  readonly batchSize?: number;
  readonly ladder?: readonly EscalationTier[];
  /**
   * The event written to the outbox. Passed in rather than hardcoded so the
   * caller — which owns the contract — decides, and so a test can assert the
   * row without depending on the registry.
   */
  readonly eventType?: string;
  /** Injected so a test can drive the clock instead of sleeping. */
  readonly now?: () => Date;
}

export interface EscalationResult {
  readonly escalated: number;
  /** Overdue but already at the top tier: still open, deliberately not climbed. */
  readonly atTopTier: number;
}

interface OverdueRow {
  id: string;
  hospital_id: string;
  branch_id: string;
  result_id: string;
  order_id: string;
  patient_id: string;
  analyte_name: string;
  value_display: string;
  unit: string | null;
  ordering_user_id: string | null;
  escalation_level: number;
  detected_at: Date;
  minutes_overdue: number;
}

export async function escalateOverdueCriticalValues(
  pool: Pool,
  options: EscalationOptions = {},
): Promise<EscalationResult> {
  const batchSize = options.batchSize ?? 100;
  const ladder = options.ladder ?? DEFAULT_ESCALATION_LADDER;
  const eventType = options.eventType ?? 'lab.critical.escalated';
  const now = options.now ?? (() => new Date());

  const client = await pool.connect();
  let escalated = 0;
  let atTopTier = 0;

  try {
    await client.query('BEGIN');

    // `status <> 'acknowledged'` is not enough: a retracted alert is also
    // closed, and escalating one would page a superintendent about a result the
    // laboratory has already withdrawn.
    const overdue = await client.query<OverdueRow>(
      `SELECT a.id, a.hospital_id, a.branch_id, a.result_id, a.order_id, a.patient_id,
              a.analyte_name, a.value_display, a.unit, a.ordering_user_id,
              a.escalation_level, a.detected_at,
              floor(EXTRACT(EPOCH FROM ($1::timestamptz - a.due_by)) / 60)::int AS minutes_overdue
         FROM lab.lab_critical_value_alerts a
        WHERE a.status IN ('open', 'communicated', 'escalated')
          AND a.due_by IS NOT NULL
          AND a.due_by <= $1::timestamptz
        ORDER BY a.due_by
        LIMIT $2
          FOR UPDATE OF a SKIP LOCKED`,
      [now().toISOString(), batchSize],
    );

    for (const alert of overdue.rows) {
      const next = ladder.find((tier) => tier.level === alert.escalation_level + 1);

      if (next === undefined) {
        // Already at the top. Left `escalated` and left overdue on purpose: the
        // console sorts by `due_by`, so the longest-unanswered alert stays at
        // the top of the list where somebody will see it.
        atTopTier += 1;
        continue;
      }

      const following = ladder.find((tier) => tier.level === next.level + 1);
      const nextDueBy =
        following === undefined
          ? null
          : new Date(alert.detected_at.getTime() + following.minutesFromDetection * 60_000);

      // `status` and `escalation_level` are different axes, and the database
      // says so: `lab_critical_value_alerts_communicated_pairing` requires
      // `first_communicated_at IS NOT NULL` for any alert claiming
      // `communicated`, `escalated` or `acknowledged`.
      //
      // An automatic escalation fires *because nobody was reached*. Setting
      // `status = 'escalated'` on an alert nobody has answered would both
      // violate that CHECK and assert something false -- that the laboratory
      // had communicated the value. So the status only advances when a human
      // has already communicated something; otherwise the alert stays `open`
      // and only climbs the ladder. Level says how far up we have shouted;
      // status says whether anyone answered.
      await client.query(
        `UPDATE lab.lab_critical_value_alerts
            SET escalation_level = $2,
                status = CASE
                           WHEN first_communicated_at IS NOT NULL THEN 'escalated'::lab."LabCriticalAlertStatus"
                           ELSE status
                         END,
                due_by = $3,
                updated_at = now()
          WHERE id = $1`,
        [alert.id, next.level, nextDueBy],
      );

      // Written in the same transaction as the state change, so an escalation
      // that is recorded is an escalation that is announced -- the transactional
      // outbox pattern this application uses everywhere (docs/01 §5). The relay
      // publishes it; EN-037 resolves `notifyRole` to actual people.
      await client.query(
        `INSERT INTO core.outbox_events
           (id, hospital_id, branch_id, aggregate, aggregate_id, event_type, schema_version,
            payload, contains_phi, actor_type, correlation_id, occurred_at, retention_days)
         VALUES (gen_random_uuid(), $1, $2, 'lab_critical_value', $3, $4, 1,
                 $5::jsonb, true, 'system', $6, now(), 2555)`,
        [
          alert.hospital_id,
          alert.branch_id,
          alert.id,
          eventType,
          JSON.stringify({
            alertId: alert.id,
            resultId: alert.result_id,
            orderId: alert.order_id,
            patientId: alert.patient_id,
            orderingDoctorUserId: alert.ordering_user_id,
            analyteName: alert.analyte_name,
            value: alert.value_display,
            unit: alert.unit,
            escalationLevel: next.level,
            notifyRole: next.notifyRole,
            minutesFromDetection: next.minutesFromDetection,
            minutesOverdue: Math.max(0, alert.minutes_overdue),
            detectedAt: alert.detected_at.toISOString(),
          }),
          `crit-esc-${alert.id}-${String(next.level)}`,
        ],
      );

      escalated += 1;
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return { escalated, atTopTier };
}
