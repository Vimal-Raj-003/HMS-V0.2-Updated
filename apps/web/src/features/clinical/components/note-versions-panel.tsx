'use client';

import { Badge, EmptyState } from '@vims/ui';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { Check, ShieldAlert, TriangleAlert } from '@/lib/icons';
import type { NoteHistory } from '../api/types';
import { draftFromContent, NOTE_SECTIONS } from '../lib/note';
import { formatInstant } from '../lib/numbers';

/**
 * The note's version history — OP-002 §14 AC-9, phase-02 exit gate 4.
 *
 * "Amend a signed note → new version, **old version intact**, reason captured,
 * audit chain valid." All four are visible here, because a versioning scheme
 * nobody can inspect is indistinguishable from an overwrite:
 *
 *  - every version is listed, newest first, with who signed it and when;
 *  - the amendment reason is printed against the version it produced;
 *  - the two most recent versions are shown **side by side**, section by
 *    section, so what changed is legible without a diff tool;
 *  - the hash chain's verification is rendered as a fact rather than assumed. A
 *    chain that fails verification is a tampered or corrupted record, and this
 *    screen says so loudly rather than showing the text as though nothing were
 *    wrong.
 */
export function NoteVersionsPanel({
  history,
  loading,
  error,
  onRetry,
}: {
  readonly history: NoteHistory | undefined;
  readonly loading: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
}): React.JSX.Element {
  const versions = history?.versions ?? [];
  // The API returns newest-first; the comparison wants the two most recent.
  const [newest, previous] = versions;

  return (
    <section aria-label="Note versions" data-testid="note-versions" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-md font-medium text-fg-default">Versions</h2>
        {history === undefined ? null : history.chain.valid ? (
          <Badge tone="success" data-testid="chain-valid" icon={<Check aria-hidden="true" />}>
            Hash chain verified
          </Badge>
        ) : (
          <Badge tone="danger" data-testid="chain-invalid" icon={<ShieldAlert aria-hidden="true" />}>
            Hash chain does not verify — report this
          </Badge>
        )}
      </div>

      <AsyncPanel
        loading={loading}
        error={error}
        isEmpty={versions.length === 0}
        skeletonLabel="Loading the note's versions"
        skeletonRows={3}
        onRetry={onRetry}
        empty={
          <EmptyState
            cause="This consultation has no signed version yet."
            nextAction="A version is created when the note is signed; amending a signed note creates the next one."
          />
        }
      >
        <div className="flex flex-col gap-4">
          <ol className="flex flex-col gap-2">
            {versions.map((version) => (
              <li
                key={version.version}
                className="rounded-md border border-default bg-layer-1 p-2"
                data-testid={`note-version-${String(version.version)}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={version.superseded_at === null ? 'accent' : 'neutral'}>
                    v{version.version}
                  </Badge>
                  <Badge tone="neutral" size="sm">
                    {version.status}
                  </Badge>
                  <span className="text-2xs text-fg-muted">
                    {version.signed_at === null
                      ? `drafted ${formatInstant(version.created_at)}`
                      : `signed ${formatInstant(version.signed_at)}`}
                  </span>
                  {version.superseded_at === null ? null : (
                    <span className="text-2xs text-fg-subtle">
                      superseded by v{version.superseded_by_version ?? '?'}
                    </span>
                  )}
                </div>
                {version.amendment_reason === null ? null : (
                  <p className="mt-1 text-sm text-fg-default" data-testid="amendment-reason">
                    Reason for the amendment: {version.amendment_reason}
                  </p>
                )}
                <p className="mt-1 font-mono text-3xs text-fg-subtle">
                  sha256 {version.content_sha256.slice(0, 16)}…
                </p>
              </li>
            ))}
          </ol>

          {newest === undefined || previous === undefined ? null : (
            <div data-testid="version-comparison">
              <p className="flex items-center gap-2 text-sm font-medium text-fg-default">
                <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />v{previous.version} and v
                {newest.version}, side by side
              </p>
              <ul className="mt-2 flex flex-col gap-3">
                {NOTE_SECTIONS.map((section) => {
                  const before = draftFromContent(previous.content)[section.key];
                  const after = draftFromContent(newest.content)[section.key];
                  if (before.trim() === after.trim()) return null;
                  return (
                    <li key={section.key} className="grid grid-cols-1 gap-2 md:grid-cols-2">
                      <div>
                        <p className="text-2xs font-medium text-fg-subtle">
                          {section.label} — v{previous.version}
                        </p>
                        <p
                          className="whitespace-pre-wrap text-sm text-fg-muted"
                          data-testid={`version-before-${section.key}`}
                        >
                          {before === '' ? '(empty)' : before}
                        </p>
                      </div>
                      <div>
                        <p className="text-2xs font-medium text-fg-subtle">
                          {section.label} — v{newest.version}
                        </p>
                        <p
                          className="whitespace-pre-wrap text-sm text-fg-default"
                          data-testid={`version-after-${section.key}`}
                        >
                          {after === '' ? '(empty)' : after}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </AsyncPanel>
    </section>
  );
}
