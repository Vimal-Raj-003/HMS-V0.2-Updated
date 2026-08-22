'use client';

import {
  PatientSearchCombobox,
  type PatientSearchLabels,
  type PatientSearchMode,
  type PatientSearchResult,
} from '@vims/ui';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/session-context';
import { listRecentPatients, searchPatients, type PatientSearchCriteria } from '../api/client';
import { patientKeys } from '../api/keys';
import type { PatientListItem } from '../api/types';
import { formatAge, formatDate, mobileLast4, toSex } from '../lib/format';

/**
 * The MPI search, wired to `GET /patients`.
 *
 * `PatientSearchCombobox` owns the behaviour — debounce, stale-response
 * discarding, keyboard-wedge scanning, "never auto-select on blur" — and this
 * component owns only the two things it cannot: which query parameter the typed
 * text becomes, and how a row is projected for display.
 *
 * **The projection is the privacy control.** `PatientSearchResult` has no field
 * that can hold a full phone number, so a result list visible from the other side
 * of a counter cannot leak one; `mobileLast4` is what makes two patients called
 * Ramesh Kumar separable without doing that.
 */

/**
 * `detectSearchMode` classifies what was typed; the server routes each parameter
 * to a different index, and sending two would use neither. This is the mapping
 * between the two, and it is the only place it exists.
 */
export function criteriaFor(query: string, mode: PatientSearchMode): PatientSearchCriteria {
  switch (mode) {
    case 'mobile':
      return { mobile: query };
    case 'uhid':
      // A UHID search must find a merged record too: OP-001 §3.8 keeps the losing
      // UHID resolving as an alias, so a card printed before a merge still works
      // at the desk. The server already widens the identifier paths; asking for
      // inactive records explicitly makes that intent legible here.
      return { uhid: query, includeInactive: true };
    case 'abha':
      return { abha: query, includeInactive: true };
    case 'identifier':
      return { identifier: query, includeInactive: true };
    case 'name':
      return { q: query };
  }
}

export function toSearchResult(row: PatientListItem, now?: Date): PatientSearchResult {
  const last4 = mobileLast4(row.mobile);
  return {
    patientId: row.id,
    uhid: row.uhid,
    displayName: row.full_name,
    age: formatAge(row, now),
    sex: toSex(row.gender),
    // Front office and call centre hold no `careTeamOnly` ABAC condition
    // (`role-templates.ts`), and a patient at a registration counter has no care
    // team yet. Break-glass belongs on the clinical screens that do carry the
    // condition; asking for it here would train staff to break glass all day.
    careTeamMember: true,
    ...(last4 === undefined ? {} : { mobileLast4: last4 }),
    ...(row.last_visit_at === null ? {} : { lastVisitOn: formatDate(row.last_visit_at) }),
    ...(row.merged_into_id === null ? {} : { probableDuplicate: true }),
  };
}

export const PATIENT_SEARCH_LABELS: PatientSearchLabels = {
  fieldLabel: 'Find a patient',
  placeholder: 'Mobile, UHID, name, ABHA or scan the card',
  listLabel: 'Matching patients',
  recentHeading: 'Registered recently',
  resultsHeading: 'Matches',
  minCharsHint: (minChars) => `Type at least ${String(minChars)} characters, or scan a card.`,
  searching: 'Searching the patient index…',
  noResults: (query) => `Nobody in this hospital matches “${query}”.`,
  noResultsAction: 'Check the spelling, try the mobile number, or press F2 to register a new patient.',
  error: 'The patient index did not answer. Try again, or register from the mobile number.',
  scanning: 'Reading the card…',
  scanUnresolved: (payload) => `That card (${payload}) does not match any patient here.`,
  uhidPrefix: 'UHID',
  mobilePrefix: 'Mobile ending',
  lastVisitPrefix: 'Last visit',
  duplicate: 'Merged record — opens the surviving one',
  deceased: 'Deceased',
  breakGlassRequired: 'Opening this record needs a reason',
  resultSummary: (result) =>
    `${result.displayName}, ${result.age}, UHID ${result.uhid}${
      result.lastVisitOn === undefined ? '' : `, last visit ${result.lastVisitOn}`
    }`,
  modeHint: {
    mobile: 'Searching by mobile number',
    uhid: 'Searching by UHID',
    abha: 'Searching by ABHA',
    identifier: 'Searching by ID number',
    name: 'Searching by name',
  },
};

export function PatientLookup({
  onSelect,
  autoFocus = false,
  showRecent = true,
  labels,
  className,
}: {
  readonly onSelect: (result: PatientSearchResult) => void;
  readonly autoFocus?: boolean;
  readonly showRecent?: boolean;
  readonly labels?: Partial<PatientSearchLabels>;
  readonly className?: string;
}): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = patientKeys(hospitalId);

  const recent = useQuery({
    queryKey: keys.recent(),
    queryFn: ({ signal }) => listRecentPatients({ signal }),
    enabled: showRecent,
    // The recent list is a convenience, not a record. Refetching it on every
    // focus would cost a PHI-audited query per keystroke-adjacent event.
    staleTime: 60_000,
  });

  return (
    <PatientSearchCombobox
      labels={{ ...PATIENT_SEARCH_LABELS, ...labels }}
      autoFocus={autoFocus}
      className={className ?? ''}
      recent={(recent.data?.items ?? []).map((row) => toSearchResult(row))}
      onSearch={async (query, mode) => {
        const page = await searchPatients(criteriaFor(query.trim(), mode));
        return page.items.map((row) => toSearchResult(row));
      }}
      onSelect={onSelect}
      // Unreachable while `careTeamMember` is true for every row, and stated
      // rather than left to a cast: the day a clinical screen reuses this
      // component with a care-team rule, the callback is already here.
      onBreakGlassRequired={onSelect}
    />
  );
}
