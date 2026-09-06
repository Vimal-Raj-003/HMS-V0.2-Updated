'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Label } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { administer, getMarRound, omitDose } from '../api/client';
import { ipKeys } from '../api/keys';
import type { MarDoseRow } from '../api/types';

/**
 * The coded reasons a dose was not given.
 *
 * A fixed list rather than free text, because "patient asleep" and "drug not on
 * the ward" are different problems with different owners, and a ward that
 * cannot count its missed doses cannot fix them. The server holds the same list
 * and refuses anything outside it.
 */
const REASON_CODES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'patient_asleep', label: 'Patient asleep' },
  { code: 'patient_refused', label: 'Patient refused' },
  { code: 'patient_absent', label: 'Patient off the ward' },
  { code: 'patient_nbm', label: 'Nil by mouth' },
  { code: 'drug_unavailable', label: 'Drug not available on the ward' },
  { code: 'iv_access_lost', label: 'IV access lost' },
  { code: 'held_for_procedure', label: 'Held for a procedure' },
  { code: 'held_for_level', label: 'Held pending a level' },
  { code: 'held_clinical', label: 'Held on clinical grounds' },
  { code: 'vomited', label: 'Vomited the dose' },
  { code: 'allergy_suspected', label: 'Allergy suspected' },
  { code: 'order_changed', label: 'Order changed' },
  { code: 'other', label: 'Other' },
];

const inputClass = 'h-10 w-full rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';
const selectClass = 'h-10 rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

/**
 * IP-003 §3.4 — the drug round.
 *
 * ── Two scans, and nothing that stands in for them ──────────────────────────
 *
 * The form has a wristband field and a drug field. There is no "scanner broken"
 * checkbox, no override and no way to submit without both, because the server
 * has none either and the database refuses a `given` row without both payloads.
 * `phase-07` puts it plainly: no feature flag, no configuration value and no
 * emergency mode may bypass the 5 Rights.
 *
 * ── The witness field appears with the drug, not after the refusal ──────────
 *
 * A high-alert drug shows the second-nurse field as part of the dose, so the
 * nurse fetches a colleague before starting rather than after being told to.
 * The server enforces it regardless, and refuses a witness who is the same
 * person — a second check by the same person is not a second check.
 */
export function MarRoundScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = ipKeys(hospitalId);
  const queryClient = useQueryClient();

  const [overdueOnly, setOverdueOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [patientScan, setPatientScan] = useState('');
  const [drugScan, setDrugScan] = useState('');
  const [witness, setWitness] = useState('');
  const [givenDose, setGivenDose] = useState('');
  const [reasonCode, setReasonCode] = useState('patient_asleep');

  const round = useQuery({
    queryKey: keys.mar(overdueOnly ? 'overdue' : 'due'),
    queryFn: ({ signal }) => getMarRound({ dueOnly: true, overdueOnly }, { signal }),
    refetchInterval: 60_000,
  });

  function reset(): void {
    setOpen(null);
    setPatientScan('');
    setDrugScan('');
    setWitness('');
    setGivenDose('');
  }

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey: keys.marRoot() });
    void queryClient.invalidateQueries({ queryKey: keys.wardRoot() });
  }

  const give = useMutation({
    mutationFn: (id: string) =>
      administer(id, {
        patientScan: patientScan.trim(),
        drugScan: drugScan.trim(),
        ...(witness.trim() === '' ? {} : { witnessedBy: witness.trim() }),
        ...(givenDose.trim() === '' ? {} : { givenDose: givenDose.trim() }),
      }),
    onSuccess: () => {
      reset();
      invalidate();
    },
  });

  const omit = useMutation({
    mutationFn: (id: string) => omitDose(id, { state: 'missed', reasonCode }),
    onSuccess: () => {
      reset();
      invalidate();
    },
  });

  const rows: readonly MarDoseRow[] = [...(round.data?.items ?? [])].sort(
    (a, b) => (a.minutesUntilDue ?? 0) - (b.minutesUntilDue ?? 0),
  );
  const late = rows.filter((d) => d.overdue).length;

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Drug round"
        description="Every dose due, latest first. Two scans and — for a high-alert drug — a second nurse."
      />

      <div className="flex flex-wrap items-center gap-3">
        {late > 0 ? (
          <Badge tone="danger">{`${String(late)} dose(s) past their time`}</Badge>
        ) : (
          <Badge tone="success">nothing overdue</Badge>
        )}
        <label className="flex min-h-12 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={overdueOnly}
            onChange={(e) => {
              setOverdueOnly(e.target.checked);
            }}
          />
          Only the late ones
        </label>
      </div>

      {give.error === null ? null : <ProblemCard error={give.error} />}
      {omit.error === null ? null : <ProblemCard error={omit.error} />}

      <AsyncPanel
        loading={round.isPending}
        error={round.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the drug round"
        skeletonRows={8}
        onRetry={() => {
          void round.refetch();
        }}
        empty={
          <EmptyState
            cause={overdueOnly ? 'No dose is late.' : 'Nothing is due.'}
            nextAction={
              overdueOnly
                ? 'Clear the filter to see the rest of the round.'
                : 'The next round will appear here.'
            }
          />
        }
      >
        <ul className="flex flex-col gap-2" data-testid="mar-round">
          {rows.map((d) => (
            <li
              key={d.id}
              className="rounded-lg border border-strong bg-layer-1 p-4"
              data-testid={`dose-${d.id}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-2xs text-fg-subtle">{d.bedCode ?? d.ipNo}</span>
                    <span className="text-sm font-semibold text-fg-default">{d.drugName}</span>
                    <span className="text-sm">
                      {d.dose} {d.doseUnit} · {d.route}
                    </span>
                    {d.isHighAlert ? <Badge tone="danger">high alert</Badge> : null}
                    {d.isNarcotic ? <Badge tone="danger">controlled</Badge> : null}
                    {d.isPrn ? <Badge tone="info">when required</Badge> : null}
                    {d.verified ? null : <Badge tone="warning">not yet verified by pharmacy</Badge>}
                  </div>
                  <p className="mt-1 text-2xs">
                    {d.minutesUntilDue === null ? (
                      <span className="text-fg-subtle">no scheduled time</span>
                    ) : d.overdue ? (
                      <span className="font-semibold text-fg-danger">
                        {`${String(Math.abs(d.minutesUntilDue))} min late`}
                      </span>
                    ) : (
                      <span className="text-fg-subtle">{`due in ${String(d.minutesUntilDue)} min`}</span>
                    )}
                  </p>
                </div>
                <Button
                  type="button"
                  variant={open === d.id ? 'secondary' : 'primary'}
                  onClick={() => {
                    if (open === d.id) reset();
                    else {
                      reset();
                      setOpen(d.id);
                    }
                  }}
                >
                  {open === d.id ? 'Close' : 'Give'}
                </Button>
              </div>

              {open === d.id ? (
                <div className="mt-3 border-t border-default pt-3">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <Label htmlFor={`wb-${d.id}`}>Scan the wristband</Label>
                      <input
                        id={`wb-${d.id}`}
                        className={inputClass}
                        value={patientScan}
                        placeholder="Hold the scanner over the band"
                        onChange={(e) => {
                          setPatientScan(e.target.value);
                        }}
                      />
                    </div>
                    <div>
                      <Label htmlFor={`dr-${d.id}`}>Scan the drug</Label>
                      <input
                        id={`dr-${d.id}`}
                        className={inputClass}
                        value={drugScan}
                        placeholder="Scan the box or the unit dose"
                        onChange={(e) => {
                          setDrugScan(e.target.value);
                        }}
                      />
                    </div>
                    {d.isHighAlert || d.isNarcotic ? (
                      <div>
                        <Label htmlFor={`wt-${d.id}`}>Second nurse</Label>
                        <input
                          id={`wt-${d.id}`}
                          className={inputClass}
                          value={witness}
                          placeholder="Their user id"
                          onChange={(e) => {
                            setWitness(e.target.value);
                          }}
                        />
                      </div>
                    ) : null}
                    <div>
                      <Label htmlFor={`gd-${d.id}`}>Dose given, if different</Label>
                      <input
                        id={`gd-${d.id}`}
                        className={inputClass}
                        value={givenDose}
                        placeholder={`${d.dose} ${d.doseUnit}`}
                        onChange={(e) => {
                          setGivenDose(e.target.value);
                        }}
                      />
                    </div>
                  </div>

                  {d.isHighAlert || d.isNarcotic ? (
                    <p className="mt-2 text-2xs text-fg-warning">
                      {d.drugName} is high alert. A second nurse checks it, and it cannot be you — a second
                      check by the same person is not a second check.
                    </p>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <Button
                      type="button"
                      disabled={
                        give.isPending ||
                        patientScan.trim() === '' ||
                        drugScan.trim() === '' ||
                        ((d.isHighAlert || d.isNarcotic) && witness.trim() === '')
                      }
                      onClick={() => {
                        give.mutate(d.id);
                      }}
                    >
                      {give.isPending ? 'Recording…' : 'Record the dose'}
                    </Button>

                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`rc-${d.id}`}>Or record why it was not given</Label>
                      <select
                        id={`rc-${d.id}`}
                        className={selectClass}
                        value={reasonCode}
                        onChange={(e) => {
                          setReasonCode(e.target.value);
                        }}
                      >
                        {REASON_CODES.map((r) => (
                          <option key={r.code} value={r.code}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={omit.isPending}
                      onClick={() => {
                        omit.mutate(d.id);
                      }}
                    >
                      Not given
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </AsyncPanel>

      <p className="text-2xs text-fg-subtle">
        Both scans are compared against the patient and the drug before anything is recorded. A mismatch is
        refused and kept as a near miss — a wrong-drug scan nobody counts is a wrong-drug scan that becomes an
        error the week the scanner is broken.
      </p>
    </section>
  );
}
