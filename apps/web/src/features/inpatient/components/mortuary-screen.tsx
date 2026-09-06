'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { getMortuaryCases, getReleaseChecklist, releaseBody, verifyNextOfKin } from '../api/client';
import { ipKeys } from '../api/keys';
import type { MortuaryRow } from '../api/types';

const inputClass = 'h-10 w-full rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

const ID_TYPES = ['aadhaar', 'voter_id', 'passport', 'driving_licence', 'ration_card', 'other'] as const;

/**
 * IP-017 — the register, and what is standing between a body and the door.
 *
 * ── The checklist is an explanation, never an authorisation ─────────────────
 *
 * It reads the same four facts the database trigger reads — certificate,
 * verified claimant, closed medico-legal case, required post-mortem — so the
 * custodian can tell a family what is outstanding and roughly how long it will
 * take. Release stays disabled while any of the four is open, and there is no
 * control anywhere on this screen that turns it back on. A family standing in
 * a corridor at midnight will ask, and the honest answer is that nobody in the
 * building can.
 *
 * ── The tag is typed at the door, every time ────────────────────────────────
 *
 * Coming in and going out. It is compared with the tag on the file, and a
 * mismatch stops the handover. A body released against the wrong file cannot
 * be recalled.
 */
export function MortuaryScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = ipKeys(hospitalId);
  const client = useQueryClient();

  const [inHouseOnly, setInHouseOnly] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tag, setTag] = useState('');
  const [nok, setNok] = useState({ name: '', relationship: '', idType: 'aadhaar', idRef: '' });

  const list = useQuery({
    queryKey: keys.mortuary(String(inHouseOnly)),
    queryFn: ({ signal }) => getMortuaryCases({ inHouseOnly }, { signal }),
    refetchInterval: 120_000,
  });

  const checklist = useQuery({
    queryKey: keys.releaseChecklist(openId ?? 'none'),
    queryFn: ({ signal }) => getReleaseChecklist(openId ?? '', { signal }),
    enabled: openId !== null,
  });

  function invalidate(): void {
    void client.invalidateQueries({ queryKey: keys.mortuaryRoot() });
  }

  const verify = useMutation({
    mutationFn: () =>
      verifyNextOfKin(openId ?? '', {
        nokName: nok.name.trim(),
        nokRelationship: nok.relationship.trim(),
        nokIdType: nok.idType,
        nokIdRef: nok.idRef.trim(),
      }),
    onSuccess: () => {
      setNok({ name: '', relationship: '', idType: 'aadhaar', idRef: '' });
      invalidate();
    },
  });

  const release = useMutation({
    mutationFn: () => releaseBody(openId ?? '', { bodyTagScan: tag.trim() }),
    onSuccess: () => {
      setTag('');
      setOpenId(null);
      invalidate();
    },
  });

  const rows: readonly MortuaryRow[] = list.data?.items ?? [];
  const open = rows.find((r) => r.id === openId);
  const gates = checklist.data;

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Mortuary"
        description="The register, the certificates, and what each release is still waiting on."
      />

      <label className="flex min-h-12 w-fit items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-5"
          checked={inHouseOnly}
          onChange={(e) => {
            setInHouseOnly(e.target.checked);
          }}
        />
        Only bodies still in the building
      </label>

      <AsyncPanel
        loading={list.isPending}
        error={list.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the mortuary register"
        skeletonRows={5}
        onRetry={() => {
          void list.refetch();
        }}
        empty={
          <EmptyState
            cause={inHouseOnly ? 'No body is in the mortuary.' : 'The register is empty.'}
            nextAction="A death file opens the moment a death is declared on the ward, and it appears here."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="mortuary-register">
            <caption className="sr-only">Mortuary register</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['Record', 'Tag', 'Declared', 'Chamber', 'Certificate', 'Next of kin', 'Released', ''].map(
                  (h) => (
                    <th key={h} scope="col" className="px-3 py-2 text-start">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className="border-b border-default last:border-0" data-testid={`mor-${m.id}`}>
                  <td className="px-3 py-2 font-mono text-2xs">{m.recordNo}</td>
                  <td className="px-3 py-2 font-mono text-2xs">{m.bodyTagNo}</td>
                  <td className="px-3 py-2 font-mono text-2xs">
                    {m.declaredAt.slice(0, 16).replace('T', ' ')}
                  </td>
                  <td className="px-3 py-2 text-2xs">{m.coldStorageUnit ?? 'not received'}</td>
                  <td className="px-3 py-2">
                    {m.mccdIssuedAt === null ? (
                      <Badge tone="warning">not issued</Badge>
                    ) : (
                      <Badge tone="success">{`Form ${m.mccdForm ?? '4'}`}</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-2xs">
                    {m.nokVerifiedAt === null ? (
                      m.unclaimed ? (
                        <Badge tone="warning">unclaimed</Badge>
                      ) : (
                        <span className="text-fg-warning">unverified</span>
                      )
                    ) : (
                      `${m.nokName ?? ''} (${m.nokRelationship ?? ''})`
                    )}
                  </td>
                  <td className="px-3 py-2 text-2xs">
                    {m.releasedAt === null ? '—' : m.releasedAt.slice(0, 16).replace('T', ' ')}
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setOpenId(m.id);
                      }}
                    >
                      Open
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      {open === undefined ? null : (
        <div className="flex flex-col gap-4 rounded-lg border border-strong bg-layer-1 p-4">
          <h2 className="text-base font-semibold text-fg-default">
            {`${open.recordNo} · tag ${open.bodyTagNo}`}
          </h2>
          <p className="text-2xs text-fg-muted">{open.causeOfDeath}</p>

          {gates === undefined ? null : (
            <ul className="flex flex-col gap-1 text-sm" data-testid="release-checklist">
              {(
                [
                  ['Certificate of cause of death issued', gates.certificateIssued],
                  ['Next of kin identified and checked against a document', gates.nextOfKinVerified],
                  ['Medico-legal case closed or none open', gates.mlcCleared],
                  ['Post-mortem performed, or none required', gates.postMortemSettled],
                ] as const
              ).map(([label, done]) => (
                <li key={label} className="flex items-center gap-2">
                  <Badge tone={done ? 'success' : 'warning'}>{done ? 'done' : 'outstanding'}</Badge>
                  <span>{label}</span>
                </li>
              ))}
            </ul>
          )}

          {granted.has('mortuary.release.manage') && open.nokVerifiedAt === null ? (
            <div className="flex flex-col gap-3 border-t border-default pt-4">
              <h3 className="text-sm font-semibold text-fg-default">Verify the next of kin</h3>
              <div className="grid gap-3 sm:grid-cols-4">
                <input
                  className={inputClass}
                  aria-label="Next of kin name"
                  placeholder="Name"
                  value={nok.name}
                  onChange={(e) => {
                    setNok({ ...nok, name: e.target.value });
                  }}
                />
                <input
                  className={inputClass}
                  aria-label="Relationship"
                  placeholder="Relationship"
                  value={nok.relationship}
                  onChange={(e) => {
                    setNok({ ...nok, relationship: e.target.value });
                  }}
                />
                <select
                  className={inputClass}
                  aria-label="Identity document"
                  value={nok.idType}
                  onChange={(e) => {
                    setNok({ ...nok, idType: e.target.value });
                  }}
                >
                  {ID_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace(/_/gu, ' ')}
                    </option>
                  ))}
                </select>
                <input
                  className={inputClass}
                  aria-label="Document reference"
                  placeholder="Document reference"
                  value={nok.idRef}
                  onChange={(e) => {
                    setNok({ ...nok, idRef: e.target.value });
                  }}
                />
              </div>
              <Button
                size="sm"
                disabled={verify.isPending || nok.name.trim() === '' || nok.idRef.trim() === ''}
                onClick={() => {
                  verify.mutate();
                }}
              >
                Record the verification
              </Button>
              {verify.error === null ? null : <ProblemCard error={verify.error} />}
            </div>
          ) : null}

          {granted.has('mortuary.release.manage') && open.releasedAt === null ? (
            <div className="flex flex-col gap-3 border-t border-default pt-4">
              <h3 className="text-sm font-semibold text-fg-default">Release</h3>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex w-64 flex-col gap-1">
                  <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="mor-tag">
                    Scan the tag at the door
                  </label>
                  <input
                    id="mor-tag"
                    className={inputClass}
                    value={tag}
                    onChange={(e) => {
                      setTag(e.target.value);
                    }}
                  />
                </div>
                <Button
                  size="sm"
                  disabled={release.isPending || tag.trim() === '' || gates?.releasable !== true}
                  onClick={() => {
                    release.mutate();
                  }}
                >
                  Release the body
                </Button>
              </div>
              {gates !== undefined && gates.blockers.length > 0 ? (
                <ul className="flex flex-col gap-1 text-2xs text-fg-warning">
                  {gates.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              ) : null}
              {release.error === null ? null : <ProblemCard error={release.error} />}
            </div>
          ) : null}
        </div>
      )}

      <p className="text-2xs text-fg-subtle">
        A body is released to a next of kin whose identity was checked against a document, never while a
        medico-legal case is open, never without a certificate of cause of death, and never before a required
        post-mortem. Nobody in the building can waive any of the four.
      </p>
    </section>
  );
}
