'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Kbd, useToast } from '@vims/ui';
import { useMemo, useState } from 'react';
import { HeartPulse } from '@/lib/icons';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { ContextField, isIdentifier } from '@/features/frontoffice/components/context-field';
import { ShortcutBar } from '@/features/frontoffice/components/keyboard-sheet';
import { useShortcuts, type Shortcut } from '@/features/frontoffice/lib/shortcuts';
import { useSession } from '@/lib/session-context';
import { newIdempotencyKey } from '../api/http';
import { clinicalKeys } from '../api/keys';
import {
  acknowledgeVitalsAlert,
  getAllergies,
  listReferenceRanges,
  listVitals,
  recordVitals,
} from '../api/client';
import type { VitalsAlertAction, VitalsDetail, VitalsRow } from '../api/types';
import { formatInstant } from '../lib/numbers';
import { ageDaysAt, parseRanges } from '../lib/ranges';
import {
  EMPTY_VITALS_FORM,
  VITALS_FIELDS,
  blockingMessages,
  hasAnyMeasurement,
  previewVerdicts,
  toCreateRequest,
  type VitalsFormState,
} from '../lib/vitals-form';
import { CriticalActionPrompt } from './critical-action-prompt';
import { VitalsEntryPad } from './vitals-entry-pad';
import { FlagChip, Ews2Badge } from './flag-chip';
import { ClinicalPatientHeader, usePatientContext } from './patient-header';
import { VitalsSparkline, type TrendPoint } from './vitals-sparkline';

/**
 * OP-007 — the vitals station.
 *
 * ## What this screen refuses to do
 *
 * **It does not hold a threshold.** Every abnormal and critical band comes from
 * `clinical.vitals_reference_ranges` through `GET /vitals/reference-ranges`, and
 * where the bands cannot be read the screen says so and shows no colour rather
 * than falling back to a built-in number. That matters because the fallback
 * would be *wrong*: the bands are age-, sex- and pregnancy-aware and
 * effective-dated, and a hospital that has tightened its systolic band has done
 * so for a reason.
 *
 * **It never shows the flag it computed over the flag the server computed.** The
 * live preview is a courtesy while typing; the moment a reading is saved, what
 * is displayed is `flags`, `overall_flag`, `news2_score` and `news2_band` from
 * the record the API wrote — the same values that raised the alert and paged the
 * doctor.
 *
 * ## The permission wrinkle, stated rather than worked around
 *
 * `GET /vitals/reference-ranges` is gated on **`vitals.configure`** (OP-007 §6
 * puts it on the config row, and `vitals.controller.ts` implements exactly
 * that). The vitals nurse — role `nurse_opd`, docs/05 row 16 — does **not** hold
 * that key; it belongs to hospital and branch administrators, the nurse
 * supervisor, biomedical and IT. So on the login this screen was built for, the
 * live colouring is simply unavailable. The screen asks for the bands only when
 * the session holds the key, and otherwise renders an explicit notice. This is a
 * spec contradiction, not a bug in the screen, and it is reported as one.
 *
 * ## What is missing because the API has not built it
 *
 * OP-007 §6 lists a vitals **queue** (`GET /vitals/queue`, `call-next`, `skip`,
 * `requeue`, `bypass`), a **forward** to the doctor's queue and a one-click
 * **send-to-ER**. None of the three exists in this build, so the station is
 * driven by a patient identifier rather than by a called token, exactly as the
 * front-office screens are and for the same reason.
 */

const VITALS_STATION_HINTS = 'Vitals station shortcuts';

export function VitalsRoomScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = clinicalKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  // Deliberately **not** remembered between sessions, unlike the front office's
  // queue and counter fields. Those hold an identifier of a piece of furniture;
  // this one holds a patient, and a shared station tablet must not open on the
  // last patient somebody else was working on.
  const [patientId, setPatientId] = useState('');
  const [visitId, setVisitId] = useState('');
  const [form, setForm] = useState<VitalsFormState>(EMPTY_VITALS_FORM);
  const [saved, setSaved] = useState<VitalsDetail | null>(null);
  // One key per submission. Regenerated whenever the form changes, so a retry of
  // the *same* reading replays the first answer and an edited reading is a new
  // request rather than a refused replay.
  const [saveKey, setSaveKey] = useState(newIdempotencyKey);

  const ready = isIdentifier(patientId);
  const canReadHistory = granted.has('vitals.record.read');
  const canReadBands = granted.has('vitals.configure');
  const canReadPatient = granted.has('patient.record.read');
  const canAcknowledge = granted.has('vitals.alert.acknowledge');

  const rangesQuery = useQuery({
    queryKey: keys.referenceRanges(),
    queryFn: ({ signal }) => listReferenceRanges({ signal }),
    enabled: canReadBands,
    staleTime: 5 * 60_000,
  });

  const patientQuery = usePatientContext(patientId, ready && canReadPatient);

  const allergiesQuery = useQuery({
    queryKey: keys.allergies(patientId),
    queryFn: ({ signal }) => getAllergies(patientId, { signal }),
    enabled: ready && canReadPatient,
  });

  const historyQuery = useQuery({
    queryKey: keys.vitalsFor(patientId),
    queryFn: ({ signal }) => listVitals({ patient: patientId, limit: 10 }, { signal }),
    enabled: ready && canReadHistory,
  });

  const ranges = rangesQuery.data === undefined ? null : parseRanges(rangesQuery.data.items);
  const patient = patientQuery.data;

  const subject = useMemo(
    () => ({
      ageDays: ageDaysAt(patient?.dob ?? null, new Date()),
      sex: patient?.gender ?? 'unknown',
      // The observation's own pregnancy status is captured on the record; the
      // band selection uses the patient's standing status, which is what the
      // server does too.
      pregnancy: 'unknown',
      copdScale2: false,
    }),
    [patient],
  );

  const verdicts = previewVerdicts(form, ranges, subject);
  const problems = blockingMessages(verdicts, form);

  const save = useMutation({
    mutationFn: () => recordVitals(toCreateRequest(form, { patientId, visitId }), saveKey),
    onSuccess: (record) => {
      setSaved(record);
      setSaveKey(newIdempotencyKey());
      setForm(EMPTY_VITALS_FORM);
      void queryClient.invalidateQueries({ queryKey: keys.vitals() });
      publish({
        title: record.overall_flag === 'critical' ? 'Saved — critical' : 'Observation saved',
        description:
          record.overall_flag === 'critical'
            ? 'A critical alert was raised. Record what you did and get a doctor to acknowledge it.'
            : `Flagged ${record.overall_flag} by the hospital’s own bands.`,
        severity: record.overall_flag === 'critical' ? 'danger' : 'success',
      });
    },
  });

  const acknowledge = useMutation({
    mutationFn: (input: {
      readonly vitalsId: string;
      readonly alertId: string;
      readonly action: VitalsAlertAction;
      readonly note: string;
    }) =>
      acknowledgeVitalsAlert(input.vitalsId, input.alertId, {
        actionTaken: input.action,
        ...(input.note.trim() === '' ? {} : { note: input.note.trim() }),
        patientInformed: false,
      }),
    onSuccess: (alert) => {
      setSaved((current) =>
        current === null
          ? current
          : {
              ...current,
              alerts: current.alerts.map((existing) => (existing.id === alert.id ? alert : existing)),
            },
      );
      publish({ title: 'Alert acknowledged', severity: 'success' });
    },
  });

  const canSave = ready && hasAnyMeasurement(form) && problems.length === 0 && !save.isPending;

  const shortcuts: readonly Shortcut[] = useMemo(
    () => [
      {
        key: 's',
        ctrl: true,
        label: 'Save the observation set',
        keys: ['Ctrl', 'S'],
        enabled: canSave,
        run: () => {
          save.mutate();
        },
      },
      {
        key: 'F3',
        label: 'Jump to the patient field',
        keys: ['F3'],
        run: () => {
          document.querySelector<HTMLInputElement>('[data-testid="vitals-patient"]')?.focus();
        },
      },
      {
        key: 'n',
        alt: true,
        label: 'Clear the form for the next patient',
        keys: ['Alt', 'N'],
        run: () => {
          setForm(EMPTY_VITALS_FORM);
          setSaved(null);
          setSaveKey(newIdempotencyKey());
        },
      },
    ],
    [canSave, save],
  );

  useShortcuts(shortcuts);

  const trend = (row: VitalsRow, key: 'systolic' | 'pulse' | 'spo2'): TrendPoint | null => {
    const value = row[key];
    return value === null ? null : { at: row.recorded_at, value };
  };

  const history = historyQuery.data?.items ?? [];
  const trendFor = (key: 'systolic' | 'pulse' | 'spo2'): readonly TrendPoint[] =>
    [...history]
      .reverse()
      .map((row) => trend(row, key))
      .filter((point): point is TrendPoint => point !== null);

  const savedFlags = saved === null ? [] : Object.entries(saved.flags);
  const criticalParameters =
    saved === null
      ? []
      : savedFlags.filter(([, flag]) => flag === 'critical').map(([parameter]) => parameter);

  return (
    <section className="flex flex-col gap-4" data-testid="vitals-room">
      <PageHeader
        eyebrow="OPD clinical"
        title="Vitals room"
        description="Observations for the patient in front of you. Values are flagged against this hospital's own bands — nothing here carries a built-in threshold."
        primaryAction={
          <Button
            variant="primary"
            size="touch"
            data-testid="vitals-save"
            disabled={!canSave}
            onClick={() => {
              save.mutate();
            }}
          >
            Save observations <Kbd>Ctrl</Kbd>
            <Kbd>S</Kbd>
          </Button>
        }
        meta={
          <>
            <Badge tone="neutral" icon={<HeartPulse aria-hidden="true" />}>
              {canReadBands ? 'Bands from this hospital' : 'Bands applied on save'}
            </Badge>
            {saved === null ? null : <Ews2Badge score={saved.news2_score} band={saved.news2_band} />}
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-4">
        <ContextField
          label="Patient"
          testId="vitals-patient"
          hint="The patient this reading belongs to. Not remembered between sessions — a shared station must never open on somebody else's patient."
          value={patientId}
          onChange={(next) => {
            setPatientId(next);
            setSaved(null);
          }}
        />
        <ContextField
          label="Visit (optional)"
          testId="vitals-visit"
          hint="Attaches the reading to today's visit so the doctor's screen picks it up."
          value={visitId}
          onChange={setVisitId}
        />
      </div>

      {!ready ? (
        <EmptyState
          cause="No patient chosen yet."
          nextAction="Scan the OP slip or paste the patient identifier above. Nothing is read from the server until then, so no record is opened by accident."
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
            <p role="status" className="text-sm text-fg-muted" data-testid="no-patient-read">
              This login cannot open the patient record, so the identity banner and the allergy strip are not
              available here. Confirm the patient by name and UHID against the OP slip before you record
              anything.
            </p>
          )}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-4">
              <VitalsEntryPad
                state={form}
                verdicts={verdicts}
                bandsAvailable={ranges !== null}
                disabled={save.isPending}
                onChange={(next) => {
                  setForm(next);
                  // A changed body needs a new key: replaying the old one with
                  // different content is refused, and rightly so.
                  setSaveKey(newIdempotencyKey());
                }}
              />

              {problems.length === 0 ? null : (
                // The live region is the wrapper: `role="alert"` on a `<ul>`
                // replaces its list role and orphans every `<li>` inside it.
                <div role="alert" data-testid="vitals-problems">
                  <ul className="flex flex-col gap-1">
                    {problems.map((message) => (
                      <li key={message} className="text-sm text-danger-on-surface">
                        {message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {save.isError ? (
                <ProblemCard
                  error={save.error}
                  onRetry={() => {
                    save.mutate();
                  }}
                  retryLabel="Try saving again"
                />
              ) : null}

              {saved === null ? null : (
                <section
                  className="rounded-lg border border-strong bg-layer-1 p-4"
                  data-testid="saved-observation"
                >
                  <h2 className="text-md font-medium text-fg-default">
                    Saved at {formatInstant(saved.recorded_at)}
                  </h2>
                  <p className="mt-1 text-sm text-fg-muted">
                    These are the server’s verdicts, applied against the hospital’s effective bands. They are
                    what raised any alert below.
                  </p>
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {VITALS_FIELDS.map((field) => {
                      const parameter = field.parameter;
                      if (parameter === null) return null;
                      const flag = saved.flags[parameter];
                      const value = savedValueFor(saved, field.key);
                      if (value === null) return null;
                      return (
                        <li key={field.key}>
                          <FlagChip
                            flag={
                              flag === 'critical' || flag === 'abnormal' || flag === 'normal' ? flag : null
                            }
                            label={`${field.label} ${value} ${field.unit}`}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {saved === null ? null : (
                <CriticalActionPrompt
                  alerts={saved.alerts}
                  parameters={criticalParameters}
                  canAcknowledge={canAcknowledge}
                  acknowledging={acknowledge.isPending}
                  onAcknowledge={(alertId, action, note) => {
                    acknowledge.mutate({ vitalsId: saved.id, alertId, action, note });
                  }}
                />
              )}
            </div>

            <aside className="flex flex-col gap-3" aria-label="Recent readings">
              <h2 className="text-sm font-medium text-fg-default">Last readings</h2>
              {canReadHistory ? (
                <AsyncPanel
                  loading={historyQuery.isLoading}
                  error={historyQuery.error}
                  isEmpty={history.length === 0}
                  skeletonLabel="Loading earlier readings"
                  skeletonRows={3}
                  onRetry={() => void historyQuery.refetch()}
                  empty={
                    <EmptyState
                      cause="No earlier observation on file for this patient."
                      nextAction="This will be their first recorded set."
                    />
                  }
                >
                  <div className="flex flex-col gap-3">
                    <VitalsSparkline points={trendFor('systolic')} label="Systolic BP" unit="mmHg" />
                    <VitalsSparkline points={trendFor('pulse')} label="Pulse" unit="/min" />
                    <VitalsSparkline points={trendFor('spo2')} label="SpO₂" unit="%" />
                    <ul className="flex flex-col gap-1">
                      {history.slice(0, 5).map((row) => (
                        <li key={row.id} className="flex items-center justify-between gap-2 text-2xs">
                          <span className="text-fg-muted">{formatInstant(row.recorded_at)}</span>
                          <FlagChip
                            flag={
                              row.overall_flag === 'critical' ||
                              row.overall_flag === 'abnormal' ||
                              row.overall_flag === 'normal'
                                ? row.overall_flag
                                : null
                            }
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                </AsyncPanel>
              ) : (
                <p className="text-2xs text-fg-muted">
                  This login cannot read earlier observations, so no trend is shown.
                </p>
              )}
            </aside>
          </div>
        </>
      )}

      <ShortcutBar shortcuts={shortcuts} label={VITALS_STATION_HINTS} />
    </section>
  );
}

/** The saved value for one form field, as text, straight from the record. */
function savedValueFor(record: VitalsDetail, key: string): string | null {
  switch (key) {
    case 'systolic':
      return record.systolic === null ? null : String(record.systolic);
    case 'diastolic':
      return record.diastolic === null ? null : String(record.diastolic);
    case 'pulse':
      return record.pulse === null ? null : String(record.pulse);
    case 'spo2':
      return record.spo2 === null ? null : String(record.spo2);
    case 'temperatureC':
      return record.temperature_c;
    case 'respRate':
      return record.resp_rate === null ? null : String(record.resp_rate);
    case 'glucoseMgdl':
      return record.glucose_mgdl;
    case 'heightCm':
      return record.height_cm;
    case 'weightKg':
      return record.weight_kg;
    case 'painScore':
      return record.pain_score === null ? null : String(record.pain_score);
    default:
      return null;
  }
}
