'use client';

import { Badge, Button, Kbd, Label, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from '@vims/ui';
import { useId } from 'react';
import { Check, Info, Lock, TriangleAlert } from '@/lib/icons';
import { NOTE_SECTIONS, type ConflictedSection, type NoteDraft } from '../lib/note';

/**
 * The consultation note — OP-002 §3.2, §8 ("note editor tabs").
 *
 * ## A signed note is never edited
 *
 * The editor is writable while the encounter is a draft and **read-only the
 * instant it is signed**. Not disabled-looking-editable, not editable-then-
 * refused: the textareas are replaced by the signed text. `docs/03` and OP-002
 * §14 AC-9 make a finalised clinical document immutable and hash-chained, and an
 * "edit" is a new version carrying a reason. A screen that lets a doctor type
 * into a signed note and then refuses the save has already wasted the thing that
 * matters most on this screen, which is their time.
 *
 * ## Nothing is truncated
 *
 * "Clinical text fields: no truncation, no silent loss" (phase-02 §Constraints).
 * There is no `maxLength` on any field here, no character counter that stops
 * input, and the autosave state is reported rather than assumed — a doctor can
 * always see whether what they typed has reached the server.
 *
 * ## The conflict is shown, never merged
 *
 * A `409` from the optimistic lock renders both versions of every section that
 * differs. The screen does not merge them: a machine merging two clinical
 * narratives is how half a sentence from each ends up in the record.
 */

export type AutosaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'saved'; readonly at: string }
  | { readonly kind: 'queued'; readonly at: string }
  | { readonly kind: 'failed'; readonly message: string };

export function NoteEditor({
  draft,
  onChange,
  readOnly,
  autosave,
  conflicts,
  onKeepMine,
  onTakeTheirs,
}: {
  readonly draft: NoteDraft;
  readonly onChange: (next: NoteDraft) => void;
  readonly readOnly: boolean;
  readonly autosave: AutosaveState;
  readonly conflicts: readonly ConflictedSection[];
  readonly onKeepMine?: () => void;
  readonly onTakeTheirs?: () => void;
}): React.JSX.Element {
  const baseId = useId();

  return (
    <section className="flex flex-col gap-3" data-testid="note-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-md font-medium text-fg-default">Consultation note</h2>
        <AutosaveIndicator state={autosave} readOnly={readOnly} />
      </div>

      {conflicts.length === 0 ? null : (
        <div
          role="alert"
          data-testid="note-conflict"
          className="rounded-lg border border-warning-border bg-warning-surface p-3"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-warning-on-surface">
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            This note was changed somewhere else while you were typing
          </p>
          <p className="mt-1 text-sm text-warning-on-surface">
            Nothing has been overwritten. Both versions are below — decide which text is right, then save
            again.
          </p>
          <ul className="mt-3 flex flex-col gap-3">
            {conflicts.map((section) => (
              <li key={section.key} className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <div>
                  <p className="text-2xs font-medium text-warning-on-surface">{section.label} — yours</p>
                  <p
                    className="whitespace-pre-wrap text-sm text-fg-default"
                    data-testid={`conflict-mine-${section.key}`}
                  >
                    {section.mine === '' ? '(empty)' : section.mine}
                  </p>
                </div>
                <div>
                  <p className="text-2xs font-medium text-warning-on-surface">
                    {section.label} — on the server
                  </p>
                  <p
                    className="whitespace-pre-wrap text-sm text-fg-default"
                    data-testid={`conflict-theirs-${section.key}`}
                  >
                    {section.theirs === '' ? '(empty)' : section.theirs}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            {onKeepMine === undefined ? null : (
              <Button variant="secondary" size="sm" data-testid="conflict-keep-mine" onClick={onKeepMine}>
                Keep my text and save again
              </Button>
            )}
            {onTakeTheirs === undefined ? null : (
              <Button variant="ghost" size="sm" data-testid="conflict-take-theirs" onClick={onTakeTheirs}>
                Discard mine and load the server’s
              </Button>
            )}
          </div>
        </div>
      )}

      {readOnly ? (
        <div className="flex flex-col gap-3" data-testid="note-readonly">
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <Lock className="size-4 shrink-0" aria-hidden="true" />
            This note is signed. It cannot be edited — an amendment creates a new version with a reason, and
            the signed version stays exactly as it is.
          </p>
          {NOTE_SECTIONS.map((section) => (
            <div key={section.key}>
              <p className="text-2xs font-medium uppercase tracking-[0.06em] text-fg-subtle">
                {section.label}
              </p>
              <p
                className="mt-1 whitespace-pre-wrap text-sm text-fg-default"
                data-testid={`note-signed-${section.key}`}
              >
                {draft[section.key] === '' ? 'Nothing recorded.' : draft[section.key]}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <Tabs defaultValue={NOTE_SECTIONS[0]?.key ?? 'chiefComplaint'}>
          <TabsList aria-label="Note sections">
            {NOTE_SECTIONS.map((section, index) => (
              <TabsTrigger key={section.key} value={section.key} data-testid={`note-tab-${section.key}`}>
                {section.label}
                <Kbd className="ml-1">{`Alt+${String(index + 1)}`}</Kbd>
              </TabsTrigger>
            ))}
          </TabsList>
          {NOTE_SECTIONS.map((section) => (
            <TabsContent key={section.key} value={section.key}>
              <Label htmlFor={`${baseId}-${section.key}`} className="sr-only">
                {section.label}
              </Label>
              <Textarea
                id={`${baseId}-${section.key}`}
                data-testid={`note-field-${section.key}`}
                className="min-h-40 text-sm"
                value={draft[section.key]}
                spellCheck
                onChange={(event) => {
                  onChange({ ...draft, [section.key]: event.target.value });
                }}
              />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </section>
  );
}

function AutosaveIndicator({
  state,
  readOnly,
}: {
  readonly state: AutosaveState;
  readonly readOnly: boolean;
}): React.JSX.Element | null {
  if (readOnly) return null;

  switch (state.kind) {
    case 'idle':
      return (
        <Badge tone="neutral" data-testid="autosave-idle" icon={<Info aria-hidden="true" />}>
          Not saved yet
        </Badge>
      );
    case 'pending':
      return (
        <Badge tone="info" data-testid="autosave-pending" icon={<Info aria-hidden="true" />}>
          Saving…
        </Badge>
      );
    case 'saved':
      return (
        <Badge tone="success" data-testid="autosave-saved" icon={<Check aria-hidden="true" />}>
          Saved {state.at}
        </Badge>
      );
    case 'queued':
      return (
        <Badge tone="warning" data-testid="autosave-queued" icon={<TriangleAlert aria-hidden="true" />}>
          Held on this device since {state.at} — not on the server
        </Badge>
      );
    case 'failed':
      return (
        <Badge tone="danger" data-testid="autosave-failed" icon={<TriangleAlert aria-hidden="true" />}>
          {state.message}
        </Badge>
      );
  }
}
