'use client';

import { useQuery } from '@tanstack/react-query';
import {
  PatientBanner,
  type AllergyStatement,
  type PatientBannerLabels,
  type PatientIdentity,
} from '@vims/ui';
import type { ReactNode } from 'react';
import { getPatient } from '@/features/patient/api/client';
import { toPatientIdentity } from '@/features/patient/lib/banner';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { clinicalKeys } from '../api/keys';
import { toAllergyStatement } from '../lib/allergy';
import type { AllergyItem } from '../api/types';

/**
 * The patient banner for every clinical screen — `docs/06` §4.2, "the most
 * safety-critical component".
 *
 * It reuses OP-001's `getPatient` and `toPatientIdentity` rather than a second
 * projection, so the identity a doctor sees on the consultation screen is
 * character-for-character the one they saw at the desk. Two projections of one
 * patient is how an age reads `45 y` on one screen and `44 y` on another and a
 * paediatric dose is calculated from the wrong one.
 *
 * The **allergy strip is the reason this component is not optional**. The banner
 * type makes the empty state unrepresentable — `AllergyStatus` is a
 * discriminated union with four arms — and this component supplies the arm from
 * the clinical allergy list, degrading to `unable-to-assess` when it cannot. It
 * never degrades to blank, and it never degrades to "none known".
 *
 * When the patient record itself will not load, the banner is **not** rendered
 * with a placeholder identity: an identity band showing a name nobody verified
 * is worse than a refusal. The refusal carries its reference, as `docs/06` §1.1
 * requires.
 */

export const BANNER_LABELS: PatientBannerLabels = {
  region: 'Patient identity and safety flags',
  allergyPrefix: 'Allergy',
  allergiesNotRecorded: 'Allergies not recorded — nobody has asked yet',
  allergiesUnableToAssess: (reason) => `Allergies could not be established — ${reason}`,
  noKnownAllergies: (verifiedOn) => `No known allergies (stated ${verifiedOn})`,
  moreAllergies: (count) => `+${String(count)} more`,
  isolationPrefix: 'Isolation',
  mlcPrefix: 'MLC',
  bloodGroupPrefix: 'Blood group',
  weightPrefix: 'Weight',
  weightMissing: 'Weight not recorded',
  uhidPrefix: 'UHID',
  episodePrefix: 'Episode',
  lengthOfStayPrefix: 'Length of stay',
  payerPrefix: 'Payer',
  breakGlass: 'Break glass to open this record',
  maskedNotice: 'This record is masked because you are not on the care team.',
  sex: { male: 'Male', female: 'Female', other: 'Other', unknown: 'Sex not stated' },
};

export interface PatientContext {
  readonly identity: PatientIdentity;
  readonly allergies: AllergyStatement;
  /** Whole days, for the age-banded reference ranges. `null` when the DOB is unknown. */
  readonly dob: string | null;
  readonly sex: string;
  readonly pregnancy: string;
}

export function usePatientContext(patientId: string, enabled: boolean) {
  const { hospitalId } = useSession();
  const keys = clinicalKeys(hospitalId);

  const patientQuery = useQuery({
    queryKey: keys.patientRecord(patientId),
    queryFn: ({ signal }) => getPatient(patientId, { signal }),
    enabled: enabled && patientId !== '',
  });

  return patientQuery;
}

export function ClinicalPatientHeader({
  patientId,
  allergies,
  allergiesFailed,
  children,
}: {
  readonly patientId: string;
  /** `null` while the allergy list is loading or unavailable — never treated as "none". */
  readonly allergies: readonly AllergyItem[] | null;
  readonly allergiesFailed: boolean;
  readonly children?: ReactNode;
}): React.JSX.Element | null {
  const patientQuery = usePatientContext(patientId, true);

  if (patientQuery.isError) {
    return <ProblemCard error={patientQuery.error} onRetry={() => void patientQuery.refetch()} />;
  }
  if (patientQuery.data === undefined) return null;

  const patient = patientQuery.data;
  const identity = toPatientIdentity(patient);
  const statement = toAllergyStatement({
    items: allergies,
    statement: patient.allergy_statement,
    assertedBy: patient.allergy_asserted_by,
    assertedOn: patient.allergy_asserted_at,
    unableReason: patient.allergy_unable_reason,
    failed: allergiesFailed,
  });

  // The banner's own allergy arm comes from the patient record's summary; the
  // clinical list is richer and, where it exists, is the one to show. Both are
  // total over the four states, so neither can produce a blank.
  const bannerPatient: PatientIdentity = {
    ...identity,
    allergies:
      statement.kind === 'known'
        ? {
            kind: 'known',
            allergies: statement.entries.map((entry) => ({
              substance: entry.allergen.display,
              reaction:
                entry.reactions.kind === 'documented'
                  ? entry.reactions.reactions.join(', ')
                  : 'Reaction not documented',
              severity: entry.severity === 'unknown' ? 'severe' : entry.severity,
            })),
          }
        : statement.kind === 'none-known'
          ? { kind: 'none-known', verifiedOn: statement.assertedOn }
          : statement.kind === 'unable-to-assess'
            ? { kind: 'unable-to-assess', reason: statement.reason }
            : { kind: 'not-recorded' },
  };

  return (
    <PatientBanner patient={bannerPatient} labels={BANNER_LABELS}>
      {children}
    </PatientBanner>
  );
}
