'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button } from '@vims/ui';
import { useState } from 'react';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { specialtyKeys } from '@/features/specialty/api/keys';
import { dilate, recordAcuities, recordIop, recordRefractions } from '../api/client';
import { ophthaKeys } from '../api/keys';
import type { VisitDetail } from '../api/types';

const cell = 'h-10 w-full rounded-md border border-control bg-layer-1 px-2 text-sm text-fg-default';

/** OD is the right eye, OS the left. Stored as right/left; written as an eye doctor writes it. */
const EYES = [
  { key: 'right', label: 'OD (right)' },
  { key: 'left', label: 'OS (left)' },
] as const;

const ACUITY_LADDER = ['6/6', '6/9', '6/12', '6/18', '6/24', '6/36', '6/60'] as const;
const BELOW_THE_CHART = [
  { notation: 'cf', value: 'CF 1m', label: 'CF' },
  { notation: 'hm', value: 'HM', label: 'HM' },
  { notation: 'pl', value: 'PL', label: 'PL' },
  { notation: 'nlp', value: 'NLP', label: 'NLP' },
] as const;

interface EyeEntry {
  ucva: string;
  bcva: string;
  sph: string;
  cyl: string;
  axis: string;
  add: string;
  iop: string;
}

const EMPTY: EyeEntry = { ucva: '', bcva: '', sph: '', cyl: '', axis: '', add: '', iop: '' };

function toNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The refraction lane (OP-025 §8.2).
 *
 * ── One column per eye, never a shared row ──────────────────────────────────
 *
 * The grid has an OD column and an OS column and no way to fill both at once.
 * "Both eyes 6/6" is two measurements that agree today, and the day they stop
 * agreeing a shared row has nowhere to put the difference — the database
 * refuses it, and this is the screen not offering it.
 *
 * ── The stepper moves in quarters ───────────────────────────────────────────
 *
 * Every trial set and every grinding lab works in 0.25 D. The buttons step by
 * a quarter so the common case never involves typing, and a typed −2.13 is
 * refused before it reaches the optician.
 *
 * ── The acuity ladder has a bottom ──────────────────────────────────────────
 *
 * Below 6/60 there is no fraction: counting fingers, hand movements, perception
 * of light, none. They are buttons because they are the readings taken under
 * the most pressure, on the eyes that are worst.
 */
export function RefractionPanel({ detail }: { readonly detail: VisitDetail }): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = ophthaKeys(hospitalId);
  const specialty = specialtyKeys(hospitalId);
  const client = useQueryClient();
  const visitId = detail.visit.id;

  const [entry, setEntry] = useState<Record<string, EyeEntry>>({ right: { ...EMPTY }, left: { ...EMPTY } });
  const [drug, setDrug] = useState('Tropicamide 1% + Phenylephrine 5%');

  function invalidate(): void {
    void client.invalidateQueries({ queryKey: keys.visit(visitId) });
    void client.invalidateQueries({ queryKey: keys.visitsRoot() });
    void client.invalidateQueries({ queryKey: specialty.worklistRoot() });
  }

  function patch(eye: string, field: keyof EyeEntry, value: string): void {
    setEntry({ ...entry, [eye]: { ...(entry[eye] ?? EMPTY), [field]: value } });
  }

  function step(eye: string, field: 'sph' | 'cyl' | 'add', delta: number): void {
    const current = toNumber(entry[eye]?.[field] ?? '') ?? 0;
    patch(eye, field, (current + delta).toFixed(2));
  }

  const save = useMutation({
    mutationFn: async () => {
      const acuities = EYES.flatMap(({ key }) => {
        const e = entry[key] ?? EMPTY;
        return [
          ...(e.ucva === ''
            ? []
            : [{ eye: key, context: 'ucva', notation: notationFor(e.ucva), value: e.ucva }]),
          ...(e.bcva === ''
            ? []
            : [{ eye: key, context: 'bcva', notation: notationFor(e.bcva), value: e.bcva }]),
        ];
      });
      if (acuities.length > 0) await recordAcuities(visitId, acuities);

      const refractions = EYES.flatMap(({ key }) => {
        const e = entry[key] ?? EMPTY;
        const sph = toNumber(e.sph);
        const cyl = toNumber(e.cyl);
        const axis = toNumber(e.axis);
        const add = toNumber(e.add);
        if (sph === undefined && cyl === undefined && add === undefined) return [];
        return [
          {
            eye: key,
            kind: 'subjective',
            ...(sph === undefined ? {} : { sph }),
            ...(cyl === undefined ? {} : { cyl }),
            ...(axis === undefined ? {} : { axis }),
            ...(add === undefined ? {} : { add }),
            source: 'manual',
          },
        ];
      });
      if (refractions.length > 0) await recordRefractions(visitId, refractions);

      const pressures = EYES.flatMap(({ key }) => {
        const value = toNumber(entry[key]?.iop ?? '');
        return value === undefined
          ? []
          : [{ eye: key, method: 'nct', valueMmhg: value, postDilation: detail.visit.dilatedAt !== null }];
      });
      if (pressures.length > 0) await recordIop(visitId, pressures);
    },
    onSuccess: () => {
      setEntry({ right: { ...EMPTY }, left: { ...EMPTY } });
      invalidate();
    },
  });

  const drops = useMutation({
    mutationFn: () => dilate(visitId, { drug, cycloplegic: false }),
    onSuccess: invalidate,
  });

  const urgent = detail.iop.filter((r) => r.band === 'urgent');

  return (
    <section className="flex flex-col gap-4">
      {urgent.length > 0 ? (
        <div
          className="rounded-lg border border-danger bg-danger-subtle p-3 text-sm text-fg-danger"
          role="alert"
          data-testid="iop-alert"
        >
          {`Pressure ${urgent.map((r) => `${r.eye === 'right' ? 'OD' : 'OS'} ${String(r.valueMmhg)}`).join(', ')} mmHg. The doctor has been alerted; do not let the patient leave without being seen.`}
        </div>
      ) : null}

      {granted.has('ophtha.optometry.record') ? (
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="refraction-grid">
            <caption className="sr-only">Refraction, one column per eye</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                <th scope="col" className="px-3 py-2 text-start">
                  &nbsp;
                </th>
                {EYES.map((e) => (
                  <th key={e.key} scope="col" className="px-3 py-2 text-start">
                    {e.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-default">
                <th scope="row" className="px-3 py-2 text-start text-2xs text-fg-muted">
                  Unaided
                </th>
                {EYES.map((e) => (
                  <td key={e.key} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <input
                        className={`${cell} w-24`}
                        aria-label={`Unaided acuity ${e.label}`}
                        value={entry[e.key]?.ucva ?? ''}
                        onChange={(ev) => {
                          patch(e.key, 'ucva', ev.target.value);
                        }}
                      />
                      {ACUITY_LADDER.map((v) => (
                        <Button
                          key={v}
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            patch(e.key, 'ucva', v);
                          }}
                        >
                          {v}
                        </Button>
                      ))}
                      {BELOW_THE_CHART.map((b) => (
                        <Button
                          key={b.label}
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            patch(e.key, 'ucva', b.value);
                          }}
                        >
                          {b.label}
                        </Button>
                      ))}
                    </div>
                  </td>
                ))}
              </tr>
              <tr className="border-b border-default">
                <th scope="row" className="px-3 py-2 text-start text-2xs text-fg-muted">
                  Best corrected
                </th>
                {EYES.map((e) => (
                  <td key={e.key} className="px-3 py-2">
                    <input
                      className={`${cell} w-28`}
                      aria-label={`Best corrected acuity ${e.label}`}
                      value={entry[e.key]?.bcva ?? ''}
                      onChange={(ev) => {
                        patch(e.key, 'bcva', ev.target.value);
                      }}
                    />
                  </td>
                ))}
              </tr>
              {(['sph', 'cyl', 'add'] as const).map((field) => (
                <tr key={field} className="border-b border-default">
                  <th scope="row" className="px-3 py-2 text-start text-2xs text-fg-muted">
                    {field === 'sph' ? 'Sphere' : field === 'cyl' ? 'Cylinder' : 'Add'}
                  </th>
                  {EYES.map((e) => (
                    <td key={e.key} className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            step(e.key, field, -0.25);
                          }}
                        >
                          −
                        </Button>
                        <input
                          className={`${cell} w-24 text-center font-mono`}
                          aria-label={`${field} ${e.label}`}
                          value={entry[e.key]?.[field] ?? ''}
                          onChange={(ev) => {
                            patch(e.key, field, ev.target.value);
                          }}
                        />
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            step(e.key, field, 0.25);
                          }}
                        >
                          +
                        </Button>
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-b border-default">
                <th scope="row" className="px-3 py-2 text-start text-2xs text-fg-muted">
                  Axis
                </th>
                {EYES.map((e) => (
                  <td key={e.key} className="px-3 py-2">
                    <input
                      className={`${cell} w-24 font-mono`}
                      aria-label={`Axis ${e.label}`}
                      placeholder="1–180"
                      value={entry[e.key]?.axis ?? ''}
                      onChange={(ev) => {
                        patch(e.key, 'axis', ev.target.value);
                      }}
                    />
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row" className="px-3 py-2 text-start text-2xs text-fg-muted">
                  Pressure (NCT)
                </th>
                {EYES.map((e) => (
                  <td key={e.key} className="px-3 py-2">
                    <input
                      className={`${cell} w-24 font-mono`}
                      aria-label={`Intraocular pressure ${e.label}`}
                      placeholder="mmHg"
                      value={entry[e.key]?.iop ?? ''}
                      onChange={(ev) => {
                        patch(e.key, 'iop', ev.target.value);
                      }}
                    />
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}

      {save.error === null ? null : <ProblemCard error={save.error} />}
      {drops.error === null ? null : <ProblemCard error={drops.error} />}

      {granted.has('ophtha.optometry.record') ? (
        <div className="flex flex-wrap items-end gap-3">
          <Button
            size="sm"
            disabled={save.isPending}
            onClick={() => {
              save.mutate();
            }}
          >
            Record
          </Button>
          {detail.visit.dilatedAt === null ? (
            <>
              <input
                className={`${cell} w-72`}
                aria-label="Dilating drops"
                value={drug}
                onChange={(e) => {
                  setDrug(e.target.value);
                }}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={drops.isPending || drug.trim() === ''}
                onClick={() => {
                  drops.mutate();
                }}
              >
                Dilate
              </Button>
            </>
          ) : (
            <Badge tone="warning">{`Dilated with ${detail.visit.dilatingDrug ?? 'drops'} — no driving for 4–6 hours`}</Badge>
          )}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <RecordedTable
          title="Acuity"
          headers={['Eye', 'Context', 'Value', 'logMAR']}
          rows={detail.acuities.map((a) => [
            a.eye === 'right' ? 'OD' : 'OS',
            a.context,
            a.value,
            a.logmar === null ? '—' : a.logmar.toFixed(2),
          ])}
          testId="acuity-table"
        />
        <RecordedTable
          title="Refraction"
          headers={['Eye', 'Sph', 'Cyl', 'Axis', 'Add', 'From']}
          rows={detail.refractions.map((r) => [
            r.eye === 'right' ? 'OD' : 'OS',
            r.sph === null ? '—' : r.sph.toFixed(2),
            r.cyl === null ? '—' : r.cyl.toFixed(2),
            r.axis === null ? '—' : String(r.axis),
            r.add === null ? '—' : r.add.toFixed(2),
            r.source,
          ])}
          testId="refraction-table"
        />
      </div>

      <p className="text-2xs text-fg-subtle">
        logMAR is computed by the server from the notation, never typed — a trend is only worth plotting if
        every point on it was converted the same way. Powers move in quarter-dioptre steps because no lens is
        ground finer.
      </p>
    </section>
  );
}

/** Snellen unless it is one of the readings below the chart. */
function notationFor(value: string): string {
  const upper = value.trim().toUpperCase();
  if (upper.startsWith('CF')) return 'cf';
  if (upper.startsWith('HM')) return 'hm';
  if (upper === 'NLP') return 'nlp';
  if (upper.startsWith('PL')) return 'pl';
  if (upper.startsWith('N')) return 'n_notation';
  return 'snellen_6';
}

function RecordedTable({
  title,
  headers,
  rows,
  testId,
}: {
  readonly title: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly testId: string;
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
      <table className="w-full text-sm" data-testid={testId}>
        <caption className="px-3 py-2 text-start text-2xs uppercase tracking-[0.08em] text-fg-subtle">
          {title}
        </caption>
        <thead>
          <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
            {headers.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 text-start">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="px-3 py-3 text-2xs text-fg-muted" colSpan={headers.length}>
                Nothing recorded yet.
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={`${title}-${String(index)}`} className="border-b border-default last:border-0">
                {row.map((value, column) => (
                  <td
                    key={`${title}-${String(index)}-${String(column)}`}
                    className="px-3 py-2 font-mono text-2xs"
                  >
                    {value}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
