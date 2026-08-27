'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, PatientBanner, type PatientBannerLabels } from '@vims/ui';
import { getPatient } from '@/features/patient/api/client';
import { patientKeys } from '@/features/patient/api/keys';
import { toPatientIdentity } from '@/features/patient/lib/banner';
import { SkeletonList } from '@vims/ui';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';

/**
 * The patient banner at the counter (`docs/06` §4.2, OP-003 §8).
 *
 * OP-003 §3.2 step 1 makes this the first thing on the dispensing screen: "banner
 * shows patient identity (name, UHID, age/sex, photo), allergies". The banner is
 * assembled server-side and rendered whole — `features/patient/lib/banner.ts`
 * does the projection and is reused rather than re-implemented, because a second
 * projection is a second chance to render "no allergies" for a patient whose
 * allergies were never asked about.
 *
 * When the session cannot read the patient record, the counter does **not**
 * fall back to a blank banner: it says so, and shows the opaque reference the
 * queue already carries. A pharmacist who cannot see allergies needs to know
 * that they cannot, because the alternative is reading an empty allergy strip as
 * "none".
 */
const BANNER_LABELS: PatientBannerLabels = {
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

/** Last six characters of an opaque id — enough to match against a slip, not PHI. */
export function patientRef(patientId: string | null): string {
  if (patientId === null || patientId === '') return 'unassigned';
  return `·${patientId.slice(-6)}`;
}

export function PatientIdentityPanel({ patientId }: { readonly patientId: string }): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = patientKeys(hospitalId);
  const canRead = granted.has('patient.record.read');

  const patient = useQuery({
    queryKey: keys.detail(patientId),
    queryFn: ({ signal }) => getPatient(patientId, { signal }),
    enabled: canRead,
  });

  if (!canRead) {
    return (
      <div
        role="status"
        data-testid="identity-unavailable"
        className="rounded-lg border border-warning-border bg-warning-surface p-3 text-sm text-warning-on-surface"
      >
        <p className="font-medium">
          You cannot see this patient&rsquo;s record, so you cannot see allergies.
        </p>
        <p className="mt-1">
          The counter still checks for allergies and interactions and will refuse to complete over one — but
          you will not be able to read the alert. Ask for{' '}
          <span className="font-mono">patient.record.read</span> before working this counter. Reference{' '}
          {patientRef(patientId)}.
        </p>
      </div>
    );
  }

  if (patient.error !== null) {
    return <ProblemCard error={patient.error} onRetry={() => void patient.refetch()} />;
  }
  if (patient.isPending || patient.data === undefined) {
    return <SkeletonList label="Loading the patient banner" rows={2} />;
  }

  return (
    <div className="flex flex-col gap-2" data-testid="counter-patient-banner">
      <PatientBanner patient={toPatientIdentity(patient.data)} labels={BANNER_LABELS}>
        <Badge tone="neutral">Reference {patientRef(patientId)}</Badge>
      </PatientBanner>
    </div>
  );
}
