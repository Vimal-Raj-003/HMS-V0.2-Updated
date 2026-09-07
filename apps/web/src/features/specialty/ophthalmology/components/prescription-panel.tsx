'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button } from '@vims/ui';
import { useState } from 'react';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { planSurgery, signSpectacleRx, signSpectacleRxDelegated } from '../api/client';
import { ophthaKeys } from '../api/keys';
import type { SpectacleRxRow, SurgeryPlanRow, VisitDetail } from '../api/types';

const cell = 'h-10 w-full rounded-md border border-control bg-layer-1 px-2 text-sm text-fg-default';

const FORMULAE = [
  { key: 'barrett', label: 'Barrett Universal II' },
  { key: 'srk_t', label: 'SRK/T' },
  { key: 'hoffer_q', label: 'Hoffer Q' },
  { key: 'haigis', label: 'Haigis' },
  { key: 'holladay_2', label: 'Holladay 2' },
] as const;

function toNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The prescription and the operation (OP-025 §8.4 and §8.5).
 *
 * ── The powers are prefilled from the refraction, and editable ──────────────
 *
 * The doctor may change what they sign, which is why the prescription stores
 * its own numbers rather than pointing at a refraction row. Once signed it
 * cannot be changed at all — an optical shop may already be grinding to it.
 *
 * ── Two buttons, because there are two keys ─────────────────────────────────
 *
 * The doctor's signature and the optometrist's delegated one are separate
 * routes with separate permissions. Whichever is used is printed on the
 * prescription, because a regulator reading the register two years later needs
 * to know which it was.
 *
 * ── Biometry age is shown, not enforced ─────────────────────────────────────
 *
 * A lens with no biometry behind it is refused outright. Biometry eight months
 * old is planned with, and labelled — six months is a convention, a stable eye
 * is a stable eye, and the surgeon is the one who should decide that knowing
 * the number.
 */
export function PrescriptionPanel({ detail }: { readonly detail: VisitDetail }): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = ophthaKeys(hospitalId);
  const client = useQueryClient();
  const visitId = detail.visit.id;

  const subjective = detail.refractions.filter((r) => r.kind === 'subjective');
  const right = subjective.find((r) => r.eye === 'right');
  const left = subjective.find((r) => r.eye === 'left');

  const [rx, setRx] = useState({
    rightSph: right?.sph?.toFixed(2) ?? '',
    rightCyl: right?.cyl?.toFixed(2) ?? '',
    rightAxis: right?.axis === undefined || right.axis === null ? '' : String(right.axis),
    leftSph: left?.sph?.toFixed(2) ?? '',
    leftCyl: left?.cyl?.toFixed(2) ?? '',
    leftAxis: left?.axis === undefined || left.axis === null ? '' : String(left.axis),
    add: right?.add?.toFixed(2) ?? '',
    pd: right?.pdBino === undefined || right.pdBino === null ? '' : String(right.pdBino),
  });

  const [plan, setPlan] = useState({
    eye: 'right',
    iolModel: '',
    iolPower: '',
    formula: 'barrett',
    target: '-0.25',
    al: '',
    k1: '',
    k2: '',
    biometryAt: '',
  });

  const [signedRx, setSignedRx] = useState<SpectacleRxRow | null>(null);
  const [plannedSurgery, setPlannedSurgery] = useState<SurgeryPlanRow | null>(null);

  function rxBody(): Record<string, unknown> {
    const rightDistance: Record<string, number> = {};
    const leftDistance: Record<string, number> = {};
    const rs = toNumber(rx.rightSph);
    const rc = toNumber(rx.rightCyl);
    const ra = toNumber(rx.rightAxis);
    const ls = toNumber(rx.leftSph);
    const lc = toNumber(rx.leftCyl);
    const la = toNumber(rx.leftAxis);
    if (rs !== undefined) rightDistance['sph'] = rs;
    if (rc !== undefined) rightDistance['cyl'] = rc;
    if (ra !== undefined) rightDistance['axis'] = ra;
    if (ls !== undefined) leftDistance['sph'] = ls;
    if (lc !== undefined) leftDistance['cyl'] = lc;
    if (la !== undefined) leftDistance['axis'] = la;
    const add = toNumber(rx.add);
    const pd = toNumber(rx.pd);
    return {
      kind: 'spectacle',
      ...(Object.keys(rightDistance).length === 0
        ? {}
        : { right: { distance: rightDistance, ...(add === undefined ? {} : { near: { add } }) } }),
      ...(Object.keys(leftDistance).length === 0
        ? {}
        : { left: { distance: leftDistance, ...(add === undefined ? {} : { near: { add } }) } }),
      ...(pd === undefined ? {} : { pdBino: pd }),
      validMonths: 12,
    };
  }

  const sign = useMutation({
    mutationFn: (delegated: boolean) =>
      delegated ? signSpectacleRxDelegated(visitId, rxBody()) : signSpectacleRx(visitId, rxBody()),
    onSuccess: (row) => {
      setSignedRx(row);
      void client.invalidateQueries({ queryKey: keys.visit(visitId) });
    },
  });

  const surgery = useMutation({
    mutationFn: () => {
      const power = toNumber(plan.iolPower);
      const al = toNumber(plan.al);
      const k1 = toNumber(plan.k1);
      const k2 = toNumber(plan.k2);
      const biometry = al !== undefined && k1 !== undefined && k2 !== undefined ? { al, k1, k2 } : undefined;
      return planSurgery(visitId, {
        procedureCode: 'PHACO_IOL',
        eye: plan.eye,
        anaesthesia: 'topical',
        ...(plan.iolModel.trim() === '' ? {} : { iolModel: plan.iolModel.trim() }),
        ...(power === undefined ? {} : { iolPower: power }),
        ...(power === undefined ? {} : { iolFormula: plan.formula }),
        ...(toNumber(plan.target) === undefined ? {} : { targetRefraction: toNumber(plan.target) }),
        ...(biometry === undefined ? {} : { biometry }),
        ...(plan.biometryAt === '' ? {} : { biometryAt: new Date(plan.biometryAt).toISOString() }),
        npcbviFlag: true,
      });
    },
    onSuccess: (row) => {
      setPlannedSurgery(row);
    },
  });

  const canSign = granted.has('ophtha.spectacle_rx.sign');
  const canSignDelegated = granted.has('ophtha.spectacle_rx.sign_delegated');

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
        <h3 className="text-sm font-semibold text-fg-default">Spectacle prescription</h3>

        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="rx-composer">
            <caption className="sr-only">Spectacle prescription</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['Eye', 'Sphere', 'Cylinder', 'Axis'].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 text-start">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['OD (right)', 'rightSph', 'rightCyl', 'rightAxis'],
                  ['OS (left)', 'leftSph', 'leftCyl', 'leftAxis'],
                ] as const
              ).map(([label, sphKey, cylKey, axisKey]) => (
                <tr key={label} className="border-b border-default last:border-0">
                  <th scope="row" className="px-3 py-2 text-start text-2xs text-fg-muted">
                    {label}
                  </th>
                  {([sphKey, cylKey, axisKey] as const).map((field) => (
                    <td key={field} className="px-3 py-2">
                      <input
                        className={`${cell} w-24 font-mono`}
                        aria-label={`${label} ${field}`}
                        value={rx[field]}
                        onChange={(e) => {
                          setRx({ ...rx, [field]: e.target.value });
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex w-28 flex-col gap-1">
            <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="rx-add">
              Add
            </label>
            <input
              id="rx-add"
              className={`${cell} font-mono`}
              value={rx.add}
              onChange={(e) => {
                setRx({ ...rx, add: e.target.value });
              }}
            />
          </div>
          <div className="flex w-28 flex-col gap-1">
            <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="rx-pd">
              PD (mm)
            </label>
            <input
              id="rx-pd"
              className={`${cell} font-mono`}
              value={rx.pd}
              onChange={(e) => {
                setRx({ ...rx, pd: e.target.value });
              }}
            />
          </div>
          {canSign ? (
            <Button
              size="sm"
              disabled={sign.isPending}
              onClick={() => {
                sign.mutate(false);
              }}
            >
              Sign
            </Button>
          ) : null}
          {!canSign && canSignDelegated ? (
            <Button
              size="sm"
              disabled={sign.isPending}
              onClick={() => {
                sign.mutate(true);
              }}
            >
              Sign under delegation
            </Button>
          ) : null}
          {!canSign && !canSignDelegated ? (
            <span className="text-2xs text-fg-subtle">
              Signing a prescription is the doctor’s, unless this hospital has delegated it.
            </span>
          ) : null}
        </div>

        {sign.error === null ? null : <ProblemCard error={sign.error} />}
        {signedRx === null ? null : (
          <div className="flex flex-wrap items-center gap-2 text-2xs" data-testid="signed-rx">
            <Badge tone="success">{signedRx.rxNo}</Badge>
            <span className="text-fg-muted">{`valid to ${signedRx.validUntil}`}</span>
            {signedRx.signedUnderDelegation ? <Badge tone="neutral">signed under delegation</Badge> : null}
            <span className="text-fg-subtle">
              Signed prescriptions cannot be changed — a new one supersedes this.
            </span>
          </div>
        )}
      </div>

      {granted.has('ophtha.surgery.plan') ? (
        <div className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
          <h3 className="text-sm font-semibold text-fg-default">Cataract plan</h3>
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="flex flex-col gap-1 text-2xs uppercase tracking-[0.08em] text-fg-subtle">
              Eye
              <select
                className={cell}
                value={plan.eye}
                onChange={(e) => {
                  setPlan({ ...plan, eye: e.target.value });
                }}
              >
                <option value="right">OD (right)</option>
                <option value="left">OS (left)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-2xs uppercase tracking-[0.08em] text-fg-subtle">
              Lens model
              <input
                className={cell}
                value={plan.iolModel}
                onChange={(e) => {
                  setPlan({ ...plan, iolModel: e.target.value });
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-2xs uppercase tracking-[0.08em] text-fg-subtle">
              Power (D)
              <input
                className={`${cell} font-mono`}
                value={plan.iolPower}
                onChange={(e) => {
                  setPlan({ ...plan, iolPower: e.target.value });
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-2xs uppercase tracking-[0.08em] text-fg-subtle">
              Formula
              <select
                className={cell}
                value={plan.formula}
                onChange={(e) => {
                  setPlan({ ...plan, formula: e.target.value });
                }}
              >
                {FORMULAE.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            {(
              [
                ['al', 'Axial length'],
                ['k1', 'K1'],
                ['k2', 'K2'],
              ] as const
            ).map(([field, label]) => (
              <label
                key={field}
                className="flex flex-col gap-1 text-2xs uppercase tracking-[0.08em] text-fg-subtle"
              >
                {label}
                <input
                  className={`${cell} font-mono`}
                  value={plan[field]}
                  onChange={(e) => {
                    setPlan({ ...plan, [field]: e.target.value });
                  }}
                />
              </label>
            ))}
            <label className="flex flex-col gap-1 text-2xs uppercase tracking-[0.08em] text-fg-subtle">
              Biometry date
              <input
                type="date"
                className={cell}
                value={plan.biometryAt}
                onChange={(e) => {
                  setPlan({ ...plan, biometryAt: e.target.value });
                }}
              />
            </label>
          </div>
          <div>
            <Button
              size="sm"
              disabled={surgery.isPending}
              onClick={() => {
                surgery.mutate();
              }}
            >
              Plan
            </Button>
          </div>
          {surgery.error === null ? null : <ProblemCard error={surgery.error} />}
          {plannedSurgery === null ? null : (
            <div className="flex flex-wrap items-center gap-2 text-2xs" data-testid="planned-surgery">
              <Badge tone="success">{`${plannedSurgery.procedureCode} ${plannedSurgery.eye === 'right' ? 'OD' : 'OS'}`}</Badge>
              {plannedSurgery.biometryStale ? (
                <Badge tone="warning">{`biometry ${String(plannedSurgery.biometryAgeDays ?? 0)} days old`}</Badge>
              ) : null}
              <span className="text-fg-muted">
                {plannedSurgery.iolPower === null
                  ? 'no lens power yet'
                  : `${plannedSurgery.iolPower.toFixed(2)} D by ${plannedSurgery.iolFormula ?? ''}`}
              </span>
            </div>
          )}
          <p className="text-2xs text-fg-subtle">
            A lens power with no biometry behind it is refused: the eye is not adjustable afterwards. Biometry
            older than six months is planned with, and labelled — that call is the surgeon’s to make
            knowingly.
          </p>
        </div>
      ) : null}
    </section>
  );
}
