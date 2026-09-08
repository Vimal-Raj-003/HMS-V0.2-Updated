import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../core/db/database.service.js';

/**
 * PE-009 · What the public is allowed to see.
 *
 * The boundary is not drawn in this file. `mdm.mdm_specialities.website_visible`
 * and `mdm.mdm_practitioners.website_visible` were in the schema before this
 * feature existed, and `online_booking_enabled` beside them; a hospital decides
 * through master data which consultants appear on its website, and the assistant
 * simply obeys.
 *
 * That is worth being explicit about, because the alternative — a list of
 * public departments hard-coded here — would mean a consultant who leaves is
 * still on the website until an engineer deploys.
 *
 * Nothing in this file reads a patient table. The projections below are the
 * hospital's lobby board: names, qualifications, languages, timings.
 */

export interface PublicSpeciality {
  readonly key: string;
  readonly code: string;
  readonly name: string;
  readonly telemedicineAllowed: boolean;
}

export interface PublicPractitioner {
  readonly key: string;
  readonly displayName: string;
  readonly qualifications: readonly string[];
  readonly languages: readonly string[];
  readonly specialityKeys: readonly string[];
  readonly teleEnabled: boolean;
  readonly onlineBookingEnabled: boolean;
}

export interface PublicSlot {
  readonly slotId: string;
  readonly practitionerKey: string;
  readonly specialityKey: string | null;
  readonly slotStart: string;
  readonly slotEnd: string;
  readonly teleEnabled: boolean;
  /** Places left against the online quota, never the clinic's true capacity. */
  readonly openOnline: number;
}

export interface PublicDirectory {
  readonly hospitalName: string;
  readonly specialities: readonly PublicSpeciality[];
  readonly practitioners: readonly PublicPractitioner[];
}

@Injectable()
export class DirectoryService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async directory(hospitalId: string): Promise<PublicDirectory> {
    return this.db.withHospitalScope(hospitalId, async (tx) => {
      const hospital = await tx.query<{ name: string }>(
        `SELECT display_name AS name FROM core.hospitals WHERE id = $1`,
        [hospitalId],
      );

      const specialities = await tx.query<{
        record_key: string;
        code: string;
        name: string;
        telemedicine_allowed: boolean;
      }>(
        `SELECT record_key, code, name, telemedicine_allowed
           FROM mdm.mdm_specialities
          WHERE hospital_id = $1
            AND status = 'active'
            AND website_visible = true
            AND effective_from <= now()
            AND (effective_to IS NULL OR effective_to > now())
          ORDER BY sort_order, name
          LIMIT 200`,
        [hospitalId],
      );

      const practitioners = await tx.query<{
        record_key: string;
        display_name: string;
        qualifications: string[];
        languages: string[];
        speciality_keys: string[];
        tele_enabled: boolean;
        online_booking_enabled: boolean;
      }>(
        `SELECT record_key, display_name, qualifications, languages, speciality_keys,
                tele_enabled, online_booking_enabled
           FROM mdm.mdm_practitioners
          WHERE hospital_id = $1
            AND status = 'active'
            AND website_visible = true
            AND effective_from <= now()
            AND (effective_to IS NULL OR effective_to > now())
          ORDER BY display_name
          LIMIT 300`,
        [hospitalId],
      );

      return {
        hospitalName: hospital.rows[0]?.name ?? 'this hospital',
        specialities: specialities.rows.map((r) => ({
          key: r.record_key,
          code: r.code,
          name: r.name,
          telemedicineAllowed: r.telemedicine_allowed,
        })),
        practitioners: practitioners.rows.map((r) => ({
          key: r.record_key,
          displayName: r.display_name,
          qualifications: r.qualifications,
          languages: r.languages,
          specialityKeys: r.speciality_keys,
          teleEnabled: r.tele_enabled,
          onlineBookingEnabled: r.online_booking_enabled,
        })),
      };
    });
  }

  /**
   * Published slots with room left against the **online** quota.
   *
   * `online_quota` is not the clinic's capacity. A hospital sets aside a portion
   * of a session for web bookings and keeps the rest for the counter and for
   * walk-ins, and publishing true remaining capacity here would let the internet
   * consume a morning that reception was holding. `open_online` is therefore
   * derived from the quota alone, and is zero — not negative — when the quota is
   * spent.
   */
  async availability(
    hospitalId: string,
    options: {
      readonly specialityKey?: string | undefined;
      readonly practitionerKey?: string | undefined;
      readonly fromDate: string;
      readonly toDate: string;
    },
  ): Promise<readonly PublicSlot[]> {
    return this.db.withHospitalScope(hospitalId, async (tx) => {
      const result = await tx.query<{
        id: string;
        practitioner_key: string;
        speciality_key: string | null;
        slot_start: Date;
        slot_end: Date;
        tele_enabled: boolean;
        open_online: number;
      }>(
        `SELECT s.id, s.practitioner_key, s.speciality_key, s.slot_start, s.slot_end,
                s.tele_enabled,
                GREATEST(s.online_quota - s.online_booked_count, 0) AS open_online
           FROM clinical.schedule_slots s
           JOIN mdm.mdm_practitioners p
             ON p.record_key = s.practitioner_key
            AND p.status = 'active'
            AND p.website_visible = true
            AND p.online_booking_enabled = true
          WHERE s.hospital_id = $1
            AND s.status = 'open'
            AND s.slot_date BETWEEN $2::date AND $3::date
            AND s.slot_start > now()
            AND s.online_quota > s.online_booked_count
            AND ($4::uuid IS NULL OR s.speciality_key = $4::uuid)
            AND ($5::uuid IS NULL OR s.practitioner_key = $5::uuid)
          ORDER BY s.slot_start
          LIMIT 100`,
        [
          hospitalId,
          options.fromDate,
          options.toDate,
          options.specialityKey ?? null,
          options.practitionerKey ?? null,
        ],
      );

      return result.rows.map((r) => ({
        slotId: r.id,
        practitionerKey: r.practitioner_key,
        specialityKey: r.speciality_key,
        slotStart: r.slot_start.toISOString(),
        slotEnd: r.slot_end.toISOString(),
        teleEnabled: r.tele_enabled,
        openOnline: Number(r.open_online),
      }));
    });
  }
}
