'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Kbd,
  KeyboardHintBar,
  PrintPreview,
  useToast,
} from '@vims/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiProblem } from '@/lib/api';
import { ScanSearch, UserPlus, UserSearch } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { registerPatient } from '../api/client';
import { newIdempotencyKey } from '../api/http';
import { patientKeys } from '../api/keys';
import type { PatientDetail } from '../api/types';
import { isDuplicateHardStop } from '../lib/duplicates';
import { formatAge, HOSPITAL_TIME_ZONE } from '../lib/format';
import {
  emptyRegistrationForm,
  toRegisterRequest,
  validateRegistration,
  type FormErrors,
  type RegistrationFormState,
} from '../lib/registration-form';
import { DuplicateHardStop, type DuplicateOverride } from './duplicate-hard-stop';
import { PatientLookup } from './patient-lookup';
import { RegistrationFormFields } from './registration-form-fields';
import { UhidCard } from './uhid-card';

/**
 * The registration desk (OP-001 §8, phase-01 §1.8).
 *
 * The highest-traffic screen in the hospital, and the one with a stopwatch on it:
 * **≤ 90 seconds for a new patient, ≤ 20 seconds for a repeat.** Three decisions
 * follow from that and nothing else in this file is more important than them.
 *
 *  1. **Search first, always.** The screen opens on the search rail with the field
 *     focused. The repeat path is: type or scan, arrow down, Enter — three
 *     interactions, no mouse, no form. Registering is the *exception* path, behind
 *     F2, which is what stops a returning patient becoming a second record.
 *  2. **Fully operable without a mouse.** F2 new, F3 search, Ctrl+S save, Ctrl+P
 *     print the card, `?` the shortcut sheet, Escape closes the top layer. Every
 *     control is a native input or a Radix primitive.
 *  3. **The duplicate refusal is a hard stop, not a retry.** `POST /patients` may
 *     answer 422 with a candidate list. Nothing here re-sends the request with
 *     `overrideDuplicate` attached; `DuplicateHardStop` collects an
 *     acknowledgement per candidate and a reason from a human, and the human
 *     presses the button. See that file for the rest.
 *
 * **On the function keys.** `docs/06` §6.1 says shortcuts must "never conflict
 * with browser/OS reserved keys", and F3 is find-in-page while F5 is reload.
 * OP-001 §8 nevertheless specifies F2/F3/F4/F5 by name, because that is what the
 * software this replaces used and what the staff's fingers already know. The more
 * specific document wins (`CLAUDE.md` preamble), so the keys are bound and
 * `preventDefault` suppresses the browser's meaning — recorded here because it is
 * a deliberate deviation rather than an oversight.
 */

type Mode = 'search' | 'form';

export function RegistrationDesk(): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { publish } = useToast();
  const { hospitalId, branchId, displayName, granted } = useSession();
  const keys = patientKeys(hospitalId);

  const canCreate = granted.has('patient.record.create');

  const [mode, setMode] = useState<Mode>('search');
  const [form, setForm] = useState<RegistrationFormState>(emptyRegistrationForm);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const [duplicate, setDuplicate] = useState<ApiProblem | null>(null);
  const [registered, setRegistered] = useState<PatientDetail | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  /**
   * One key per **submission**, not per retry (`docs/06` §6.6). It survives a
   * failed save so a network retry of the *same* body replays rather than
   * duplicates, and is replaced whenever the body changes — which the override
   * path does, by adding `overrideDuplicate`.
   */
  const submissionKey = useRef(newIdempotencyKey());

  const searchRegionRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const errorSummaryRef = useRef<HTMLDivElement | null>(null);
  const entryCounter = useRef(0);

  const asserter = useMemo(
    () => ({
      name: displayName,
      on: new Intl.DateTimeFormat('en-GB', {
        timeZone: HOSPITAL_TIME_ZONE,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      })
        .format(new Date())
        .replace(/\//g, '-'),
    }),
    [displayName],
  );

  const focusSearch = useCallback((): void => {
    setMode('search');
    // `PatientSearchCombobox` owns its input and exposes no ref, so the field is
    // reached through the region this screen wraps it in. Querying inside a region
    // this component renders is not reaching into another component's internals —
    // it is the same thing `document.activeElement` would tell us.
    window.requestAnimationFrame(() => {
      searchRegionRef.current?.querySelector('input')?.focus();
    });
  }, []);

  const startNewPatient = useCallback((): void => {
    setMode('form');
    setRegistered(null);
    window.requestAnimationFrame(() => {
      firstFieldRef.current?.focus();
    });
  }, []);

  const register = useMutation({
    mutationFn: (input: { readonly override?: DuplicateOverride }) =>
      registerPatient(
        toRegisterRequest(form, {
          ...(branchId === null ? {} : { branchId }),
          ...(input.override === undefined ? {} : { overrideDuplicate: input.override }),
        }),
        submissionKey.current,
      ),
    onSuccess: (patient) => {
      void queryClient.invalidateQueries({ queryKey: keys.recent() });
      setDuplicate(null);
      setRegistered(patient);
      setForm(emptyRegistrationForm());
      setErrors({});
      setSubmitted(false);
      submissionKey.current = newIdempotencyKey();
      setMode('search');
      publish({
        title: `${patient.full_name} registered`,
        description: `UHID ${patient.uhid}. Print the card, then check them in.`,
        severity: 'success',
      });
    },
    onError: (error: unknown) => {
      if (isDuplicateHardStop(error)) {
        setDuplicate(error);
        return;
      }
      // Anything else is shown as the problem it is, above the form, with its
      // reference. The form keeps every keystroke: re-typing ninety seconds of
      // demographics because the network blinked is how a desk starts keeping
      // paper.
      setDuplicate(null);
    },
  });

  const save = useCallback((): void => {
    if (!canCreate || register.isPending) return;
    setSubmitted(true);
    const found = validateRegistration(form);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      // docs/06 §6.4 wants a summary banner listing the fields. Moving focus to it
      // is what makes that useful to a screen-reader user: `role="alert"` announces
      // it once, and focus puts the reader *in* the list rather than leaving them
      // at the bottom of a form that silently did nothing.
      window.requestAnimationFrame(() => {
        errorSummaryRef.current?.focus();
      });
      return;
    }
    register.mutate({});
  }, [canCreate, form, register]);

  // ── keyboard (OP-001 §8) ───────────────────────────────────────────────────
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const meta = event.metaKey || event.ctrlKey;

      if (event.key === 'F3' && !meta) {
        event.preventDefault();
        focusSearch();
        return;
      }
      if (event.key === 'F2' && !meta) {
        event.preventDefault();
        if (canCreate) startNewPatient();
        return;
      }
      if (meta && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        if (mode === 'form') save();
        return;
      }
      if (meta && (event.key === 'p' || event.key === 'P') && registered !== null) {
        event.preventDefault();
        window.print();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, [canCreate, focusSearch, mode, registered, save, startNewPatient]);

  const errorEntries = Object.entries(errors);
  const showErrorSummary = submitted && errorEntries.length > 0;

  return (
    <>
      <div className="flex flex-col gap-4 print:hidden" data-testid="registration-desk">
        <PageHeader
          eyebrow="OP-001"
          title="Registration desk"
          description="Find the patient before you create one. A returning patient is already here — registering them twice splits their clinical record in two."
          primaryAction={
            canCreate ? (
              <Button variant="primary" data-testid="new-patient" onClick={startNewPatient}>
                <UserPlus aria-hidden="true" />
                New patient
                <Kbd>F2</Kbd>
              </Button>
            ) : undefined
          }
          actions={
            <Button variant="secondary" data-testid="focus-search" onClick={focusSearch}>
              <UserSearch aria-hidden="true" />
              Search
              <Kbd>F3</Kbd>
            </Button>
          }
        />

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[22rem_minmax(0,1fr)_18rem]">
          {/* ── search rail ─────────────────────────────────────────────── */}
          <section
            aria-labelledby="registration-search-heading"
            className="flex flex-col gap-3 rounded-lg border border-default bg-layer-1 p-3"
            ref={searchRegionRef}
          >
            {/* Deliberately not "Find a patient": that is the *field's* label, and
                two elements with the same accessible name make the region and the
                control indistinguishable to a screen reader and to a test. */}
            <h2 id="registration-search-heading" className="text-md font-semibold text-fg-default">
              Search the patient index
            </h2>
            <PatientLookup
              autoFocus
              onSelect={(result) => {
                router.push(`/patients/${result.patientId}`);
              }}
            />
            <p className="text-xs text-fg-muted">
              Scan a UHID card or wristband at any time — the scanner does not need this field to be focused.
            </p>
          </section>

          {/* ── work area ───────────────────────────────────────────────── */}
          <section aria-labelledby="registration-form-heading" className="min-w-0">
            <h2 id="registration-form-heading" className="sr-only">
              Register a new patient
            </h2>

            {mode === 'search' ? (
              <EmptyState
                icon={<ScanSearch />}
                cause="No patient is open. Search by mobile, UHID, name or ABHA, or scan their card."
                nextAction={
                  canCreate
                    ? 'If nobody matches, press F2 to register a new patient.'
                    : 'Your roles allow you to look a patient up but not to register one.'
                }
                {...(canCreate ? { action: { label: 'New patient (F2)', onSelect: startNewPatient } } : {})}
              />
            ) : (
              <form
                noValidate
                className="flex flex-col gap-4 rounded-lg border border-default bg-layer-1 p-4"
                aria-labelledby="registration-form-heading"
                onSubmit={(event) => {
                  event.preventDefault();
                  save();
                }}
              >
                {register.isError && duplicate === null ? <ProblemCard error={register.error} /> : null}

                {showErrorSummary ? (
                  <div
                    role="alert"
                    tabIndex={-1}
                    ref={errorSummaryRef}
                    data-testid="registration-error-summary"
                    className="rounded-md border border-danger-border bg-danger-surface p-3 text-sm text-danger-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    <p className="font-medium">
                      {errorEntries.length === 1
                        ? 'One field needs attention before this patient can be registered.'
                        : `${String(errorEntries.length)} fields need attention before this patient can be registered.`}
                    </p>
                    <ul className="mt-1 list-inside list-disc">
                      {errorEntries.map(([field, message]) => (
                        <li key={field}>{message}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <RegistrationFormFields
                  form={form}
                  errors={errors}
                  disabled={register.isPending}
                  firstFieldRef={firstFieldRef}
                  asserter={asserter}
                  newEntryId={() => {
                    entryCounter.current += 1;
                    return `draft-allergy-${String(entryCounter.current)}`;
                  }}
                  onChange={(patch) => {
                    setForm((current) => {
                      const next = { ...current, ...patch };
                      // docs/06 §6.4: re-validate on change only once a field has
                      // already errored, never on the first keystroke.
                      if (submitted) setErrors(validateRegistration(next));
                      return next;
                    });
                  }}
                />

                <div className="flex flex-wrap items-center justify-end gap-2 border-t border-default pt-3">
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => {
                      setForm(emptyRegistrationForm());
                      setErrors({});
                      setSubmitted(false);
                      focusSearch();
                    }}
                  >
                    Discard
                  </Button>
                  <Button
                    variant="primary"
                    type="submit"
                    data-testid="register-save"
                    disabled={register.isPending}
                    aria-busy={register.isPending}
                  >
                    {register.isPending ? 'Registering…' : 'Register patient'}
                    <Kbd>Ctrl S</Kbd>
                  </Button>
                </div>
              </form>
            )}
          </section>

          {/* ── context rail ────────────────────────────────────────────── */}
          <aside
            aria-labelledby="registration-rail-heading"
            className="flex flex-col gap-3 rounded-lg border border-default bg-layer-1 p-3"
          >
            <h2 id="registration-rail-heading" className="text-md font-semibold text-fg-default">
              {registered === null ? 'This counter' : 'Just registered'}
            </h2>

            {registered === null ? (
              <>
                <p className="text-sm text-fg-muted">
                  Registered by {displayName}
                  {branchId === null ? '' : ' at this branch'}.
                </p>
                <ShortcutList />
                <p className="text-xs text-fg-muted">
                  Today&rsquo;s counter totals come from the front-office dashboard read model, which is not
                  built yet.
                </p>
              </>
            ) : (
              <div className="flex flex-col gap-3" data-testid="registration-success">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-lg text-fg-default" data-testid="new-uhid">
                    {registered.uhid}
                  </span>
                  <Badge tone="success" size="sm">
                    Registered
                  </Badge>
                </p>
                <p className="text-sm text-fg-default">{registered.full_name}</p>
                <p className="text-xs text-fg-muted">
                  {formatAge(registered)} · {registered.gender}
                </p>

                <PrintPreview
                  paper="label-50x25"
                  targets={[]}
                  agent={{ kind: 'not-installed' }}
                  labels={PRINT_LABELS}
                  onPrint={() => {
                    window.print();
                  }}
                >
                  <UhidCard patient={registered} />
                </PrintPreview>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    data-testid="open-new-patient"
                    onClick={() => {
                      router.push(`/patients/${registered.id}`);
                    }}
                  >
                    Open the record
                  </Button>
                  {canCreate ? (
                    <Button variant="ghost" size="sm" onClick={startNewPatient}>
                      Register another
                    </Button>
                  ) : null}
                </div>
              </div>
            )}
          </aside>
        </div>

        <KeyboardHintBar
          label="Registration shortcuts"
          hints={SHORTCUTS.map((shortcut) => ({ keys: shortcut.keys, label: shortcut.label }))}
          openSheetLabel="All shortcuts"
          onOpenSheet={() => {
            setShortcutsOpen(true);
          }}
        />
      </div>

      {/* Printed on Ctrl+P and from the print panel. Hidden on screen; the desk is
          hidden on paper. No global stylesheet is touched to do it. */}
      {registered === null ? null : (
        <div className="hidden print:block" aria-hidden="true">
          <div className="h-[25mm] w-[50mm]">
            <UhidCard patient={registered} />
          </div>
        </div>
      )}

      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent closeLabel="Close">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>
              Registration is designed to be completed without a mouse. Press ? at any time to reopen this.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ShortcutList />
          </DialogBody>
        </DialogContent>
      </Dialog>

      {duplicate === null ? null : (
        <DuplicateHardStop
          problem={duplicate}
          open
          submitting={register.isPending}
          onOpenChange={(open) => {
            if (!open) setDuplicate(null);
          }}
          onOpenExisting={(patientId) => {
            setDuplicate(null);
            router.push(`/patients/${patientId}`);
          }}
          onOverride={(override) => {
            // A different body is a different submission: reusing the key would be
            // refused as a fingerprint mismatch, and it *is* a new intent — the
            // clerk has decided something they had not decided before.
            submissionKey.current = newIdempotencyKey();
            register.mutate({ override });
          }}
        />
      )}
    </>
  );
}

interface Shortcut {
  readonly keys: readonly string[];
  readonly label: string;
}

const SHORTCUTS: readonly Shortcut[] = [
  { keys: ['F3'], label: 'Find a patient' },
  { keys: ['F2'], label: 'New patient' },
  { keys: ['↓', '↑'], label: 'Move through results' },
  { keys: ['Enter'], label: 'Open the highlighted patient' },
  { keys: ['Ctrl', 'S'], label: 'Register' },
  { keys: ['Ctrl', 'P'], label: 'Print the card' },
  { keys: ['Esc'], label: 'Close the top layer' },
  { keys: ['?'], label: 'This list' },
];

function ShortcutList(): React.JSX.Element {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      {SHORTCUTS.map((shortcut) => (
        <div key={shortcut.label} className="contents">
          <dt className="flex items-center gap-1">
            {shortcut.keys.map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </dt>
          <dd className="text-fg-muted">{shortcut.label}</dd>
        </div>
      ))}
    </dl>
  );
}

const PRINT_LABELS = {
  region: 'Patient identity card',
  previewLabel: 'Preview of the patient identity card',
  target: 'Printer',
  targetPlaceholder: 'Choose a printer',
  tray: 'Tray',
  copies: 'Copies',
  print: 'Print on the label printer',
  printViaBrowser: 'Print',
  printLater: 'Print later',
  agentConnected: 'The print agent is connected.',
  agentDisconnected: (since: string) => `The print agent has been offline since ${since}.`,
  agentNotInstalled:
    'No print agent is configured on this counter (EN-005), so the browser print dialog is used.',
  printerOffline: 'That printer is offline.',
  lastPrint: (by: string, at: string, target: string, copies: number) =>
    `${String(copies)} copy printed by ${by} at ${at} on ${target}.`,
  duplicateWarning: 'Do not hand out two cards for one patient.',
  noTargets: 'No label printer is configured for this counter yet.',
};
