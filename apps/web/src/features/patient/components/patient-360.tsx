'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AllergyEditor,
  Badge,
  Button,
  EmptyState,
  Kbd,
  PatientBanner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
  type PatientBannerLabels,
} from '@vims/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FileSearch, Info, ReceiptText, TriangleAlert, Users } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { getPatient, getPatientHistory, listPatientVisits, updatePatient } from '../api/client';
import { patientKeys } from '../api/keys';
import type { PatientDetail } from '../api/types';
import type { AmendChanges } from '../lib/amend';
import { toAllergyStatement } from '../lib/allergy';
import { toPatientIdentity } from '../lib/banner';
import { formatBloodGroup, formatDate, formatTimestamp, humaniseFieldName, renderValue } from '../lib/format';
import { ALLERGY_LABELS, UNABLE_TO_ASSESS_REASONS } from '../lib/reference';
import { AmendDialog } from './amend-dialog';

/**
 * Patient 360 (OP-001 §8 "Patient 360 mini-view").
 *
 * The banner is the point of the screen and everything else is arranged around
 * it. Three rules from `docs/06` §4.2 are load-bearing here:
 *
 *  - **the banner is assembled server-side and rendered whole.** `GET
 *    /patients/{id}` returns it with the record, so there is no frame in which
 *    the name is on screen and the allergy strip is not. That is why this screen
 *    renders *nothing* until the record resolves rather than streaming the header
 *    early — a prescriber reading "no allergies" off a loading state is the
 *    failure the whole four-arm model exists to prevent;
 *  - **an empty allergy area is never allowed.** The four arms come through
 *    `toBannerAllergyStatus`, and `not_recorded` renders the amber "Allergies not
 *    recorded" chip, never silence and never "none";
 *  - **the record's own history is part of the record.** The demographic history
 *    tab is not an admin feature — it is how anyone reading the chart finds out
 *    that the date of birth changed last Tuesday, and why.
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

export function Patient360({ patientId }: { readonly patientId: string }): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { publish } = useToast();
  const { hospitalId, granted } = useSession();
  const keys = patientKeys(hospitalId);

  const canAmend = granted.has('patient.record.update');
  const canSeeVisits = granted.has('visit.list');

  const [amendOpen, setAmendOpen] = useState(false);

  const record = useQuery({
    queryKey: keys.detail(patientId),
    queryFn: ({ signal }) => getPatient(patientId, { signal }),
  });

  const amend = useMutation({
    mutationFn: (input: { readonly changes: AmendChanges; readonly reason: string }) => {
      const patient = record.data;
      if (patient === undefined) throw new Error('The record is not loaded.');
      // `version` is the optimistic lock. Sending the version this screen was
      // showing is what makes a concurrent edit at another counter a visible 409
      // rather than a silent overwrite of somebody else's correction.
      return updatePatient(patientId, {
        version: patient.version,
        reason: input.reason,
        channel: 'desk',
        ...input.changes,
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.detail(patientId), updated);
      void queryClient.invalidateQueries({ queryKey: keys.history(patientId) });
      void queryClient.invalidateQueries({ queryKey: [...keys.root, 'search'] });
      setAmendOpen(false);
      publish({
        title: 'Amendment saved',
        description: 'The previous values are in the history tab.',
        severity: 'success',
      });
    },
  });

  const openAmend = useCallback((): void => {
    if (canAmend) setAmendOpen(true);
  }, [canAmend]);

  // OP-001 §8: `F5` is "Edit". See `registration-desk.tsx` for why a browser key
  // is bound at all.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'F5' && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        openAmend();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, [openAmend]);

  const patient = record.data;

  return (
    <div className="flex flex-col gap-4" data-testid="patient-360">
      <AsyncPanel
        loading={record.isPending}
        error={record.error}
        isEmpty={false}
        empty={null}
        onRetry={() => void record.refetch()}
        skeletonLabel="Opening the patient record"
        skeletonRows={6}
      >
        {patient === undefined ? null : (
          <>
            <PatientBanner patient={toPatientIdentity(patient)} labels={BANNER_LABELS}>
              <div className="flex flex-wrap items-center gap-2">
                {canAmend ? (
                  <Button variant="secondary" size="sm" data-testid="amend-open" onClick={openAmend}>
                    Amend
                    <Kbd>F5</Kbd>
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    router.push('/patients');
                  }}
                >
                  Back to the desk
                </Button>
              </div>
            </PatientBanner>

            {patient.merged_into_id === null ? null : (
              <div
                role="status"
                data-testid="merged-notice"
                className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-surface p-3 text-sm text-warning-on-surface"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  This record was merged into another on {formatTimestamp(patient.merged_at)}. It is kept so
                  the old UHID card still resolves, and nothing new should be recorded against it.{' '}
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="open-survivor"
                    onClick={() => {
                      router.push(`/patients/${patient.merged_into_id ?? ''}`);
                    }}
                  >
                    Open the surviving record
                  </Button>
                </span>
              </div>
            )}

            {!patient.is_deceased ? null : (
              <div
                role="status"
                data-testid="deceased-notice"
                className="rounded-lg border border-strong bg-layer-3 p-3 text-sm text-fg-default"
              >
                This patient is recorded as deceased
                {patient.deceased_at === null ? '' : ` on ${formatDate(patient.deceased_at)}`}. Appointments
                and messages must not be raised against this record.
              </div>
            )}

            {patient.created_override_reason === null ? null : (
              <div
                role="status"
                data-testid="override-notice"
                className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-surface p-3 text-sm text-warning-on-surface"
              >
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  This record was created past a suspected-duplicate stop. The reason given was:{' '}
                  <q>{patient.created_override_reason}</q>
                </span>
              </div>
            )}

            {amend.isError ? <ProblemCard error={amend.error} /> : null}

            <Tabs defaultValue="demographics">
              <TabsList aria-label="Patient record sections">
                <TabsTrigger value="demographics">Demographics</TabsTrigger>
                <TabsTrigger value="identity">Identifiers &amp; contacts</TabsTrigger>
                <TabsTrigger value="visits">Visits</TabsTrigger>
                <TabsTrigger value="history">What changed</TabsTrigger>
              </TabsList>

              <TabsContent value="demographics">
                <DemographicsTab patient={patient} />
              </TabsContent>

              <TabsContent value="identity">
                <IdentityTab patient={patient} />
              </TabsContent>

              <TabsContent value="visits">
                {canSeeVisits ? (
                  <VisitsTab patientId={patientId} />
                ) : (
                  <EmptyState
                    icon={<ReceiptText />}
                    cause="Your roles do not include visit.list, so the visit history is not shown."
                    nextAction="Everything else on this record is still readable. Ask your administrator if you need the visit list."
                  />
                )}
              </TabsContent>

              <TabsContent value="history">
                <HistoryTab patientId={patientId} />
              </TabsContent>
            </Tabs>

            {canAmend ? (
              <AmendDialog
                // Remounting on every version change discards a half-typed draft
                // when the record moves underneath it, which is correct: the draft
                // was computed against values that no longer exist.
                key={`${patient.id}-${String(patient.version)}`}
                patient={patient}
                open={amendOpen}
                onOpenChange={setAmendOpen}
                saving={amend.isPending}
                onSubmit={(changes, reason) => {
                  amend.mutate({ changes, reason });
                }}
              />
            ) : null}
          </>
        )}
      </AsyncPanel>
    </div>
  );
}

// ── tabs ─────────────────────────────────────────────────────────────────────

function DemographicsTab({ patient }: { readonly patient: PatientDetail }): React.JSX.Element {
  const address = [
    patient.address_line1,
    patient.address_line2,
    patient.city,
    patient.district,
    patient.state,
    patient.pincode,
  ]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(', ');

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-labelledby="allergy-statement-heading"
        className="rounded-lg border border-default bg-layer-1 p-3"
      >
        <h3 id="allergy-statement-heading" className="sr-only">
          Allergy statement
        </h3>
        {/*
          Read-only here on purpose. Changing the statement is a clinical
          assertion under `patient.alert.manage`, and `PATCH /patients` refuses
          allergy fields outright — so the editor is rendered with an `onChange`
          that cannot fire from a control this screen shows, and the four arms
          are displayed exactly as the editor displays them everywhere else.
        */}
        <AllergyEditor
          statement={toAllergyStatement({
            allergy_statement: patient.allergy_statement,
            allergy_asserted_by: patient.allergy_asserted_by,
            allergy_asserted_at: patient.allergy_asserted_at,
            allergy_unable_reason: patient.allergy_unable_reason,
            allergies: patient.banner.allergies,
          })}
          labels={ALLERGY_LABELS}
          asserter={{
            name: patient.allergy_asserted_by ?? 'Not recorded',
            on: formatDate(patient.allergy_asserted_at),
          }}
          unableToAssessReasons={UNABLE_TO_ASSESS_REASONS}
          newEntryId={() => 'read-only'}
          onChange={() => {
            /* Recording an allergy is EN-029 and `patient.alert.manage`, not this screen. */
          }}
        />
      </section>

      <dl className="grid gap-x-6 gap-y-2 rounded-lg border border-default bg-layer-1 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="UHID" value={patient.uhid} mono />
        <Fact label="Full name" value={patient.full_name} />
        <Fact label="Sex" value={patient.gender} />
        <Fact
          label="Date of birth"
          value={
            patient.dob === null
              ? null
              : `${formatDate(patient.dob)}${patient.dob_is_estimated ? ' (estimated from an age)' : ''}`
          }
        />
        <Fact label="Blood group" value={formatBloodGroup(patient.blood_group)} />
        <Fact label="Marital status" value={patient.marital_status} />
        <Fact label="Mobile" value={patient.mobile} mono />
        <Fact
          label="Mobile verified"
          value={
            patient.mobile_verified_at === null ? 'Not verified' : formatTimestamp(patient.mobile_verified_at)
          }
        />
        <Fact label="Alternate phone" value={patient.alt_phone} mono />
        <Fact label="Email" value={patient.email} />
        <Fact label="WhatsApp" value={patient.whatsapp_opt_in ? 'Opted in' : 'Not opted in'} />
        <Fact label="Preferred language" value={patient.preferred_language} />
        <Fact label="Address" value={address === '' ? null : address} />
        <Fact label="Category" value={patient.category} />
        <Fact label="Who pays" value={patient.payer_type} />
        <Fact label="Payer reference" value={patient.payer_ref} />
        <Fact label="Referral source" value={patient.referral_source_code} />
        <Fact label="Registered" value={formatTimestamp(patient.registered_at)} />
        <Fact label="Registered through" value={patient.source_channel} />
        <Fact label="Record version" value={String(patient.version)} mono />
      </dl>

      <div className="flex flex-wrap gap-2">
        {patient.is_vip ? <Badge tone="violet">VIP</Badge> : null}
        {patient.is_staff ? <Badge tone="info">Staff</Badge> : null}
        {patient.is_differently_abled ? <Badge tone="info">Differently abled</Badge> : null}
        {patient.is_pregnant ? <Badge tone="info">Pregnant</Badge> : null}
        {patient.is_deceased ? <Badge tone="neutral">Deceased</Badge> : null}
      </div>
    </div>
  );
}

function IdentityTab({ patient }: { readonly patient: PatientDetail }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="identifiers-heading" className="rounded-lg border border-default bg-layer-1">
        <h3 id="identifiers-heading" className="border-b border-default p-3 text-md font-medium">
          Identifiers
        </h3>
        {patient.identifiers.length === 0 ? (
          <EmptyState
            className="m-3"
            cause="No identifier beyond the UHID is recorded for this patient."
            nextAction="Add an ABHA, passport or scheme number when the patient presents one."
          />
        ) : (
          <Table scrollRegionLabel="Identifiers">
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Issued by</TableHead>
                <TableHead>Verified</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {patient.identifiers.map((identifier) => (
                <TableRow key={identifier.id}>
                  <TableCell>{humaniseFieldName(identifier.type)}</TableCell>
                  {/* The API returns these already masked. There is no unmasked form. */}
                  <TableCell className="font-mono text-xs">{identifier.value_masked}</TableCell>
                  <TableCell>{identifier.issued_by ?? '—'}</TableCell>
                  <TableCell>{formatTimestamp(identifier.verified_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <dl className="grid gap-x-6 gap-y-2 border-t border-default p-3 text-sm sm:grid-cols-2">
          <Fact label="ABHA number" value={patient.abha_number} mono />
          <Fact label="ABHA address" value={patient.abha_address} mono />
          <Fact label="Photo ID type" value={patient.id_type_code} />
          <Fact label="Photo ID last four" value={patient.id_last4} mono />
          {/*
            The only two forms of Aadhaar that exist anywhere in this system, and
            both are read-only provenance from EN-011's licensed e-KYC. Nothing in
            this feature can write either, and no screen offers an Aadhaar input.
          */}
          <Fact
            label="Aadhaar e-KYC"
            value={
              patient.aadhaar_kyc_verified_at === null
                ? 'Not verified'
                : `Verified ${formatTimestamp(patient.aadhaar_kyc_verified_at)}`
            }
          />
          <Fact label="Aadhaar last four" value={patient.aadhaar_last4} mono />
        </dl>
      </section>

      <section aria-labelledby="contacts-heading" className="rounded-lg border border-default bg-layer-1">
        <h3 id="contacts-heading" className="border-b border-default p-3 text-md font-medium">
          Contacts and relationships
        </h3>
        {patient.contacts.length === 0 ? (
          <EmptyState
            className="m-3"
            icon={<Users />}
            cause="Nobody is recorded as the person to contact about this patient."
            nextAction="Add an emergency contact — a patient with no reachable relative is one nobody can be told about."
          />
        ) : (
          <Table scrollRegionLabel="Contacts">
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Relationship</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Guardian</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {patient.contacts.map((contact) => (
                <TableRow key={contact.id}>
                  <TableCell>{humaniseFieldName(contact.kind)}</TableCell>
                  <TableCell className="font-medium">{contact.name}</TableCell>
                  <TableCell>{contact.relationship_code ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{contact.phone}</TableCell>
                  <TableCell>{contact.is_guardian ? 'Yes' : 'No'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="border-t border-default p-3 text-xs text-fg-muted">
          Family links between two registered patients (`patient.relationships`) have no read route in this
          phase&rsquo;s API, so only the contacts recorded on this record are shown.
        </p>
      </section>
    </div>
  );
}

function VisitsTab({ patientId }: { readonly patientId: string }): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = patientKeys(hospitalId);

  const visits = useQuery({
    queryKey: keys.visits(patientId),
    queryFn: ({ signal }) => listPatientVisits(patientId, { signal }),
  });

  const rows = visits.data?.items ?? [];

  return (
    <AsyncPanel
      loading={visits.isPending}
      error={visits.error}
      isEmpty={rows.length === 0}
      onRetry={() => void visits.refetch()}
      skeletonLabel="Loading the visit history"
      skeletonRows={5}
      empty={
        <EmptyState
          icon={<ReceiptText />}
          cause="This patient has never been checked in here."
          nextAction="Register the visit from the queue console when they arrive."
        />
      }
    >
      <div className="rounded-lg border border-default bg-layer-1">
        <Table scrollRegionLabel="Visits">
          <TableHeader>
            <TableRow>
              <TableHead>Visit</TableHead>
              <TableHead>Checked in</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Token</TableHead>
              <TableHead>Payer</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((visit) => (
              <TableRow key={visit.id} data-testid="visit-row">
                <TableCell className="font-mono text-xs">{visit.visit_no}</TableCell>
                <TableCell className="whitespace-nowrap font-mono text-xs">
                  {formatTimestamp(visit.checked_in_at)}
                </TableCell>
                <TableCell>{humaniseFieldName(visit.visit_type)}</TableCell>
                <TableCell>
                  <Badge tone={visit.cancelled_at === null ? 'neutral' : 'warning'} size="sm">
                    {humaniseFieldName(visit.status)}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{visit.token_display ?? '—'}</TableCell>
                <TableCell>{humaniseFieldName(visit.payer_type)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </AsyncPanel>
  );
}

function HistoryTab({ patientId }: { readonly patientId: string }): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = patientKeys(hospitalId);

  const history = useQuery({
    queryKey: keys.history(patientId),
    queryFn: ({ signal }) => getPatientHistory(patientId, undefined, { signal }),
  });

  const rows = history.data?.items ?? [];

  return (
    <AsyncPanel
      loading={history.isPending}
      error={history.error}
      isEmpty={rows.length === 0}
      onRetry={() => void history.refetch()}
      skeletonLabel="Loading what changed"
      skeletonRows={4}
      empty={
        <EmptyState
          icon={<FileSearch />}
          cause="Nothing has been amended since this patient was registered."
          nextAction="Amendments appear here with the reason and the person who made them."
        />
      }
    >
      <ul className="flex flex-col gap-2" data-testid="demographic-history">
        {rows.map((entry) => (
          <li key={entry.id} className="rounded-lg border border-default bg-layer-1 p-3">
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-fg-default">
                {entry.changed_fields.map((field) => humaniseFieldName(field)).join(', ')}
              </span>
              <Badge tone="neutral" size="sm">
                {humaniseFieldName(entry.channel)}
              </Badge>
              <span className="font-mono text-xs text-fg-muted">{formatTimestamp(entry.changed_at)}</span>
            </p>
            <p className="mt-1 text-sm text-fg-default">
              <span className="text-fg-muted">Reason: </span>
              {entry.reason}
            </p>
            <ChangeTable changedFields={entry.changed_fields} before={entry.before} after={entry.after} />
          </li>
        ))}
      </ul>
    </AsyncPanel>
  );
}

function ChangeTable({
  changedFields,
  before,
  after,
}: {
  readonly changedFields: readonly string[];
  readonly before: unknown;
  readonly after: unknown;
}): React.JSX.Element | null {
  const beforeRecord = asRecord(before);
  const afterRecord = asRecord(after);
  if (beforeRecord === null && afterRecord === null) return null;

  return (
    <dl className="mt-2 grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      {changedFields.map((field) => (
        <div key={field} className="contents">
          <dt className="text-fg-muted">{humaniseFieldName(field)}</dt>
          <dd className="min-w-0">
            <span className="text-fg-muted line-through">{renderValue(beforeRecord?.[field]) ?? '—'}</span>
            <span aria-hidden="true"> → </span>
            <span className="sr-only">changed to</span>
            <span className="text-fg-default">{renderValue(afterRecord?.[field]) ?? '—'}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function Fact({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className={mono ? 'truncate font-mono text-sm text-fg-default' : 'text-sm text-fg-default'}>
        {value ?? '—'}
      </dd>
    </div>
  );
}
