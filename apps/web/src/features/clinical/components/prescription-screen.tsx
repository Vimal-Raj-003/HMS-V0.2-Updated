'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Kbd, useToast } from '@vims/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OctagonAlert } from '@/lib/icons';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { ActionUnavailable } from '@/features/frontoffice/components/frontoffice-gate';
import { ContextField, isIdentifier } from '@/features/frontoffice/components/context-field';
import { ShortcutBar } from '@/features/frontoffice/components/keyboard-sheet';
import { useShortcuts, type Shortcut } from '@/features/frontoffice/lib/shortcuts';
import { ApiProblem } from '@/lib/api';
import { useSession } from '@/lib/session-context';
import { newIdempotencyKey } from '../api/http';
import { clinicalKeys } from '../api/keys';
import { checkDosing, createPrescription, evaluate, getAllergies, signPrescription } from '../api/client';
import type { DosingContext, EvaluationView, OverrideInput, PrescriptionView } from '../api/types';
import { mayRenderSubmit, submissionGate } from '../lib/cdss';
import { blockedAlertIds, isHardStop, weightRequired, type WeightRequired } from '../lib/problems';
import {
  describeLine,
  emptyLine,
  isLineReady,
  lineFromDrug,
  toLineRequest,
  type RxLine,
} from '../lib/prescription';
import { CdssAlertRail } from './cdss-alert-rail';
import { DoseBuilder } from './dose-builder';
import { DrugSearch } from './drug-search';
import { ClinicalPatientHeader } from './patient-header';

/**
 * OP-002 §3.3 + EN-029 — the e-prescription.
 *
 * ## The one rule the whole screen is built around
 *
 * **A hard stop removes the ability to prescribe. It does not disable it, and it
 * does not add a confirmation.**
 *
 *  - While the evaluation reports a blocking alert, the "Prescribe" button is
 *    **not rendered at all** — `mayRenderSubmit` decides, and the hard-stop card
 *    stands in its place. A greyed-out button is an affordance somebody hunts
 *    for a way to enable; an absent one is an answer.
 *  - When the API refuses a submission with `clinical-hard-stop`, the refusal is
 *    rendered **without a retry control**. `ProblemCard`'s retry is exactly the
 *    "try it again and see" affordance a hard stop must not have, so the refusal
 *    gets its own card. Nothing in this file re-submits a prescription the API
 *    stopped: the mutation is `retry: false` by the query client's policy, and
 *    there is no code path that calls `create` again from an error handler.
 *  - Clearance is a **second clinician's** countersignature through
 *    `POST /cdss/alerts/{id}/respond`, which the API refuses from the prescriber
 *    who raised the alert. The card therefore shows the alert reference to hand
 *    over rather than a control to press.
 *
 * ## And the second rule
 *
 * A soft stop is answered with a **coded** reason, never with free text alone —
 * the API refuses the latter, and offering it would produce a refusal the
 * prescriber cannot act on. See `cdss-alert-rail.tsx`.
 */

const EVALUATE_DEBOUNCE_MS = 600;

export function PrescriptionScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = clinicalKeys(hospitalId);
  const { publish } = useToast();

  const [patientId, setPatientId] = useState('');
  const [encounterId, setEncounterId] = useState('');
  const [lines, setLines] = useState<readonly RxLine[]>([]);
  const [overrides, setOverrides] = useState<readonly OverrideInput[]>([]);
  const [evaluation, setEvaluation] = useState<EvaluationView | null>(null);
  const [dosing, setDosing] = useState<Readonly<Record<string, DosingContext>>>({});
  const [weightBlocks, setWeightBlocks] = useState<Readonly<Record<string, WeightRequired>>>({});
  const [checkingDose, setCheckingDose] = useState<readonly string[]>([]);
  const [created, setCreated] = useState<PrescriptionView | null>(null);
  const [submitKey, setSubmitKey] = useState(newIdempotencyKey);
  const nextKey = useRef(1);

  const canPrescribe = granted.has('rx.create');
  const canSign = granted.has('rx.sign');
  const canReadPatient = granted.has('patient.record.read');
  const canEvaluate = granted.has('cdss.evaluate');

  const ready = isIdentifier(patientId);
  const readyLines = lines.filter(isLineReady);

  const allergiesQuery = useQuery({
    queryKey: keys.allergies(patientId),
    queryFn: ({ signal }) => getAllergies(patientId, { signal }),
    enabled: ready && canReadPatient,
  });

  const evaluateMutation = useMutation({
    mutationFn: (input: {
      readonly items: readonly RxLine[];
      readonly overrides: readonly OverrideInput[];
    }) =>
      evaluate({
        patientId,
        ...(isIdentifier(encounterId) ? { encounterId } : {}),
        items: input.items.map((line) =>
          toLineRequest(
            line,
            input.overrides.filter((override) => override.reasonCode.trim() !== ''),
          ),
        ),
      }),
    onSuccess: setEvaluation,
  });

  const { mutate: runEvaluation } = evaluateMutation;

  // The safety check runs as the prescription is built, debounced — not on
  // submit. A check that only runs at the end is a check the prescriber meets
  // after they have finished thinking.
  useEffect(() => {
    if (!ready || !canEvaluate || readyLines.length === 0) {
      setEvaluation(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      runEvaluation({ items: readyLines, overrides });
    }, EVALUATE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
    // Keyed on `lines` rather than on `readyLines`: the derived array is a new
    // identity every render, and depending on it would re-run the check on every
    // keystroke — which is the opposite of a debounce.
  }, [ready, canEvaluate, lines, overrides, encounterId, runEvaluation, readyLines]);

  /**
   * The per-kilogram precondition, asked of the encounter rather than assumed.
   *
   * Run in an effect rather than as a query per line because the number of lines
   * is dynamic and hooks are not. Each check aborts when the line changes again.
   */
  const checkLineDose = useCallback(
    async (line: RxLine): Promise<void> => {
      if (line.doseBasis !== 'per_kg' || !isIdentifier(encounterId)) return;
      const mgPerKg = Number(line.doseQty.trim());
      if (!Number.isFinite(mgPerKg) || mgPerKg <= 0) return;

      setCheckingDose((current) => [...current, line.key]);
      try {
        const context = await checkDosing(encounterId, { mgPerKg, drugLabel: line.genericName });
        setDosing((current) => ({ ...current, [line.key]: context }));
        setWeightBlocks((current) => {
          const next = { ...current };
          delete next[line.key];
          return next;
        });
      } catch (error) {
        const required = weightRequired(error);
        if (required !== null) {
          setWeightBlocks((current) => ({ ...current, [line.key]: required }));
          setDosing((current) => {
            const next = { ...current };
            delete next[line.key];
            return next;
          });
        }
      } finally {
        setCheckingDose((current) => current.filter((key) => key !== line.key));
      }
    },
    [encounterId],
  );

  const perKgSignature = lines
    .filter((line) => line.doseBasis === 'per_kg')
    .map((line) => `${line.key}:${line.doseQty}`)
    .join('|');

  useEffect(() => {
    for (const line of lines.filter((candidate) => candidate.doseBasis === 'per_kg')) {
      void checkLineDose(line);
    }
    // `perKgSignature` is the dependency that matters: a change to an unrelated
    // line must not re-ask the encounter about its weight.
  }, [perKgSignature, encounterId, lines, checkLineDose]);

  const gate = submissionGate(evaluation, overrides);

  const create = useMutation({
    mutationFn: () =>
      createPrescription(
        {
          patientId,
          ...(isIdentifier(encounterId) ? { encounterId } : {}),
          items: readyLines.map((line) =>
            toLineRequest(
              line,
              overrides.filter((override) => override.reasonCode.trim() !== ''),
            ),
          ),
        },
        submitKey,
      ),
    onSuccess: (prescription) => {
      setCreated(prescription);
      setSubmitKey(newIdempotencyKey());
      publish({
        title: `Prescription ${prescription.rx_no ?? 'created'}`,
        description: canSign ? 'Sign it to release it to the pharmacy.' : 'It is waiting for a signature.',
        severity: 'success',
      });
    },
    // Deliberately no `onError` that retries or edits the request. A refused
    // prescription is a decision, and the only thing this screen does with it is
    // show it.
  });

  const sign = useMutation({
    mutationFn: (id: string) => signPrescription(id),
    onSuccess: (prescription) => {
      setCreated(prescription);
      publish({ title: 'Prescription signed', severity: 'success' });
    },
  });

  // Narrowed to `ApiProblem` rather than left as `Error`: the refusal card
  // prints `clinicalImpact`, `nextAction` and the reference, and those live on
  // the problem document rather than on the message.
  const serverHardStop =
    create.isError && create.error instanceof ApiProblem && isHardStop(create.error) ? create.error : null;
  const serverProblem = create.isError && !isHardStop(create.error) ? create.error : null;

  const addLine = (): void => {
    const key = `line-${String(nextKey.current)}`;
    nextKey.current += 1;
    setLines((current) => [...current, emptyLine(key)]);
    create.reset();
  };

  const shortcuts: readonly Shortcut[] = useMemo(
    () => [
      {
        key: 'r',
        alt: true,
        label: 'Add a prescription line',
        keys: ['Alt', 'R'],
        enabled: canPrescribe,
        run: addLine,
      },
      {
        key: 'd',
        alt: true,
        label: 'Jump to drug search',
        keys: ['Alt', 'D'],
        run: () => {
          document.querySelector<HTMLInputElement>('[data-testid="drug-search-input"]')?.focus();
        },
      },
    ],
    [canPrescribe, addLine],
  );

  useShortcuts(shortcuts);

  const blockedIds = blockedAlertIds(serverHardStop);

  return (
    <section className="flex flex-col gap-4" data-testid="prescription-screen">
      <PageHeader
        eyebrow="OPD clinical"
        title="Prescription"
        description="Build the prescription and the safety checks run as you go. A hard stop cannot be sent — it is changed, or a second clinician countersigns it."
        primaryAction={
          canPrescribe && mayRenderSubmit(gate) ? (
            <Button
              variant="primary"
              data-testid="rx-submit"
              disabled={
                !ready ||
                readyLines.length === 0 ||
                gate.kind !== 'clear' ||
                create.isPending ||
                Object.keys(weightBlocks).length > 0
              }
              onClick={() => {
                create.mutate();
              }}
            >
              Prescribe
            </Button>
          ) : undefined
        }
        meta={
          evaluation === null ? null : (
            <Badge tone={evaluation.degraded ? 'danger' : 'neutral'}>
              Checked in {evaluation.latencyMs} ms
            </Badge>
          )
        }
      />

      {canPrescribe ? null : (
        <ActionUnavailable
          title="You can read prescriptions but not write one"
          because="Prescribing is held by prescribers. Nursing and pharmacy hold the print key so a patient is never sent away without their prescription."
          permission="rx.create"
        />
      )}

      <div className="flex flex-wrap items-end gap-4">
        <ContextField
          label="Patient"
          testId="rx-patient"
          hint="Who this prescription is for. The allergy list and the interaction check are read for this patient."
          value={patientId}
          onChange={(next) => {
            setPatientId(next);
            setEvaluation(null);
            create.reset();
          }}
        />
        <ContextField
          label="Consultation"
          testId="rx-encounter"
          hint="Links the prescription to the consultation — and is what a per-kilogram dose reads the patient's weight from."
          value={encounterId}
          onChange={setEncounterId}
        />
      </div>

      {!ready ? (
        <EmptyState
          cause="No patient chosen."
          nextAction="Paste the patient identifier above. No allergy list is read and no safety check runs until then."
        />
      ) : (
        <>
          {canReadPatient ? (
            <ClinicalPatientHeader
              patientId={patientId}
              allergies={allergiesQuery.data ?? null}
              allergiesFailed={allergiesQuery.isError}
            />
          ) : (
            <p role="alert" data-testid="no-allergy-read" className="text-sm text-danger-on-surface">
              This login cannot read the patient’s allergy list. That is not the same as the patient having no
              allergies — check the chart before prescribing. The server still applies the allergy rule.
            </p>
          )}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,320px)_minmax(0,2fr)_minmax(0,360px)]">
            <div>
              <DrugSearch
                disabled={!canPrescribe}
                onSelect={(drug) => {
                  const key = `line-${String(nextKey.current)}`;
                  nextKey.current += 1;
                  setLines((current) => [...current, lineFromDrug(key, drug)]);
                  create.reset();
                }}
              />
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-md font-medium text-fg-default">
                  Prescription ({lines.length} line{lines.length === 1 ? '' : 's'})
                </h2>
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="rx-add-line"
                  disabled={!canPrescribe}
                  onClick={addLine}
                >
                  Add a line <Kbd>Alt</Kbd>
                  <Kbd>R</Kbd>
                </Button>
              </div>

              {lines.length === 0 ? (
                <EmptyState
                  cause="Nothing prescribed yet."
                  nextAction="Search for a drug on the left, or add a blank line for something the patient should buy outside."
                />
              ) : (
                <ul className="flex flex-col gap-3" data-testid="rx-lines">
                  {lines.map((line) => (
                    <DoseBuilder
                      key={line.key}
                      line={line}
                      disabled={!canPrescribe || create.isPending}
                      checking={checkingDose.includes(line.key)}
                      weightRequired={weightBlocks[line.key] ?? null}
                      computedDose={
                        dosing[line.key] === undefined || dosing[line.key]?.weightKg === null
                          ? null
                          : {
                              doseMg: dosing[line.key]?.doseMg ?? 0,
                              weightKg: dosing[line.key]?.weightKg ?? 0,
                            }
                      }
                      onChange={(next) => {
                        setLines((current) =>
                          current.map((candidate) => (candidate.key === next.key ? next : candidate)),
                        );
                        // A changed prescription is a different request: mint a
                        // new key so it is never a replay of the refused one.
                        setSubmitKey(newIdempotencyKey());
                        create.reset();
                      }}
                      onRemove={() => {
                        setLines((current) => current.filter((candidate) => candidate.key !== line.key));
                        setSubmitKey(newIdempotencyKey());
                        create.reset();
                      }}
                    />
                  ))}
                </ul>
              )}

              {serverHardStop === null ? null : (
                <div
                  role="alert"
                  data-testid="rx-refused-hard-stop"
                  className="rounded-lg border-2 border-danger-border bg-danger-surface p-4"
                >
                  <p className="flex items-center gap-2 text-md font-semibold text-danger-on-surface">
                    <OctagonAlert className="size-5 shrink-0" aria-hidden="true" />
                    {serverHardStop.problem.title}
                  </p>
                  <p className="mt-1 text-sm text-danger-on-surface">
                    {serverHardStop.problem.detail ??
                      'A safety rule this hospital cannot switch off stopped this prescription.'}
                  </p>
                  {serverHardStop.problem.clinicalImpact === undefined ? null : (
                    <p className="mt-1 text-sm text-danger-on-surface">
                      {serverHardStop.problem.clinicalImpact}
                    </p>
                  )}
                  <p className="mt-1 text-sm text-danger-on-surface">
                    {serverHardStop.problem.nextAction ??
                      'Change the prescription, or have a consultant countersign the alert from their own login.'}
                  </p>
                  {blockedIds.length === 0 ? null : (
                    <p className="mt-2 font-mono text-2xs text-fg-muted">
                      Alerts to countersign:{' '}
                      <span data-testid="refused-alert-ids">{blockedIds.join(', ')}</span>
                    </p>
                  )}
                  <p className="mt-2 font-mono text-2xs text-fg-muted">
                    Reference: <span data-testid="refused-reference">{serverHardStop.reference}</span>
                  </p>
                  <p className="mt-2 text-2xs text-danger-on-surface">
                    Nothing was prescribed. There is no way to send this as it stands — that is what a hard
                    stop means.
                  </p>
                </div>
              )}

              {serverProblem === null ? null : <ProblemCard error={serverProblem} />}

              {created === null ? null : (
                <section className="rounded-lg border border-strong bg-layer-1 p-3" data-testid="rx-created">
                  <p className="text-sm font-medium text-fg-default">
                    {created.rx_no ?? 'Prescription'} · {created.status}
                  </p>
                  <ul className="mt-2 flex flex-col gap-1">
                    {created.items.map((item) => (
                      <li key={item.id} className="text-2xs text-fg-muted">
                        {item.generic_name}
                        {item.strength_text === null ? '' : ` ${item.strength_text}`}
                        {item.computed_dose_qty === null
                          ? ''
                          : ` — ${String(item.computed_dose_qty)} ${item.dose_unit ?? ''} computed from ${String(item.weight_used_kg ?? 0)} kg`}
                      </li>
                    ))}
                  </ul>
                  {created.signed_at === null && canSign ? (
                    <Button
                      variant="primary"
                      size="sm"
                      className="mt-3"
                      data-testid="rx-sign"
                      disabled={sign.isPending}
                      onClick={() => {
                        sign.mutate(created.id);
                      }}
                    >
                      Sign and send to the pharmacy
                    </Button>
                  ) : null}
                  {created.signed_at === null && !canSign ? (
                    <p className="mt-2 text-2xs text-fg-muted">
                      This prescription is waiting for a consultant’s signature. It is not actionable by the
                      pharmacy until then.
                    </p>
                  ) : null}
                  {sign.isError ? <ProblemCard error={sign.error} /> : null}
                </section>
              )}

              {lines.length === 0 ? null : (
                <p className="text-2xs text-fg-subtle" data-testid="rx-summary">
                  {readyLines.map(describeLine).join(' | ')}
                </p>
              )}
            </div>

            <aside>
              <CdssAlertRail
                evaluation={evaluation}
                gate={gate}
                overrides={overrides}
                checking={evaluateMutation.isPending}
                onOverride={(override) => {
                  setOverrides((current) => [
                    ...current.filter((existing) => existing.family !== override.family),
                    override,
                  ]);
                  setSubmitKey(newIdempotencyKey());
                }}
              />
              {evaluateMutation.isError ? (
                <div className="mt-3">
                  <ProblemCard
                    error={evaluateMutation.error}
                    onRetry={() => {
                      runEvaluation({ items: readyLines, overrides });
                    }}
                    retryLabel="Run the safety checks again"
                  />
                  <p role="alert" className="mt-2 text-2xs text-danger-on-surface">
                    The safety checks did not run. That is not a pass — the server re-runs them when you
                    prescribe and will refuse anything it stops.
                  </p>
                </div>
              ) : null}
            </aside>
          </div>
        </>
      )}

      <ShortcutBar shortcuts={shortcuts} label="Prescription shortcuts" />
    </section>
  );
}
