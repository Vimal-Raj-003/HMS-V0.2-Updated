'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { InvestigationsPane } from '@/features/specialty/components/investigations-pane';
import { SpecialtyWorklist } from '@/features/specialty/components/specialty-worklist';
import { useSession } from '@/lib/session-context';
import { getAudiologyTest, getAudiologyTests } from '../api/client';
import { consoleKeys } from '../api/keys';
import type { AudiologyTestDetail, ThresholdRow } from '../api/types';

const LANES = [
  { key: 'triage', label: 'Triage' },
  { key: 'audiology', label: 'Booth' },
  { key: 'doctor', label: 'Doctor' },
  { key: 'endoscopy', label: 'Endoscopy' },
  { key: 'counselling', label: 'Counselling' },
] as const;

/** The frequencies a pure-tone audiogram is drawn on, left to right. */
const FREQUENCIES = [125, 250, 500, 1000, 2000, 4000, 8000] as const;

interface OpenPatient {
  readonly encounterId: string;
  readonly patientId: string;
  readonly label: string;
}

/**
 * OP-028 — the ENT and audiology console.
 *
 * ── The audiogram is a table, and the table is the graph ────────────────────
 *
 * A canvas audiogram is prettier and unreadable by a screen reader, unprintable
 * at a sensible size, and impossible to correct a single point on. The grid
 * here is the record: one row per ear and conduction, one column per frequency,
 * with the derived average and degree beside it. A clinic that wants the
 * classic symbols prints the report; the working view is the numbers.
 *
 * ── The air-bone gap is shown, and its impossible value cannot be entered ───
 *
 * A negative gap is refused at entry by the database, where the technician can
 * still repeat the frequency. What the screen adds is the *positive* gap, which
 * is the finding — a conductive loss is a gap, and seeing it beside the degree
 * is what the report is for.
 */
export function AudiologyScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = consoleKeys(hospitalId);

  const [open, setOpen] = useState<OpenPatient | null>(null);
  const [testId, setTestId] = useState<string | null>(null);

  const tests = useQuery({
    queryKey: keys.audiologyTests(open?.patientId ?? 'open'),
    queryFn: ({ signal }) =>
      getAudiologyTests(open === null ? { openOnly: true } : { patientId: open.patientId }, { signal }),
    refetchInterval: 60_000,
  });

  const detail = useQuery({
    queryKey: keys.audiologyTest(testId ?? 'none'),
    queryFn: ({ signal }) => getAudiologyTest(testId ?? '', { signal }),
    enabled: testId !== null,
  });

  const rows = tests.data ?? [];

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="ENT & audiology"
        description="The booth, the audiogram and the aids that go home — the four-frequency average and the degree of loss derived from the thresholds."
      />

      <SpecialtyWorklist
        consoleCode="ENT"
        lanes={LANES}
        onOpen={(row) => {
          setOpen({
            encounterId: row.encounterId,
            patientId: row.patientId,
            label: row.patientName,
          });
          setTestId(null);
        }}
      />

      <section aria-label="Audiology tests" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">
          {open === null ? 'Tests in the booth' : `Tests — ${open.label}`}
        </h2>
        <AsyncPanel
          loading={tests.isPending}
          error={tests.error}
          isEmpty={rows.length === 0}
          skeletonLabel="Loading audiology tests"
          skeletonRows={5}
          onRetry={() => void tests.refetch()}
          empty={
            <EmptyState
              cause="Nothing is running in the booth."
              nextAction="Open a test against a patient to start entering thresholds."
            />
          }
        >
          <ul className="flex flex-col gap-2">
            {rows.map((test) => (
              <li key={test.id}>
                <button
                  type="button"
                  onClick={() => setTestId(test.id)}
                  aria-pressed={testId === test.id}
                  className="flex w-full flex-wrap items-center gap-3 rounded-md border border-default bg-layer-1 p-3 text-left text-sm hover:bg-layer-3 aria-pressed:border-accent-border aria-pressed:bg-accent-surface"
                >
                  <Badge tone="neutral">{test.testType.toUpperCase()}</Badge>
                  <span className="font-mono text-xs">{new Date(test.performedAt).toLocaleString()}</span>
                  <span className="text-fg-muted">{test.boothId ?? 'booth not recorded'}</span>
                  {/* The whole basis of an audiometric number. Without it the
                      test can be run and never signed. */}
                  {test.calibrationOk ? null : <Badge tone="warning">not calibrated</Badge>}
                  <Badge tone={test.signedAt === null ? 'neutral' : 'success'}>{test.status}</Badge>
                </button>
              </li>
            ))}
          </ul>
        </AsyncPanel>
      </section>

      {testId === null ? null : (
        <AsyncPanel
          loading={detail.isPending}
          error={detail.error}
          isEmpty={detail.data === undefined}
          skeletonLabel="Loading the audiogram"
          skeletonRows={4}
          onRetry={() => void detail.refetch()}
          empty={
            <EmptyState
              cause="That test could not be opened."
              nextAction="Choose another test from the list above."
            />
          }
        >
          {detail.data === undefined ? null : <Audiogram detail={detail.data} />}
        </AsyncPanel>
      )}

      {open === null ? null : (
        <InvestigationsPane consoleCode="ENT" encounterId={open.encounterId} patientId={open.patientId} />
      )}
    </section>
  );
}

function Audiogram({ detail }: { readonly detail: AudiologyTestDetail }): React.JSX.Element {
  const at = (ear: string, conduction: string, freqHz: number): ThresholdRow | undefined =>
    detail.thresholds.find((t) => t.ear === ear && t.conduction === conduction && t.freqHz === freqHz);

  return (
    <section aria-label="Audiogram" className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <caption className="sr-only">
            Thresholds in decibels hearing level. A masked threshold is marked; no response at the limit of
            the audiometer is shown as NR rather than as a number.
          </caption>
          <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
            <tr>
              <th scope="col" className="py-2">
                Ear / conduction
              </th>
              {FREQUENCIES.map((f) => (
                <th key={f} scope="col" className="text-right">
                  {f >= 1000 ? `${f / 1000}k` : f}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(
              [
                ['right', 'ac', 'Right · air'],
                ['right', 'bc', 'Right · bone'],
                ['left', 'ac', 'Left · air'],
                ['left', 'bc', 'Left · bone'],
              ] as const
            ).map(([ear, conduction, label]) => (
              <tr key={label} className="border-t border-default">
                <th scope="row" className="py-2 text-left font-medium">
                  {label}
                </th>
                {FREQUENCIES.map((freqHz) => {
                  const point = at(ear, conduction, freqHz);
                  return (
                    <td key={freqHz} className="text-right font-mono">
                      {point === undefined ? (
                        <span className="text-fg-muted">·</span>
                      ) : point.noResponse ? (
                        <span title="No response at the limit of the audiometer">NR</span>
                      ) : (
                        <>
                          {point.thresholdDb}
                          {point.masked ? <span title="Masked">*</span> : null}
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-2">
        {detail.results.map((result) => (
          <li
            key={result.id}
            className="flex flex-wrap items-center gap-3 rounded-md border border-default bg-layer-1 p-3 text-sm"
          >
            <span className="font-medium capitalize">{result.ear} ear</span>
            {/* All three derived from the thresholds above. A disability
                certificate, a hearing-aid subsidy and a school placement are
                issued on them, so there is nowhere to type them. */}
            <Badge tone="accent">PTA {result.ptaAvg ?? '—'} dB</Badge>
            {result.degree === null ? null : <Badge tone="neutral">{result.degree}</Badge>}
            {result.type === null ? null : <Badge tone="neutral">{result.type}</Badge>}
            {result.airBoneGapDb === null ? null : (
              <span className="text-fg-muted">air-bone gap {result.airBoneGapDb} dB</span>
            )}
            {result.sdsPct === null ? null : (
              <span className="text-fg-muted">discrimination {result.sdsPct}%</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
