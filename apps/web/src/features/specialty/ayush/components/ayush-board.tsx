'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getConsults, getCourses, getHeavyMetalLimits, getRegistrations, getSessions } from '../api/client';
import { ayushKeys } from '../api/keys';
import type { AyushCourseRow, AyushRegistrationRow, AyushSessionRow } from '../api/types';

const SYSTEM_LABELS: Readonly<Record<string, string>> = {
  ayurveda: 'Ayurveda',
  homoeopathy: 'Homoeopathy',
  unani: 'Unani',
  siddha: 'Siddha',
  yoga_naturopathy: 'Yoga & Naturopathy',
};

const PHASE_LABELS: Readonly<Record<string, string>> = {
  purva: 'Purvakarma — preparation',
  pradhana: 'Pradhana karma — the main procedure',
  paschat: 'Paschat karma — recovery',
};

/**
 * OP-037 — the AYUSH board.
 *
 * ── The registrations are on the screen, not in a settings page ────────────
 *
 * A council registration is the boundary on what a practitioner may do here,
 * and the way it fails is a renewal nobody chased. So the lapsed and
 * nearly-lapsed ones sit at the top: by the time the console refuses a
 * consultation, the patient is already in the room.
 *
 * ── And a course says what is stopping it before anybody undresses ─────────
 *
 * `blockedBy` on a course is the same set of facts the database checks —
 * oleation, consent, an unreviewed adverse event. A therapist who learns at the
 * door has already brought the patient in.
 */
export function AyushBoard(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = ayushKeys(hospitalId);
  const [openCourse, setOpenCourse] = useState<string | null>(null);

  const registrations = useQuery({
    queryKey: keys.registrations('all'),
    queryFn: ({ signal }) => getRegistrations({}, { signal }),
    refetchInterval: 3_600_000,
  });

  const consults = useQuery({
    queryKey: keys.consults('unsigned'),
    queryFn: ({ signal }) => getConsults({ unsignedOnly: true }, { signal }),
    refetchInterval: 120_000,
  });

  const courses = useQuery({
    queryKey: keys.courses('open'),
    queryFn: ({ signal }) => getCourses({ openOnly: true }, { signal }),
    refetchInterval: 120_000,
  });

  const limits = useQuery({
    queryKey: keys.limits,
    queryFn: ({ signal }) => getHeavyMetalLimits({ signal }),
    staleTime: 3_600_000,
  });

  const courseRows = courses.data ?? [];
  const selected = openCourse ?? courseRows[0]?.id ?? null;

  const sessions = useQuery({
    queryKey: keys.sessions(selected ?? 'none'),
    queryFn: ({ signal }) => (selected === null ? Promise.resolve([]) : getSessions(selected, { signal })),
    enabled: selected !== null,
    refetchInterval: 120_000,
  });

  const regRows = registrations.data ?? [];
  // Lapsed first, then expiring within ninety days: the failure mode of a
  // register is a renewal nobody chased.
  const attention = regRows
    .filter((r) => !r.live || (r.daysRemaining !== null && r.daysRemaining < 90))
    .sort((a, b) => (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0));
  const consultRows = consults.data ?? [];
  const sessionRows = sessions.data ?? [];
  const stopped = courseRows.filter((c) => !c.readyForPradhana);

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="AYUSH"
        description="Five systems India regulates as medicine. The boundary on all five is a council registration, and the boundary inside Panchakarma is the oleation before the procedure."
      />

      {attention.length > 0 ? (
        <section
          aria-label="Registrations needing attention"
          className="rounded-lg border border-warning-border bg-warning-surface p-4"
        >
          <h2 className="text-sm font-semibold text-warning-on-surface">
            {attention.length} {attention.length === 1 ? 'registration needs' : 'registrations need'}{' '}
            attention
          </h2>
          <p className="mt-1 text-xs text-warning-on-surface">
            A lapsed registration is not a registration, and the console will refuse the consultation rather
            than warn about it. By then the patient is in the room.
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {attention.map((row) => (
              <RegistrationLine key={row.id} row={row} />
            ))}
          </ul>
        </section>
      ) : null}

      {stopped.length > 0 ? (
        <section aria-label="Courses that cannot proceed" className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Courses that cannot proceed today</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {stopped.map((course) => (
              <li
                key={course.id}
                className="flex flex-col gap-1 rounded-md border border-danger-border bg-danger-surface p-3"
              >
                <span className="font-medium">{course.name}</span>
                <ul className="flex flex-col gap-0.5 text-xs text-fg-danger">
                  {course.blockedBy.map((why) => (
                    <li key={why}>{why}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Open courses" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Therapy courses</h2>
        <AsyncPanel
          loading={courses.isPending}
          error={courses.error}
          isEmpty={courseRows.length === 0}
          skeletonLabel="Loading therapy courses"
          skeletonRows={3}
          onRetry={() => void courses.refetch()}
          empty={
            <EmptyState
              cause="No course is running."
              nextAction="Plan one from a signed consultation. The day plan becomes the therapy worklist in the same step, so there is nothing to transcribe."
            />
          }
        >
          <ul className="flex flex-col gap-2 text-sm">
            {courseRows.map((course) => (
              <li key={course.id}>
                <button
                  type="button"
                  onClick={() => {
                    setOpenCourse(course.id);
                  }}
                  aria-pressed={selected === course.id}
                  className={`flex w-full flex-wrap items-center gap-3 rounded-md border p-3 text-left ${
                    selected === course.id
                      ? 'border-accent-border bg-accent-surface'
                      : 'border-default bg-layer-1'
                  }`}
                >
                  <Badge tone="neutral">{SYSTEM_LABELS[course.system] ?? course.system}</Badge>
                  <span className="flex-1 truncate font-medium">{course.name}</span>
                  <span className="text-xs text-fg-muted">
                    {course.sessionsDone} of {course.sessionsPlanned} done
                  </span>
                  <ReadyChip course={course} />
                </button>
              </li>
            ))}
          </ul>
        </AsyncPanel>
      </section>

      {selected === null ? null : (
        <section aria-label="Course sessions" className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Day plan</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {sessionRows.map((session) => (
              <SessionLine key={session.id} session={session} />
            ))}
            {sessionRows.length === 0 ? (
              <li className="text-xs text-fg-muted">No sessions scheduled.</li>
            ) : null}
          </ul>
        </section>
      )}

      <section aria-label="Unsigned consultations" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Unsigned consultations</h2>
        <ul className="flex flex-col gap-2 text-sm">
          {consultRows.map((consult) => (
            <li
              key={consult.id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-default bg-layer-1 p-3"
            >
              <Badge tone="neutral">{SYSTEM_LABELS[consult.system] ?? consult.system}</Badge>
              <span className="text-xs text-fg-muted">{consult.prescriptionLines} prescribed</span>
              {consult.blockedBy.length > 0 ? (
                <span className="text-xs text-fg-danger">{consult.blockedBy.join('; ')}</span>
              ) : (
                <Badge tone="success">ready to sign</Badge>
              )}
            </li>
          ))}
          {consultRows.length === 0 ? <li className="text-xs text-fg-muted">Everything is signed.</li> : null}
        </ul>
      </section>

      {limits.data === undefined ? null : (
        <p className="text-xs text-fg-muted">
          Heavy-metal preparations — Rasa aushadhi and Bhasmas — run to at most {limits.data.maxDays} days in
          one line, and past {limits.data.monitoringAfterDays} days need liver and kidney monitoring recorded
          against the prescription. Both are the formulary&rsquo;s, not the prescriber&rsquo;s.
        </p>
      )}
    </section>
  );
}

function ReadyChip({ course }: { readonly course: AyushCourseRow }): React.JSX.Element {
  return course.readyForPradhana ? (
    <Badge tone="success">ready</Badge>
  ) : (
    <Badge tone="danger">{course.blockedBy.length} blocking</Badge>
  );
}

function RegistrationLine({ row }: { readonly row: AyushRegistrationRow }): React.JSX.Element {
  const days = row.daysRemaining;
  const clock =
    days === null
      ? 'no expiry recorded'
      : days < 0
        ? `lapsed ${String(Math.abs(days))} days ago`
        : `expires in ${String(days)} days`;

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-warning-border bg-layer-1 p-3">
      <Badge tone={row.live ? 'warning' : 'danger'}>{SYSTEM_LABELS[row.system] ?? row.system}</Badge>
      <span className="font-mono text-xs">{row.registrationNo}</span>
      <span className="text-fg-muted">{row.council.toUpperCase()}</span>
      <span className="text-xs text-fg-muted">{clock}</span>
    </li>
  );
}

/**
 * One therapy session.
 *
 * The phase is shown because it is what the oleation rule turns on, and a
 * reader should be able to see which day is the pradhana karma without opening
 * anything.
 */
function SessionLine({ session }: { readonly session: AyushSessionRow }): React.JSX.Element {
  const tone = session.status === 'done' ? 'success' : session.status === 'skipped' ? 'neutral' : 'warning';

  return (
    <li
      className={`flex flex-wrap items-center gap-3 rounded-md border p-3 ${
        session.blocksCourse ? 'border-danger-border bg-danger-surface' : 'border-default bg-layer-1'
      }`}
    >
      <span className="font-mono text-xs text-fg-muted">day {session.dayNo}</span>
      <span className="flex-1 truncate">{session.procedureName ?? session.procedureCode}</span>
      {session.phase === null ? null : (
        <span className="text-xs text-fg-muted" title={PHASE_LABELS[session.phase] ?? session.phase}>
          {session.phase}
        </span>
      )}
      {session.lakshana === null ? null : (
        <Badge tone={session.lakshana === 'samyak' ? 'success' : 'warning'}>{session.lakshana}</Badge>
      )}
      {session.genderWaiverConsentId === null ? null : <Badge tone="neutral">gender waived by consent</Badge>}
      <Badge tone={tone}>{session.status}</Badge>
      {session.blocksCourse ? (
        <span className="text-xs text-fg-danger">
          adverse event awaiting a physician&rsquo;s review — the course is stopped
        </span>
      ) : null}
    </li>
  );
}
