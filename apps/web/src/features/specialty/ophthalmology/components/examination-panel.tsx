'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button } from '@vims/ui';
import { useState } from 'react';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { recordDiagnoses, recordExam, signVisit } from '../api/client';
import { ophthaKeys } from '../api/keys';
import type { VisitDetail } from '../api/types';

const cell = 'h-10 w-full rounded-md border border-control bg-layer-1 px-2 text-sm text-fg-default';

const EYES = [
  { key: 'right', label: 'OD (right)' },
  { key: 'left', label: 'OS (left)' },
] as const;

/**
 * The international grading. `phase-08` puts screening yield on this field, so
 * it is a column in the database and a fixed list here rather than free text.
 */
const DR_GRADES = [
  { key: 'none', label: 'No retinopathy' },
  { key: 'mild_npdr', label: 'Mild NPDR' },
  { key: 'moderate_npdr', label: 'Moderate NPDR' },
  { key: 'severe_npdr', label: 'Severe NPDR' },
  { key: 'pdr', label: 'Proliferative' },
] as const;

interface DiagnosisDraft {
  eye: string;
  icd10: string;
  note: string;
  isPrimary: boolean;
}

/**
 * The examination (OP-025 §8.3).
 *
 * ── The retinopathy grade and the cup-disc ratio are fields, not prose ──────
 *
 * Both are what a screening programme and a glaucoma clinic report on, and a
 * grade buried in a paragraph is a grade nobody can count. Everything else the
 * ophthalmologist writes stays narrative, because a drawing and a sentence
 * carry more than any structured field would.
 *
 * ── A diagnosis may be of both eyes; a measurement may not ──────────────────
 *
 * This is the one place `OU` is offered, and it is offered here because
 * "primary open-angle glaucoma, both eyes" is one clinical judgement rather
 * than two readings that happen to agree.
 */
export function ExaminationPanel({ detail }: { readonly detail: VisitDetail }): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = ophthaKeys(hospitalId);
  const client = useQueryClient();
  const visitId = detail.visit.id;

  const [eye, setEye] = useState<string>('right');
  const [cdr, setCdr] = useState('');
  const [grade, setGrade] = useState('');
  const [dme, setDme] = useState(false);
  const [notes, setNotes] = useState('');
  const [drafts, setDrafts] = useState<DiagnosisDraft[]>([]);

  function invalidate(): void {
    void client.invalidateQueries({ queryKey: keys.visit(visitId) });
    void client.invalidateQueries({ queryKey: keys.visitsRoot() });
  }

  const saveExam = useMutation({
    mutationFn: () =>
      recordExam(visitId, {
        segment: 'posterior',
        eye,
        ...(cdr.trim() === '' ? {} : { cdrVertical: Number(cdr) }),
        ...(grade === '' ? {} : { drGrade: grade }),
        dme,
        findings: notes.trim() === '' ? {} : { narrative: notes.trim() },
      }),
    onSuccess: () => {
      setCdr('');
      setGrade('');
      setDme(false);
      setNotes('');
      invalidate();
    },
  });

  const saveDiagnoses = useMutation({
    mutationFn: () =>
      recordDiagnoses(
        visitId,
        drafts
          .filter((d) => d.icd10.trim() !== '')
          .map((d) => ({
            eye: d.eye,
            icd10: d.icd10.trim(),
            isPrimary: d.isPrimary,
            ...(d.note.trim() === '' ? {} : { note: d.note.trim() }),
          })),
      ),
    onSuccess: invalidate,
  });

  const sign = useMutation({
    mutationFn: () => signVisit(visitId),
    onSuccess: invalidate,
  });

  const signed = detail.visit.signedAt !== null;

  return (
    <section className="flex flex-col gap-4">
      {granted.has('ophtha.exam.record') && !signed ? (
        <div className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
          <h3 className="text-sm font-semibold text-fg-default">Posterior segment</h3>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-2xs uppercase tracking-[0.08em] text-fg-subtle">Eye</span>
              <div className="flex gap-1">
                {EYES.map((e) => (
                  <Button
                    key={e.key}
                    size="sm"
                    variant={eye === e.key ? 'primary' : 'secondary'}
                    onClick={() => {
                      setEye(e.key);
                    }}
                  >
                    {e.label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex w-36 flex-col gap-1">
              <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="ex-cdr">
                Cup-to-disc
              </label>
              <input
                id="ex-cdr"
                className={`${cell} font-mono`}
                placeholder="0.00–1.00"
                value={cdr}
                onChange={(e) => {
                  setCdr(e.target.value);
                }}
              />
            </div>
            <div className="flex w-56 flex-col gap-1">
              <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="ex-dr">
                Diabetic retinopathy
              </label>
              <select
                id="ex-dr"
                className={cell}
                value={grade}
                onChange={(e) => {
                  setGrade(e.target.value);
                }}
              >
                <option value="">Not graded</option>
                {DR_GRADES.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex min-h-12 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-5"
                checked={dme}
                onChange={(e) => {
                  setDme(e.target.checked);
                }}
              />
              Macular oedema
            </label>
          </div>
          <textarea
            className="min-h-24 w-full rounded-md border border-control bg-layer-1 p-3 text-sm text-fg-default"
            aria-label="Examination narrative"
            placeholder="Disc, macula, vessels, periphery…"
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
            }}
          />
          <div>
            <Button
              size="sm"
              disabled={saveExam.isPending}
              onClick={() => {
                saveExam.mutate();
              }}
            >
              Record this eye
            </Button>
          </div>
          {saveExam.error === null ? null : <ProblemCard error={saveExam.error} />}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
        <table className="w-full text-sm" data-testid="exam-table">
          <caption className="px-3 py-2 text-start text-2xs uppercase tracking-[0.08em] text-fg-subtle">
            Recorded this visit
          </caption>
          <thead>
            <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
              {['Segment', 'Eye', 'Cup-disc', 'Retinopathy', 'Oedema'].map((h) => (
                <th key={h} scope="col" className="px-3 py-2 text-start">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {detail.exam.length === 0 ? (
              <tr>
                <td className="px-3 py-3 text-2xs text-fg-muted" colSpan={5}>
                  Nothing examined yet.
                </td>
              </tr>
            ) : (
              detail.exam.map((e) => (
                <tr key={e.id} className="border-b border-default last:border-0">
                  <td className="px-3 py-2 text-2xs">{e.segment}</td>
                  <td className="px-3 py-2 font-mono text-2xs">{e.eye === 'right' ? 'OD' : 'OS'}</td>
                  <td className="px-3 py-2 font-mono text-2xs">
                    {e.cdrVertical === null ? '—' : e.cdrVertical.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-2xs">
                    {e.drGrade === null ? (
                      '—'
                    ) : (
                      <Badge tone={e.drGrade === 'pdr' || e.drGrade === 'severe_npdr' ? 'danger' : 'neutral'}>
                        {e.drGrade.replace(/_/gu, ' ')}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-2xs">
                    {e.dme === true ? 'yes' : e.dme === false ? 'no' : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {granted.has('ophtha.exam.record') && !signed ? (
        <div className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-fg-default">Diagnoses</h3>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setDrafts([...drafts, { eye: 'right', icd10: '', note: '', isPrimary: drafts.length === 0 }]);
              }}
            >
              Add
            </Button>
          </div>
          {drafts.map((d, index) => (
            <div key={`dx-${String(index)}`} className="flex flex-wrap items-end gap-2">
              <select
                className={`${cell} w-36`}
                aria-label={`Eye for diagnosis ${String(index + 1)}`}
                value={d.eye}
                onChange={(e) => {
                  const next = [...drafts];
                  next[index] = { ...d, eye: e.target.value };
                  setDrafts(next);
                }}
              >
                <option value="right">OD (right)</option>
                <option value="left">OS (left)</option>
                <option value="bilateral">OU (both)</option>
              </select>
              <input
                className={`${cell} w-32 font-mono`}
                aria-label={`ICD-10 for diagnosis ${String(index + 1)}`}
                placeholder="H25.1"
                value={d.icd10}
                onChange={(e) => {
                  const next = [...drafts];
                  next[index] = { ...d, icd10: e.target.value };
                  setDrafts(next);
                }}
              />
              <input
                className={`${cell} w-64`}
                aria-label={`Note for diagnosis ${String(index + 1)}`}
                placeholder="Note"
                value={d.note}
                onChange={(e) => {
                  const next = [...drafts];
                  next[index] = { ...d, note: e.target.value };
                  setDrafts(next);
                }}
              />
              <label className="flex min-h-12 items-center gap-2 text-2xs">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={d.isPrimary}
                  onChange={(e) => {
                    const next = drafts.map((x, i) => ({ ...x, isPrimary: i === index && e.target.checked }));
                    setDrafts(next);
                  }}
                />
                Primary
              </label>
            </div>
          ))}
          {drafts.length > 0 ? (
            <div>
              <Button
                size="sm"
                disabled={saveDiagnoses.isPending}
                onClick={() => {
                  saveDiagnoses.mutate();
                }}
              >
                Save diagnoses
              </Button>
            </div>
          ) : null}
          {saveDiagnoses.error === null ? null : <ProblemCard error={saveDiagnoses.error} />}
        </div>
      ) : null}

      {detail.diagnoses.length > 0 ? (
        <ul className="flex flex-wrap gap-2" data-testid="diagnosis-list">
          {detail.diagnoses.map((d) => (
            <li key={d.id}>
              <Badge tone={d.isPrimary ? 'success' : 'neutral'}>
                {`${d.icd10} · ${d.eye === 'bilateral' ? 'OU' : d.eye === 'right' ? 'OD' : 'OS'}`}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-default pt-4">
        {signed ? (
          <Badge tone="success">{`Signed ${detail.visit.signedAt?.slice(0, 16).replace('T', ' ') ?? ''}`}</Badge>
        ) : granted.has('ophtha.exam.sign') ? (
          <Button
            size="sm"
            disabled={sign.isPending}
            onClick={() => {
              sign.mutate();
            }}
          >
            Sign the visit
          </Button>
        ) : (
          <span className="text-2xs text-fg-subtle">
            Recording is yours; signing the visit is the consultant’s.
          </span>
        )}
        {sign.error === null ? null : <ProblemCard error={sign.error} />}
      </div>
    </section>
  );
}
