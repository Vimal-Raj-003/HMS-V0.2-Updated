'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { InvestigationsPane } from '@/features/specialty/components/investigations-pane';
import { SpecialtyWorklist } from '@/features/specialty/components/specialty-worklist';
import { useSession } from '@/lib/session-context';
import { deliverPhototherapySession, getBiopsies, getLesions, getPhototherapyCourses } from '../api/client';
import { consoleKeys } from '../api/keys';
import type { PhototherapyCourseRow } from '../api/types';

const LANES = [
  { key: 'triage', label: 'Triage' },
  { key: 'doctor', label: 'Doctor' },
  { key: 'procedure', label: 'Procedure' },
  { key: 'phototherapy', label: 'Phototherapy' },
  { key: 'counselling', label: 'Counselling' },
] as const;

interface OpenPatient {
  readonly encounterId: string;
  readonly patientId: string;
  readonly label: string;
}

/**
 * OP-027 — the dermatology console.
 *
 * ── Two rails, and both of them are about somebody being forgotten ──────────
 *
 * The malignant biopsies with no follow-up sit at the top, because a skin
 * cancer report that was read and filed is the commonest dermatology claim and
 * it is invisible on any ordinary worklist. Below them, the phototherapy cabin.
 *
 * ── The dose box starts at the right number ─────────────────────────────────
 *
 * `suggestedNextDoseMj` is the API's, and so is the sentence explaining it: the
 * increment, clipped at the ceiling, held flat after erythema. The technician
 * sees the right dose rather than typing a wrong one and being refused — but
 * the field is still editable, because the refusal is in the database and a
 * pre-filled box that cannot be changed is a box that hides a real clinical
 * decision.
 */
export function DermatologyScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = consoleKeys(hospitalId);
  const qc = useQueryClient();

  const [open, setOpen] = useState<OpenPatient | null>(null);
  const [delivering, setDelivering] = useState<string | null>(null);

  const awaiting = useQuery({
    queryKey: keys.biopsies('open'),
    queryFn: ({ signal }) => getBiopsies({ openOnly: true }, { signal }),
    refetchInterval: 120_000,
  });

  const courses = useQuery({
    queryKey: keys.courses(open?.patientId ?? 'active'),
    queryFn: ({ signal }) =>
      getPhototherapyCourses(open === null ? { openOnly: true } : { patientId: open.patientId }, { signal }),
    refetchInterval: 120_000,
  });

  const lesions = useQuery({
    queryKey: keys.lesions(open?.patientId ?? 'none'),
    queryFn: ({ signal }) => getLesions({ patientId: open?.patientId ?? '' }, { signal }),
    enabled: open !== null,
  });

  const deliver = useMutation({
    mutationFn: (input: { courseId: string; doseMj: number; erythemaGrade: number }) =>
      deliverPhototherapySession(input.courseId, {
        doseMj: input.doseMj,
        erythemaGrade: input.erythemaGrade,
      }),
    onSuccess: () => {
      setDelivering(null);
      void qc.invalidateQueries({ queryKey: keys.coursesRoot() });
    },
  });

  const malignant = (awaiting.data ?? []).filter((b) => b.awaitingFollowup);
  const courseRows = courses.data ?? [];

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Dermatology"
        description="Lesions followed across visits, biopsies waiting on somebody, and the phototherapy cabin."
      />

      {malignant.length > 0 ? (
        <section
          aria-label="Malignant biopsies awaiting a follow-up"
          className="rounded-lg border border-danger bg-danger-subtle p-4"
        >
          <h2 className="text-sm font-semibold text-fg-danger">
            {malignant.length} malignant {malignant.length === 1 ? 'report has' : 'reports have'} no follow-up
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            These cannot be closed until a follow-up is attached. A report that was read and then filed is
            indistinguishable, afterwards, from one nobody opened.
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {malignant.map((biopsy) => (
              <li
                key={biopsy.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-danger bg-layer-1 p-3"
              >
                <Badge tone="danger">{biopsy.type}</Badge>
                <span className="font-mono text-xs">{biopsy.specimenNo ?? 'no accession'}</span>
                <span>{biopsy.resultSummary ?? 'awaiting the report'}</span>
                {biopsy.margins === null ? null : (
                  <span className="text-fg-muted">margins {biopsy.margins}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <SpecialtyWorklist
        consoleCode="DERM"
        lanes={LANES}
        onOpen={(row) => {
          setOpen({
            encounterId: row.encounterId,
            patientId: row.patientId,
            label: row.patientName,
          });
        }}
      />

      <section aria-label="Phototherapy" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">
          {open === null ? 'Active phototherapy courses' : `Phototherapy — ${open.label}`}
        </h2>
        <AsyncPanel
          loading={courses.isPending}
          error={courses.error}
          isEmpty={courseRows.length === 0}
          skeletonLabel="Loading phototherapy courses"
          skeletonRows={4}
          onRetry={() => void courses.refetch()}
          empty={
            <EmptyState
              cause="No phototherapy course is running."
              nextAction="A prescriber sets the starting dose, the increment, the ceiling and the shielding before the first session."
            />
          }
        >
          <ul className="flex flex-col gap-3">
            {courseRows.map((course) => (
              <li key={course.id} className="rounded-md border border-default bg-layer-1 p-3">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <Badge tone="accent">{course.modality.toUpperCase()}</Badge>
                  <span>
                    Fitzpatrick {'I'.repeat(Math.min(course.skinType, 3))}
                    {course.skinType > 3 ? `V${'I'.repeat(course.skinType - 4)}` : ''}
                  </span>
                  <span className="text-fg-muted">
                    session {course.sessionsCount + 1} · +{course.incrementPct}% per step · ceiling{' '}
                    {course.maxDoseMj} mJ/cm²
                  </span>
                  <Badge tone="neutral">
                    {course.cumulativeDoseMj.toLocaleString('en-IN')} mJ/cm² cumulative
                  </Badge>
                </div>

                {delivering === course.id ? (
                  <DeliverForm
                    course={course}
                    pending={deliver.isPending}
                    onCancel={() => setDelivering(null)}
                    onSubmit={(doseMj, erythemaGrade) => {
                      deliver.mutate({ courseId: course.id, doseMj, erythemaGrade });
                    }}
                  />
                ) : (
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <Button size="sm" onClick={() => setDelivering(course.id)}>
                      Deliver a session
                    </Button>
                    <span className="text-xs text-fg-muted">{course.suggestionReason}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </AsyncPanel>
      </section>

      {open === null ? null : (
        <>
          <section aria-label="Lesions" className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Lesions — {open.label}</h2>
            <AsyncPanel
              loading={lesions.isPending}
              error={lesions.error}
              isEmpty={(lesions.data ?? []).length === 0}
              skeletonLabel="Loading lesions"
              skeletonRows={4}
              onRetry={() => void lesions.refetch()}
              empty={
                <EmptyState
                  cause="No lesion has been mapped for this patient."
                  nextAction="Map one so that “it has changed” becomes a query rather than a memory."
                />
              }
            >
              <ul className="flex flex-col gap-2 text-sm">
                {(lesions.data ?? []).map((lesion) => (
                  <li
                    key={lesion.id}
                    className="flex flex-wrap items-center gap-3 rounded-md border border-default bg-layer-1 p-3"
                  >
                    <span className="font-mono text-xs">#{lesion.lesionNo}</span>
                    <span>{lesion.regionKey.replace(/_/g, ' ')}</span>
                    <span className="text-fg-muted">{lesion.morphology}</span>
                    {lesion.sizeMm === null ? null : <span>{lesion.sizeMm} mm</span>}
                    {/* Growth since the first recorded size. The most useful
                        number on a pigmented lesion, and the one nobody works
                        out by hand across two visits a year apart. */}
                    {lesion.growthMm !== null && lesion.growthMm > 0 ? (
                      <Badge tone="warning">grown {lesion.growthMm} mm</Badge>
                    ) : null}
                    {lesion.sensitive ? <Badge tone="neutral">sensitive site</Badge> : null}
                    <Badge tone={lesion.status === 'monitor' ? 'info' : 'neutral'}>{lesion.status}</Badge>
                    <span className="text-fg-muted">
                      {lesion.observationCount} observation
                      {lesion.observationCount === 1 ? '' : 's'}
                    </span>
                  </li>
                ))}
              </ul>
            </AsyncPanel>
          </section>

          <InvestigationsPane consoleCode="DERM" encounterId={open.encounterId} patientId={open.patientId} />
        </>
      )}
    </section>
  );
}

/**
 * One session under the lamps.
 *
 * The dose starts at what the protocol says and stays editable — the ceiling and
 * the post-erythema hold are enforced by the database, not by disabling a field,
 * so a clinician who has a reason to give less can.
 */
function DeliverForm({
  course,
  pending,
  onCancel,
  onSubmit,
}: {
  readonly course: PhototherapyCourseRow;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (doseMj: number, erythemaGrade: number) => void;
}): React.JSX.Element {
  const [dose, setDose] = useState(String(course.suggestedNextDoseMj ?? course.startDoseMj));
  const [grade, setGrade] = useState('0');

  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(Number(dose), Number(grade));
      }}
    >
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Dose (mJ/cm²)</span>
        <input
          className="w-32 rounded border border-control bg-layer-1 px-2 py-1 text-sm"
          type="number"
          min={1}
          max={course.maxDoseMj}
          step={1}
          value={dose}
          onChange={(event) => setDose(event.target.value)}
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Erythema afterwards</span>
        <select
          className="rounded border border-control bg-layer-1 px-2 py-1 text-sm"
          value={grade}
          onChange={(event) => setGrade(event.target.value)}
        >
          <option value="0">0 — none</option>
          <option value="1">1 — faint</option>
          <option value="2">2 — well defined</option>
          <option value="3">3 — painful</option>
          <option value="4">4 — blistering</option>
        </select>
      </label>
      <Button type="submit" size="sm" disabled={pending}>
        Record session
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <p className="basis-full text-xs text-fg-muted">{course.suggestionReason}</p>
    </form>
  );
}
