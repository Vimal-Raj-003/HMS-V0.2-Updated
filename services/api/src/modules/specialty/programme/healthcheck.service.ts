import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { consoleEvent } from '../consoles/consoles.events.js';
import {
  ConsoleSupport,
  asJson,
  asNumber,
  asNumberOrNull,
  asStringArray,
  asText,
  asTextOrNull,
} from '../consoles/consoles.support.js';
import type {
  HcBookingRequest,
  HcCheckInRequest,
  HcQuery,
  HcReportRequest,
  StationUpdateRequest,
} from './programme.schemas.js';
import type { HcEpisodeDetail, HcEpisodeRow, HcReportRow, HcStationRow } from './programme.types.js';

/** The station states that count as resolved: done, or a recorded decision not to. */
const RESOLVED = new Set(['done', 'skipped', 'not_applicable']);

/**
 * OP-014 — health check-ups.
 *
 * ── The routing slip is copied at check-in, not read live ──────────────────
 *
 * `dependsOn` is snapshotted from the package onto each task when the patient
 * arrives. A package revised at eleven does not change a slip already walking
 * round the building — which is the difference between a configuration change
 * and forty people being sent back to a station they already passed.
 *
 * ── Nothing here decides whether a station may start ───────────────────────
 *
 * The trigger does. What the service adds is `ready` and `blockedBy` on every
 * task, so the board shows what can be called next instead of a queue of
 * refusals. The same facts, offered forwards.
 *
 * ── And nothing here averages a health score ───────────────────────────────
 *
 * The weights come from the package's model, in the database. A second
 * implementation here would diverge the first time a hospital revised its
 * model, and the number is what the patient reads.
 */
@Injectable()
export class HealthCheckService extends ConsoleSupport {
  async book(body: HcBookingRequest): Promise<{ readonly id: string; readonly status: string }> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.hc_bookings
           (id, hospital_id, branch_id, patient_id, corporate_id, employee_ref, package_id,
            package_version, add_ons, scheduled_at, channel, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,
                 (SELECT version FROM specialty.hc_packages WHERE id = $7),
                 $8::jsonb,$9::timestamptz,$10,$11, now(), now())
         RETURNING id, status`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId ?? null,
          body.corporateId ?? null,
          body.employeeRef ?? null,
          body.packageId,
          JSON.stringify(body.addOns),
          body.scheduledAt,
          body.channel,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The booking was not created.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'hc_booking',
        rowId: id,
        businessKey: body.patientId ?? body.employeeRef ?? id,
        dataClass: 'operational',
        patientId: body.patientId ?? null,
        encounterId: null,
        before: null,
        after: { channel: body.channel, scheduledAt: body.scheduledAt },
      });

      return { id: asText(row['id']), status: asText(row['status']) };
    });
  }

  /**
   * Check in, and raise the slip.
   *
   * The stations and their dependencies are copied from the package here, once.
   * Everything afterwards reads the copy.
   */
  async checkIn(bookingId: string, body: HcCheckInRequest): Promise<HcEpisodeDetail> {
    return this.guard(async (tx) => {
      const { rows: pkg } = await tx.query<Record<string, unknown>>(
        `SELECT p.station_sequence
           FROM specialty.hc_bookings b
           JOIN specialty.hc_packages p ON p.id = b.package_id
          WHERE b.hospital_id = $1 AND b.id = $2`,
        [this.hospitalId(), bookingId],
      );
      const sequence = pkg[0]?.['station_sequence'];
      if (sequence === undefined) throw AppError.notFound('That booking does not exist.');

      const stations = Array.isArray(sequence) ? (sequence as Record<string, unknown>[]) : [];
      if (stations.length === 0) {
        throw AppError.conflict('That package has no stations, so there is no slip to raise.');
      }

      const episodeId = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.hc_episodes
           (id, hospital_id, branch_id, booking_id, patient_id, visit_id, checked_in_at,
            routing_slip_no, consent_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now(),
                 'RS-' || lpad((
                   SELECT count(*) + 1 FROM specialty.hc_episodes
                    WHERE hospital_id = $2 AND checked_in_at::date = current_date
                 )::text, 5, '0'),
                 $7, now(), now())
         RETURNING id`,
        [
          episodeId,
          this.hospitalId(),
          this.branchId(),
          bookingId,
          body.patientId,
          body.visitId ?? null,
          body.consentId ?? null,
        ],
      );
      if (rows[0] === undefined) throw AppError.conflict('The check-in did not complete.');

      let seq = 0;
      for (const station of stations) {
        seq += 1;
        // The package's sequence is free-form JSON, so a malformed entry is a
        // configuration error rather than a crash: a station with no name is
        // refused here rather than becoming an empty row on somebody's slip.
        const name = station['station'];
        if (typeof name !== 'string' || name.trim().length === 0) {
          throw AppError.conflict(
            `Station ${String(seq)} of this package has no name, so the routing slip cannot be raised.`,
          );
        }
        const depends = station['dependsOn'];
        await tx.query(
          `INSERT INTO specialty.hc_station_tasks
             (id, hospital_id, episode_id, station, seq, depends_on, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6::text[], now(), now())`,
          [
            newId(),
            this.hospitalId(),
            episodeId,
            name,
            seq,
            Array.isArray(depends) ? depends.map((d) => String(d)) : [],
          ],
        );
      }

      await tx.query(
        `UPDATE specialty.hc_bookings SET status = 'checked_in', updated_at = now()
          WHERE hospital_id = $1 AND id = $2`,
        [this.hospitalId(), bookingId],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'hc_episode',
        rowId: episodeId,
        businessKey: bookingId,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: body.visitId ?? null,
        before: null,
        after: { stations: stations.length },
      });

      return this.detailWithin(tx, episodeId);
    });
  }

  async updateStation(id: string, body: StationUpdateRequest): Promise<HcEpisodeDetail> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.hc_station_tasks
            SET status = $3::specialty."HcTaskStatus",
                skip_reason = coalesce($4, skip_reason),
                source_ref = coalesce($5, source_ref),
                called_at = CASE WHEN $3 = 'called' THEN coalesce(called_at, now()) ELSE called_at END,
                done_by = CASE WHEN $3 = 'done' THEN $6 ELSE done_by END,
                updated_at = now()
          WHERE hospital_id = $1 AND id = $2
          RETURNING episode_id, station`,
        [this.hospitalId(), id, body.status, body.skipReason ?? null, body.sourceRef ?? null, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That station does not exist.');

      await tx.query(
        `UPDATE specialty.hc_bookings b
            SET status = 'in_progress', updated_at = now()
           FROM specialty.hc_episodes e
          WHERE e.id = $2 AND b.id = e.booking_id AND b.hospital_id = $1
            AND b.status = 'checked_in'`,
        [this.hospitalId(), asText(row['episode_id'])],
      );

      return this.detailWithin(tx, asText(row['episode_id']));
    });
  }

  async episodeDetail(id: string): Promise<HcEpisodeDetail> {
    return this.guard((tx) => this.detailWithin(tx, id));
  }

  async listEpisodes(query: HcQuery): Promise<readonly HcEpisodeRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.selectEpisode()}
          WHERE e.hospital_id = $1
            AND ($2::uuid IS NULL OR e.patient_id = $2::uuid)
            AND ($3::boolean IS NOT TRUE OR e.completed_at IS NULL)
          ORDER BY e.checked_in_at DESC
          LIMIT $4`,
        [this.hospitalId(), query.patientId ?? null, query.inProgressOnly, query.limit],
      );
      const out: HcEpisodeRow[] = [];
      for (const r of rows) out.push(await this.toEpisode(tx, r));
      return out;
    });
  }

  async draftReport(episodeId: string, body: HcReportRequest): Promise<HcReportRow> {
    return this.guard(async (tx) => {
      await this.requireParent(tx, 'specialty.hc_episodes', episodeId, 'That health-check episode');
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.hc_reports
           (id, hospital_id, episode_id, patient_id, version, domain_scores, risk_calcs,
            comparison, summary, recommendations, referrals, status, created_at, updated_at)
         VALUES ($1,$2,$3,
                 (SELECT patient_id FROM specialty.hc_episodes WHERE id = $3),
                 coalesce((SELECT max(version) FROM specialty.hc_reports WHERE episode_id = $3), 0) + 1,
                 $4::jsonb,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,'draft', now(), now())
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          episodeId,
          JSON.stringify(body.domainScores),
          JSON.stringify(body.riskCalcs),
          JSON.stringify(body.comparison),
          body.summary ?? null,
          JSON.stringify(body.recommendations),
          JSON.stringify(body.referrals),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The report was not saved.');
      return this.toReport(row);
    });
  }

  /**
   * Sign it.
   *
   * The database refuses this while any station is outstanding, and names them.
   * The list screen carries the same list, so the refusal is never a surprise —
   * but it is the refusal that makes it true.
   */
  async signReport(id: string): Promise<HcReportRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.hc_reports
            SET status = 'final', signed_by = $3, signed_at = now(), updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND status = 'draft'
          RETURNING *`,
        [this.hospitalId(), id, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That report does not exist, or it is not a draft.');
      }

      const episodeId = asText(row['episode_id']);
      await tx.query(
        `UPDATE specialty.hc_episodes SET completed_at = coalesce(completed_at, now()),
                physician_id = coalesce(physician_id, $3), updated_at = now()
          WHERE hospital_id = $1 AND id = $2`,
        [this.hospitalId(), episodeId, this.actorId()],
      );
      await tx.query(
        `UPDATE specialty.hc_bookings b SET status = 'report_ready', updated_at = now()
           FROM specialty.hc_episodes e
          WHERE e.id = $2 AND b.id = e.booking_id AND b.hospital_id = $1`,
        [this.hospitalId(), episodeId],
      );

      const { rows: corp } = await tx.query<Record<string, unknown>>(
        `SELECT b.corporate_id FROM specialty.hc_episodes e
           JOIN specialty.hc_bookings b ON b.id = e.booking_id
          WHERE e.id = $1`,
        [episodeId],
      );

      // The domains that came back outside the band. A corporate client sees
      // only the aggregate of these — never an individual's result.
      const scores = asJson(row['domain_scores']);
      const abnormal = Object.entries(scores)
        .filter(([, value]) => typeof value === 'number' && value < 50)
        .map(([domain]) => domain);

      await this.outbox.publish(
        tx,
        consoleEvent('healthcheck.report.ready', id, {
          reportId: id,
          episodeId,
          patientId: asText(row['patient_id']),
          healthScore: asTextOrNull(row['health_score']),
          corporateId: asTextOrNull(corp[0]?.['corporate_id']),
          abnormalDomains: abnormal,
        }),
      );

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'hc_report',
        rowId: id,
        businessKey: episodeId,
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        encounterId: null,
        before: null,
        after: { healthScore: asNumberOrNull(row['health_score']) },
      });

      return this.toReport(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shaping
  // ═══════════════════════════════════════════════════════════════════════════

  private selectEpisode(): string {
    return `SELECT e.*,
              (SELECT count(*) FROM specialty.hc_station_tasks t
                WHERE t.episode_id = e.id) AS stations_total,
              (SELECT count(*) FROM specialty.hc_station_tasks t
                WHERE t.episode_id = e.id
                  AND t.status IN ('done','skipped','not_applicable')) AS stations_resolved
              FROM specialty.hc_episodes e`;
  }

  private async detailWithin(tx: TransactionClient, episodeId: string): Promise<HcEpisodeDetail> {
    const [ep, tasks, reports] = await Promise.all([
      tx.query<Record<string, unknown>>(`${this.selectEpisode()} WHERE e.hospital_id = $1 AND e.id = $2`, [
        this.hospitalId(),
        episodeId,
      ]),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.hc_station_tasks WHERE episode_id = $1 ORDER BY seq`,
        [episodeId],
      ),
      tx.query<Record<string, unknown>>(
        `SELECT * FROM specialty.hc_reports WHERE episode_id = $1 ORDER BY version DESC`,
        [episodeId],
      ),
    ]);

    const row = ep.rows[0];
    if (row === undefined) throw AppError.notFound('That health check does not exist.');

    const stations = tasks.rows.map((t) => this.toStationBare(t));
    // `ready` and `blockedBy` are the trigger's rule, offered forwards: the
    // board shows what can be called next rather than a queue of refusals.
    const resolved = new Set(stations.filter((s) => RESOLVED.has(s.status)).map((s) => s.station));
    const withReadiness = stations.map((s) => {
      const blockedBy = s.dependsOn.filter((d) => !resolved.has(d));
      return { ...s, ready: blockedBy.length === 0, blockedBy };
    });

    return {
      episode: await this.toEpisode(tx, row, withReadiness),
      stations: withReadiness,
      reports: reports.rows.map((r) => this.toReport(r)),
    };
  }

  private async toEpisode(
    tx: TransactionClient,
    row: Record<string, unknown>,
    known?: readonly HcStationRow[],
  ): Promise<HcEpisodeRow> {
    let outstanding: readonly string[];
    if (known !== undefined) {
      outstanding = known.filter((s) => !RESOLVED.has(s.status)).map((s) => s.station);
    } else {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT station FROM specialty.hc_station_tasks
          WHERE episode_id = $1 AND status NOT IN ('done','skipped','not_applicable')
          ORDER BY seq`,
        [asText(row['id'])],
      );
      outstanding = rows.map((r) => asText(r['station']));
    }

    return {
      id: asText(row['id']),
      bookingId: asText(row['booking_id']),
      patientId: asText(row['patient_id']),
      routingSlipNo: asText(row['routing_slip_no']),
      checkedInAt: asText(row['checked_in_at']),
      completedAt: asTextOrNull(row['completed_at']),
      physicianId: asTextOrNull(row['physician_id']),
      stationsTotal: asNumber(row['stations_total'] ?? 0),
      stationsResolved: asNumber(row['stations_resolved'] ?? 0),
      reportBlockedBy: outstanding,
    };
  }

  private toStationBare(row: Record<string, unknown>): HcStationRow {
    return {
      id: asText(row['id']),
      station: asText(row['station']),
      seq: asNumber(row['seq']),
      dependsOn: asStringArray(row['depends_on']),
      status: asText(row['status']),
      calledAt: asTextOrNull(row['called_at']),
      startedAt: asTextOrNull(row['started_at']),
      doneAt: asTextOrNull(row['done_at']),
      skipReason: asTextOrNull(row['skip_reason']),
      waitMin: asNumberOrNull(row['wait_min']),
      ready: false,
      blockedBy: [],
    };
  }

  private toReport(row: Record<string, unknown>): HcReportRow {
    return {
      id: asText(row['id']),
      episodeId: asText(row['episode_id']),
      patientId: asText(row['patient_id']),
      version: asNumber(row['version']),
      domainScores: asJson(row['domain_scores']),
      healthScore: asNumberOrNull(row['health_score']),
      riskCalcs: asJson(row['risk_calcs']),
      summary: asTextOrNull(row['summary']),
      status: asText(row['status']),
      signedBy: asTextOrNull(row['signed_by']),
      signedAt: asTextOrNull(row['signed_at']),
    };
  }
}
