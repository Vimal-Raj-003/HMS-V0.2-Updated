import type { PatientAlert, PatientAlertKind, PatientIdentity } from '@vims/ui';
import type { PatientAlertRow, PatientBannerData, PatientDetail } from '../api/types';
import { toBannerAllergyStatus } from './allergy';
import { formatAge, formatBloodGroup, splitName, toSex } from './format';

/**
 * The projection from `PatientDetail` to the design system's `PatientIdentity`.
 *
 * `docs/06` §4.2 calls the patient banner "the most safety-critical component",
 * and everything in this file is here so that the banner cannot render a
 * half-truth:
 *
 *  - the allergy status is the four-arm one from `allergy.ts`, never a boolean;
 *  - `isolation` and `mlc` are pulled out of the alert list into their own fields,
 *    because §4.2 gives them their own places in the flag row and an isolation
 *    warning rendered as a generic chip is one a nurse can miss;
 *  - `allergy`-typed alerts are dropped, because `patient.alerts` only *mirrors*
 *    them for banner speed (OP-001 §4) and rendering both would show one allergy
 *    twice — which reads as two.
 */

const ALERT_KINDS: Readonly<Record<string, PatientAlertKind>> = {
  vip: 'vip',
  fall_risk: 'fall-risk',
  infection: 'infection',
};

/** Alerts that own a dedicated slot in the banner rather than the generic row. */
const OWN_SLOT = new Set(['isolation', 'mlc', 'allergy']);

export function bannerAlerts(rows: readonly PatientAlertRow[]): readonly PatientAlert[] {
  return rows
    .filter((row) => !OWN_SLOT.has(row.type))
    .map((row) => ({
      kind: ALERT_KINDS[row.type] ?? 'other',
      // The label is what the hospital typed, not the enum. `credit_block` on a
      // banner means nothing to the person reading it; "Credit blocked — accounts"
      // means something.
      label: row.detail === null ? row.label : `${row.label} — ${row.detail}`,
    }));
}

function firstOfType(rows: readonly PatientAlertRow[], type: string): PatientAlertRow | undefined {
  return rows.find((row) => row.type === type);
}

export function toPatientIdentity(
  patient: PatientDetail,
  banner: PatientBannerData = patient.banner,
  now?: Date,
): PatientIdentity {
  const { familyName, givenName } = splitName(banner.full_name);
  const isolation = firstOfType(banner.alerts, 'isolation');
  const mlc = firstOfType(banner.alerts, 'mlc');

  return {
    uhid: banner.uhid,
    familyName,
    givenName,
    // The server pre-formats `age_display`; `formatAge` is the fallback for the
    // one case it cannot cover — a record whose age basis was never established.
    age: banner.age_display === '' ? formatAge(patient, now) : banner.age_display,
    sex: toSex(banner.gender),
    allergies: toBannerAllergyStatus(banner),
    alerts: bannerAlerts(banner.alerts),
    ...(banner.blood_group === 'unknown' ? {} : { bloodGroup: formatBloodGroup(banner.blood_group) }),
    ...(patient.payer_type === 'self' ? {} : { payer: patient.payer_type }),
    ...(isolation === undefined ? {} : { isolation: { type: isolation.detail ?? isolation.label } }),
    ...(mlc === undefined ? {} : { mlc: { number: mlc.detail ?? mlc.label } }),
  };
}
