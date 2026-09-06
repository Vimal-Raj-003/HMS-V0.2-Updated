'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Label } from '@vims/ui';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { erKeys } from '../api/keys';
import {
  escalateConsult,
  getBoard,
  planProcedure,
  recordConsent,
  recordHuddle,
  requestConsult,
  resequence,
  setProcedureState,
  updateBlood,
} from '../api/polytrauma-client';
import type { BoardDetailView, ConsultView } from '../api/polytrauma-types';

const PRIORITY_TONE: Readonly<Record<string, 'danger' | 'warning' | 'info' | 'neutral'>> = {
  life_saving: 'danger',
  limb_saving: 'warning',
  definitive: 'info',
  adjunct: 'neutral',
};

const PRIORITY_LABEL: Readonly<Record<string, string>> = {
  life_saving: 'life-saving',
  limb_saving: 'limb-saving',
  definitive: 'definitive',
  adjunct: 'adjunct',
};

const CONSENT_TONE: Readonly<Record<string, 'danger' | 'warning' | 'success' | 'neutral'>> = {
  not_sought: 'danger',
  sought: 'warning',
  given: 'success',
  refused: 'danger',
  emergency_waiver: 'warning',
  withdrawn: 'danger',
};

const inputClass = 'h-10 w-full rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';
const selectClass = 'h-10 rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

/**
 * TR-007 — one polytrauma board.
 *
 * ── Moving a procedure is a whole arrangement ───────────────────────────────
 *
 * The up/down buttons rewrite the entire order and send it in one call. There
 * is no "move this one" endpoint, because "put the nail at 2" is ambiguous
 * about what happens to whatever was at 2, and resolving that server-side would
 * mean guessing at a surgical decision. The reason box is filled once and used
 * for the move — the server demands one, and so does the audit row.
 *
 * ── The block reason is the server's sentence, rendered verbatim ────────────
 *
 * "4 of 6 units still to be reserved" is computed once, in the service, so the
 * card, this screen and the huddle note cannot disagree about why theatre is
 * waiting. The screen does not recompute it.
 */
export function PolytraumaCaseScreen(): React.JSX.Element {
  const params = useSearchParams();
  const id = params.get('id') ?? '';
  const { hospitalId } = useSession();
  const keys = erKeys(hospitalId);
  const queryClient = useQueryClient();

  const [moveReason, setMoveReason] = useState('');
  const [consultSpecialty, setConsultSpecialty] = useState('');
  const [consultQuestion, setConsultQuestion] = useState('');
  const [consultUrgency, setConsultUrgency] = useState('urgent');
  const [huddleDecisions, setHuddleDecisions] = useState('');
  const [huddleSpecialties, setHuddleSpecialties] = useState('');

  const board = useQuery({
    queryKey: keys.polytraumaBoard(id),
    queryFn: ({ signal }) => getBoard(id, { signal }),
    enabled: id !== '',
    refetchInterval: 60_000,
  });

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey: keys.polytraumaBoard(id) });
    void queryClient.invalidateQueries({ queryKey: keys.polytraumaBoardsRoot() });
  }

  const move = useMutation({
    mutationFn: (order: readonly { readonly procedureId: string; readonly sequence: number }[]) =>
      resequence(id, order, moveReason.trim()),
    onSuccess: invalidate,
  });

  const state = useMutation({
    mutationFn: (input: { readonly procedureId: string; readonly next: string; readonly reason?: string }) =>
      setProcedureState(id, input.procedureId, {
        state: input.next,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }),
    onSuccess: invalidate,
  });

  const consent = useMutation({
    mutationFn: (input: { readonly procedureId: string; readonly signedBy: string }) =>
      recordConsent(id, input.procedureId, {
        state: 'given',
        signedBy: input.signedBy,
        risksDiscussed: ['Bleeding', 'Infection', 'Anaesthetic risk', 'Need for further surgery'],
      }),
    onSuccess: invalidate,
  });

  const blood = useMutation({
    mutationFn: (input: { readonly bloodId: string; readonly units: number }) =>
      updateBlood(id, input.bloodId, { unitsReserved: input.units }),
    onSuccess: invalidate,
  });

  const consult = useMutation({
    mutationFn: () =>
      requestConsult(id, {
        specialty: consultSpecialty.trim(),
        question: consultQuestion.trim(),
        urgency: consultUrgency,
      }),
    onSuccess: () => {
      setConsultSpecialty('');
      setConsultQuestion('');
      invalidate();
    },
  });

  const escalate = useMutation({
    mutationFn: (input: { readonly consultId: string; readonly to: string; readonly note: string }) =>
      escalateConsult(id, input.consultId, {
        escalatedTo: input.to,
        ...(input.note.trim() === '' ? {} : { note: input.note.trim() }),
      }),
    onSuccess: invalidate,
  });

  const huddle = useMutation({
    mutationFn: () =>
      recordHuddle(id, {
        specialties: huddleSpecialties
          .split(',')
          .map((x) => x.trim())
          .filter((x) => x !== ''),
        decisions: huddleDecisions.trim(),
      }),
    onSuccess: () => {
      setHuddleDecisions('');
      setHuddleSpecialties('');
      invalidate();
    },
  });

  const plan = useMutation({
    mutationFn: (input: { readonly name: string; readonly specialty: string; readonly priority: string }) =>
      planProcedure(id, input),
    onSuccess: invalidate,
  });

  if (id === '') {
    return (
      <EmptyState cause="No board was named in the address." nextAction="Open one from the board list." />
    );
  }

  const detail = board.data;

  return (
    <section className="flex flex-col gap-6">
      <AsyncPanel
        loading={board.isPending}
        error={board.error}
        isEmpty={false}
        skeletonLabel="Loading the board"
        skeletonRows={8}
        onRetry={() => {
          void board.refetch();
        }}
        empty={null}
      >
        {detail === undefined ? null : (
          <>
            <PageHeader
              title={detail.caseNo}
              description={
                detail.closedAt === null
                  ? `Open ${String(detail.hoursOpen)} h. ${detail.issAtOpen === null ? 'ISS not scored on arrival.' : `ISS ${String(detail.issAtOpen)} on arrival${detail.trissAtOpen === null ? '' : `, TRISS ${detail.trissAtOpen}`}.`}`
                  : `Closed ${detail.closedAt.slice(0, 16).replace('T', ' ')} — ${detail.outcome ?? 'outcome not recorded'}.`
              }
            />

            <Queue
              detail={detail}
              reason={moveReason}
              busy={move.isPending || state.isPending || consent.isPending}
              onReason={setMoveReason}
              onMove={(order) => {
                move.mutate(order);
              }}
              onState={(procedureId, next, why) => {
                state.mutate({ procedureId, next, ...(why === undefined ? {} : { reason: why }) });
              }}
              onConsent={(procedureId, signedBy) => {
                consent.mutate({ procedureId, signedBy });
              }}
              onPlan={(name, specialty, priority) => {
                plan.mutate({ name, specialty, priority });
              }}
            />
            {move.error === null ? null : <ProblemCard error={move.error} />}
            {state.error === null ? null : <ProblemCard error={state.error} />}
            {consent.error === null ? null : <ProblemCard error={consent.error} />}
            {plan.error === null ? null : <ProblemCard error={plan.error} />}

            {/* ── Blood ──────────────────────────────────────────────────── */}
            <div className="rounded-lg border border-strong bg-layer-1 p-4">
              <h2 className="text-sm font-semibold text-fg-default">Blood</h2>
              <p className="mt-1 text-2xs text-fg-muted">
                Cross-matched is not the same as in the fridge. A procedure needing units it does not have
                reserved will not enter theatre.
              </p>
              {detail.blood.length === 0 ? (
                <p className="mt-3 text-sm text-fg-muted">No blood requirement recorded on this board.</p>
              ) : (
                <div className="mt-3 overflow-x-auto rounded-md border border-default">
                  <table className="w-full text-sm" data-testid="pt-blood">
                    <caption className="sr-only">Blood requirements</caption>
                    <thead>
                      <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                        {['Component', 'Required', 'Reserved', 'Issued', 'MTP', ''].map((h) => (
                          <th key={h} scope="col" className="px-3 py-2 text-start">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {detail.blood.map((b) => (
                        <tr key={b.id} className="border-b border-default last:border-0">
                          <td className="px-3 py-2">{b.component.replace(/_/gu, ' ')}</td>
                          <td className="px-3 py-2 font-mono text-2xs">{b.unitsRequired}</td>
                          <td className="px-3 py-2">
                            {b.shortBy > 0 ? (
                              <Badge tone="warning">{`${String(b.unitsReserved)} — short by ${String(b.shortBy)}`}</Badge>
                            ) : (
                              <Badge tone="success">{b.unitsReserved}</Badge>
                            )}
                          </td>
                          <td className="px-3 py-2 font-mono text-2xs">{b.unitsIssued}</td>
                          <td className="px-3 py-2">
                            {b.mtpActivated ? <Badge tone="danger">activated</Badge> : <span>—</span>}
                          </td>
                          <td className="px-3 py-2">
                            {b.shortBy > 0 ? (
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={blood.isPending}
                                onClick={() => {
                                  blood.mutate({ bloodId: b.id, units: b.unitsRequired });
                                }}
                              >
                                Reserve the rest
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {blood.error === null ? null : <ProblemCard error={blood.error} />}
            </div>

            {/* ── Consults ───────────────────────────────────────────────── */}
            <Consults
              consults={detail.consults}
              specialty={consultSpecialty}
              question={consultQuestion}
              urgency={consultUrgency}
              busy={consult.isPending || escalate.isPending}
              leadId={detail.leadClinicianId}
              onSpecialty={setConsultSpecialty}
              onQuestion={setConsultQuestion}
              onUrgency={setConsultUrgency}
              onRequest={() => {
                consult.mutate();
              }}
              onEscalate={(consultId, to, note) => {
                escalate.mutate({ consultId, to, note });
              }}
            />
            {consult.error === null ? null : <ProblemCard error={consult.error} />}
            {escalate.error === null ? null : <ProblemCard error={escalate.error} />}

            {/* ── The huddle ─────────────────────────────────────────────── */}
            <div className="rounded-lg border border-strong bg-layer-1 p-4">
              <h2 className="text-sm font-semibold text-fg-default">Multi-disciplinary huddle</h2>
              <p className="mt-1 text-2xs text-fg-muted">
                What was decided and who was in the room. Append-only — a decision rewritten afterwards is not
                what the room decided.
              </p>
              <div className="mt-3 grid gap-3">
                <div>
                  <Label htmlFor="pt-huddle-specialties">Specialties present (comma separated)</Label>
                  <input
                    id="pt-huddle-specialties"
                    className={inputClass}
                    value={huddleSpecialties}
                    placeholder="general_surgery, orthopaedics, neurosurgery"
                    onChange={(e) => {
                      setHuddleSpecialties(e.target.value);
                    }}
                  />
                </div>
                <div>
                  <Label htmlFor="pt-huddle-decisions">Decisions</Label>
                  <input
                    id="pt-huddle-decisions"
                    className={inputClass}
                    value={huddleDecisions}
                    placeholder="Laparotomy first, fasciotomy to follow. Nail deferred to day 3 pending lactate."
                    onChange={(e) => {
                      setHuddleDecisions(e.target.value);
                    }}
                  />
                </div>
                <div>
                  <Button
                    type="button"
                    disabled={
                      huddle.isPending || huddleDecisions.trim().length < 8 || huddleSpecialties.trim() === ''
                    }
                    onClick={() => {
                      huddle.mutate();
                    }}
                  >
                    Record the huddle
                  </Button>
                </div>
              </div>
              {huddle.error === null ? null : <ProblemCard error={huddle.error} />}

              {detail.huddles.length === 0 ? null : (
                <ul className="mt-4 flex flex-col gap-2">
                  {detail.huddles.map((h) => (
                    <li key={h.id} className="rounded-md border border-default p-3 text-sm">
                      <div className="font-mono text-2xs text-fg-subtle">
                        {h.heldAt.slice(0, 16).replace('T', ' ')} · {h.specialties.join(', ')}
                      </div>
                      <p className="mt-1">{h.decisions}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </AsyncPanel>
    </section>
  );
}

function Queue({
  detail,
  reason,
  busy,
  onReason,
  onMove,
  onState,
  onConsent,
  onPlan,
}: {
  readonly detail: BoardDetailView;
  readonly reason: string;
  readonly busy: boolean;
  readonly onReason: (value: string) => void;
  readonly onMove: (order: readonly { readonly procedureId: string; readonly sequence: number }[]) => void;
  readonly onState: (procedureId: string, next: string, reason?: string) => void;
  readonly onConsent: (procedureId: string, signedBy: string) => void;
  readonly onPlan: (name: string, specialty: string, priority: string) => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [priority, setPriority] = useState('definitive');
  const [signer, setSigner] = useState<Readonly<Record<string, string>>>({});

  const live = detail.procedures.filter((p) => p.state !== 'abandoned');

  function swap(index: number, delta: number): void {
    const next = [...live];
    const a = next[index];
    const b = next[index + delta];
    if (a === undefined || b === undefined) return;
    next[index] = b;
    next[index + delta] = a;
    onMove(next.map((p, i) => ({ procedureId: p.id, sequence: i + 1 })));
  }

  return (
    <div className="rounded-lg border border-strong bg-layer-1 p-4">
      <h2 className="text-sm font-semibold text-fg-default">Surgical queue</h2>
      <p className="mt-1 text-2xs text-fg-muted">
        Life-saving before limb-saving before definitive. Moving a procedure rewrites the whole arrangement,
        and the database refuses one that breaks the order.
      </p>

      <div className="mt-3">
        <Label htmlFor="pt-move-reason">Why you are changing the order</Label>
        <input
          id="pt-move-reason"
          className={inputClass}
          value={reason}
          placeholder="Damage control first; nail once lactate clears"
          onChange={(e) => {
            onReason(e.target.value);
          }}
        />
      </div>

      <ol className="mt-4 flex flex-col gap-2" data-testid="pt-queue">
        {live.map((p, index) => (
          <li key={p.id} className="rounded-md border border-default p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-2xs text-fg-subtle">{p.sequence}.</span>
                  <span className="text-sm font-semibold text-fg-default">{p.name}</span>
                  <Badge tone={PRIORITY_TONE[p.priority] ?? 'neutral'}>
                    {PRIORITY_LABEL[p.priority] ?? p.priority}
                  </Badge>
                  <Badge tone={CONSENT_TONE[p.consentState] ?? 'neutral'}>
                    {p.consentState.replace(/_/gu, ' ')}
                  </Badge>
                  {p.state === 'planned' ? null : <Badge tone="info">{p.state.replace('_', ' ')}</Badge>}
                </div>
                {p.rationale === null ? null : <p className="mt-1 text-2xs text-fg-muted">{p.rationale}</p>}
                {/* The server's sentence, rendered as written. */}
                {p.blockedBy === null ? null : <p className="mt-1 text-2xs text-fg-warning">{p.blockedBy}</p>}
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-1">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || index === 0 || reason.trim().length < 12}
                  onClick={() => {
                    swap(index, -1);
                  }}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || index === live.length - 1 || reason.trim().length < 12}
                  onClick={() => {
                    swap(index, 1);
                  }}
                >
                  ↓
                </Button>
                {p.state === 'planned' || p.state === 'ready' ? (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      onState(p.id, 'in_theatre');
                    }}
                  >
                    To theatre
                  </Button>
                ) : null}
                {p.state === 'in_theatre' ? (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      onState(p.id, 'done');
                    }}
                  >
                    Done
                  </Button>
                ) : null}
              </div>
            </div>

            {p.consentState === 'not_sought' || p.consentState === 'sought' ? (
              <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-default pt-2">
                <div className="grow">
                  <Label htmlFor={`consent-${p.id}`}>Consent given by</Label>
                  <input
                    id={`consent-${p.id}`}
                    className={inputClass}
                    value={signer[p.id] ?? ''}
                    placeholder="Patient, or the relative's name"
                    onChange={(e) => {
                      setSigner({ ...signer, [p.id]: e.target.value });
                    }}
                  />
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || (signer[p.id] ?? '').trim().length < 2}
                  onClick={() => {
                    onConsent(p.id, (signer[p.id] ?? '').trim());
                  }}
                >
                  Record consent
                </Button>
                <span className="text-2xs text-fg-subtle">
                  An emergency waiver is a different key and a different screen.
                </span>
              </div>
            ) : null}
          </li>
        ))}
      </ol>

      <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-default pt-3">
        <div className="grow">
          <Label htmlFor="pt-plan-name">Add a procedure</Label>
          <input
            id="pt-plan-name"
            className={inputClass}
            value={name}
            placeholder="Damage-control laparotomy"
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </div>
        <div>
          <Label htmlFor="pt-plan-specialty">Specialty</Label>
          <input
            id="pt-plan-specialty"
            className={inputClass}
            value={specialty}
            placeholder="general_surgery"
            onChange={(e) => {
              setSpecialty(e.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pt-plan-priority">Urgency</Label>
          <select
            id="pt-plan-priority"
            className={selectClass}
            value={priority}
            onChange={(e) => {
              setPriority(e.target.value);
            }}
          >
            {Object.entries(PRIORITY_LABEL).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={busy || name.trim() === '' || specialty.trim() === ''}
          onClick={() => {
            onPlan(name.trim(), specialty.trim(), priority);
            setName('');
            setSpecialty('');
          }}
        >
          Add
        </Button>
      </div>
      <p className="mt-2 text-2xs text-fg-subtle">
        A new procedure goes to the back of its own urgency class, not the end of the list — where a class
        sits is not a surgical judgement.
      </p>
    </div>
  );
}

function Consults({
  consults,
  specialty,
  question,
  urgency,
  busy,
  leadId,
  onSpecialty,
  onQuestion,
  onUrgency,
  onRequest,
  onEscalate,
}: {
  readonly consults: readonly ConsultView[];
  readonly specialty: string;
  readonly question: string;
  readonly urgency: string;
  readonly busy: boolean;
  readonly leadId: string | null;
  readonly onSpecialty: (v: string) => void;
  readonly onQuestion: (v: string) => void;
  readonly onUrgency: (v: string) => void;
  readonly onRequest: () => void;
  readonly onEscalate: (consultId: string, to: string, note: string) => void;
}): React.JSX.Element {
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({});

  return (
    <div className="rounded-lg border border-strong bg-layer-1 p-4">
      <h2 className="text-sm font-semibold text-fg-default">Consults</h2>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <Label htmlFor="pt-consult-specialty">Specialty</Label>
          <input
            id="pt-consult-specialty"
            className={inputClass}
            value={specialty}
            placeholder="neurosurgery"
            onChange={(e) => {
              onSpecialty(e.target.value);
            }}
          />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="pt-consult-question">The question</Label>
          <input
            id="pt-consult-question"
            className={inputClass}
            value={question}
            placeholder="4mm midline shift — evacuate before the abdomen?"
            onChange={(e) => {
              onQuestion(e.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pt-consult-urgency">Urgency</Label>
          <select
            id="pt-consult-urgency"
            className={selectClass}
            value={urgency}
            onChange={(e) => {
              onUrgency(e.target.value);
            }}
          >
            <option value="immediate">immediate — 15 min</option>
            <option value="urgent">urgent — 60 min</option>
            <option value="routine">routine — 4 h</option>
          </select>
        </div>
      </div>
      <div className="mt-3">
        <Button
          type="button"
          disabled={busy || specialty.trim() === '' || question.trim().length < 8}
          onClick={onRequest}
        >
          Ask
        </Button>
      </div>

      {consults.length === 0 ? null : (
        <div className="mt-4 overflow-x-auto rounded-md border border-default">
          <table className="w-full text-sm" data-testid="pt-consults">
            <caption className="sr-only">Consults</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['Specialty', 'State', 'Clock', 'Escalation', ''].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 text-start">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {consults.map((c) => (
                <tr key={c.id} className="border-b border-default last:border-0">
                  <td className="px-3 py-2">
                    <div className="font-semibold">{c.specialty.replace(/_/gu, ' ')}</div>
                    <div className="text-2xs text-fg-muted">{c.question}</div>
                    {c.advice === null ? null : (
                      <div className="mt-1 text-2xs text-fg-default">Advice: {c.advice}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={c.state === 'advised' || c.state === 'seen' ? 'success' : 'warning'}>
                      {c.state}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    {c.breached ? (
                      <Badge tone="danger">{`${String(Math.abs(c.minutesRemaining))} min over`}</Badge>
                    ) : (
                      <span className="font-mono text-2xs">
                        {c.minutesRemaining >= 0
                          ? `${String(c.minutesRemaining)} min left`
                          : `${String(Math.abs(c.minutesRemaining))} min over`}
                      </span>
                    )}
                    <div className="text-2xs text-fg-subtle">{c.slaMinutes} min target</div>
                  </td>
                  <td className="px-3 py-2">
                    {c.escalatedAt === null ? (
                      <span className="text-2xs text-fg-subtle">—</span>
                    ) : (
                      <div>
                        <Badge tone="info">escalated</Badge>
                        {c.escalationNote === null ? null : (
                          <div className="mt-1 text-2xs text-fg-muted">{c.escalationNote}</div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {c.escalatedAt !== null || leadId === null ? null : (
                      <div className="flex flex-col gap-1">
                        {c.breached ? null : (
                          <input
                            aria-label="Why you are escalating early"
                            className={inputClass}
                            value={notes[c.id] ?? ''}
                            placeholder="Not yet past target — say why"
                            onChange={(e) => {
                              setNotes({ ...notes, [c.id]: e.target.value });
                            }}
                          />
                        )}
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={busy || (!c.breached && (notes[c.id] ?? '').trim().length < 8)}
                          onClick={() => {
                            onEscalate(c.id, leadId, notes[c.id] ?? '');
                          }}
                        >
                          Escalate
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-2xs text-fg-subtle">
        Escalating before the target has passed is allowed and asks why — an escalation register full of
        un-breached consults is a register nobody reads.
      </p>
    </div>
  );
}
