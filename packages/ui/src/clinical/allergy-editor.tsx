'use client';

import { AlertTriangle, Ban, BadgeCheck, CircleHelp, Plus, ShieldQuestion, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { cn } from '../lib/cn.js';
import { Badge } from '../primitives/badge.js';
import { Button } from '../primitives/button.js';
import { Input } from '../primitives/input.js';
import { Label } from '../primitives/label.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../primitives/select.js';
import type { AllergyStatus } from './patient-banner.js';

/**
 * `AllergyEditor` — the structured allergy record behind docs/06 §4.2, §5.2 #16
 * (`AllergyAlertDialog`) and the CDSS hard stop that arrives with EN-029.
 *
 * The whole point of this file is that **the dangerous states are unrepresentable**:
 *
 *   - `AllergyStatement` is a discriminated union, so "nobody has asked",
 *     "we could not ask", "the patient says none" and "here are the allergies" are four
 *     different values. docs/06 §10: *"an empty allergy area that could mean 'none' or
 *     'not asked'"* is listed as a defect.
 *   - the `known` arm carries a **non-empty tuple** (`[AllergyEntry, ...AllergyEntry[]]`),
 *     so `{ kind: 'known', entries: [] }` — "there are allergies but the list is empty" —
 *     does not type-check.
 *   - `none-known` carries **who asserted it and when**. An unattributed "no allergies"
 *     is not a clinical fact, and the banner has to print the verification date (§4.2).
 *   - `unable-to-assess` carries a **reason**. It is never folded into `none-known`.
 *   - each entry's `verification` is its own union, so an *unverified* allergy can never
 *     be mistaken for a confirmed one, and a *refuted* one keeps its history instead of
 *     being deleted.
 *   - reactions are `documented` (non-empty) or explicitly `not-documented` — an empty
 *     reaction array cannot silently mean "no reaction".
 *
 * `isSafeToAssumeNoAllergy` is the single predicate downstream CDSS code should call.
 * It returns `true` for exactly one of the four states.
 */

export type AllergenCategory =
  'drug' | 'drug-class' | 'food' | 'environment' | 'contrast-media' | 'latex' | 'other';

/** FHIR AllergyIntolerance criticality. `unable-to-assess` is explicit, never absent. */
export type AllergyCriticality = 'low' | 'high' | 'unable-to-assess';

/** `unknown` is a value, not a missing field: "severity not established" is a fact. */
export type AllergySeverity = 'mild' | 'moderate' | 'severe' | 'unknown';

export type AllergyReactions =
  | { readonly kind: 'documented'; readonly reactions: readonly [string, ...string[]] }
  /** The allergy is real but nobody recorded what happened. Not the same as "no reaction". */
  | { readonly kind: 'not-documented' };

export type AllergyVerification =
  /** Recorded from history/self-report and not yet confirmed by a clinician. */
  | { readonly kind: 'unverified' }
  | { readonly kind: 'confirmed'; readonly by: string; readonly on: string }
  /** Investigated and found not to be an allergy. Kept, never deleted (docs/06 §1.2.6). */
  | { readonly kind: 'refuted'; readonly by: string; readonly on: string };

export interface AllergyEntry {
  readonly id: string;
  /** Coded where possible; `display` is what the clinician sees and what prints. */
  readonly allergen: {
    readonly code?: string;
    readonly display: string;
    readonly category: AllergenCategory;
  };
  readonly reactions: AllergyReactions;
  readonly severity: AllergySeverity;
  readonly criticality: AllergyCriticality;
  /** Already-formatted `dd-MM-yyyy` (docs/06 §1.2.10). */
  readonly onset?: string;
  readonly verification: AllergyVerification;
  readonly recordedBy?: string;
  readonly recordedOn?: string;
}

export type AllergyStatement =
  /** Nobody has asked yet. The banner shows the amber "Allergies not recorded" chip. */
  | { readonly kind: 'not-recorded' }
  /** Asked, but could not be established (unconscious, no informant). Reason mandatory. */
  | { readonly kind: 'unable-to-assess'; readonly reason: string }
  /** The explicit positive state, attributed and dated (docs/06 §4.2). */
  | { readonly kind: 'none-known'; readonly assertedBy: string; readonly assertedOn: string }
  /** Non-empty by construction. */
  | { readonly kind: 'known'; readonly entries: readonly [AllergyEntry, ...AllergyEntry[]] };

/**
 * The ONLY predicate a prescribing/CDSS path may use to decide that an allergy check
 * has nothing to match against. `not-recorded` and `unable-to-assess` both mean
 * "you do not know", which is not the same as "there are none".
 */
export function isSafeToAssumeNoAllergy(statement: AllergyStatement): boolean {
  return statement.kind === 'none-known';
}

/** Entries that must be matched against by CDSS: everything except refuted ones. */
export function activeAllergies(statement: AllergyStatement): readonly AllergyEntry[] {
  return statement.kind === 'known'
    ? statement.entries.filter((entry) => entry.verification.kind !== 'refuted')
    : [];
}

export interface BannerStatusLabels {
  /** e.g. `(reason) => \`Allergies unable to assess — ${reason}\`` */
  readonly unableToAssess: (reason: string) => string;
  /** Localised reaction summary when an entry has no documented reaction. */
  readonly reactionNotDocumented: string;
}

/**
 * Projects the editor's rich statement onto the banner's `AllergyStatus`, preserving
 * every distinction: `unable-to-assess` maps to the banner's own `unable-to-assess`
 * arm, never to `none-known`.
 */
export function bannerStatusFor(statement: AllergyStatement, labels: BannerStatusLabels): AllergyStatus {
  switch (statement.kind) {
    case 'not-recorded':
      return { kind: 'not-recorded' };
    case 'unable-to-assess':
      return { kind: 'unable-to-assess', reason: labels.unableToAssess(statement.reason) };
    case 'none-known':
      return { kind: 'none-known', verifiedOn: statement.assertedOn };
    case 'known': {
      const active = activeAllergies(statement);
      if (active.length === 0) {
        // Every entry has been refuted. That is "we looked and found none", but it is
        // still not an unattributed blank: keep it as a warning rather than a green tick.
        return { kind: 'not-recorded' };
      }
      return {
        kind: 'known',
        allergies: active.map((entry) => ({
          substance: entry.allergen.display,
          reaction:
            entry.reactions.kind === 'documented'
              ? entry.reactions.reactions.join(', ')
              : labels.reactionNotDocumented,
          severity: entry.severity === 'unknown' ? 'moderate' : entry.severity,
          ...(entry.recordedBy === undefined ? {} : { recordedBy: entry.recordedBy }),
          ...(entry.recordedOn === undefined ? {} : { recordedOn: entry.recordedOn }),
        })),
      };
    }
  }
}

export interface CodedOption {
  readonly code: string;
  /** Already-localised. */
  readonly label: string;
}

export interface AllergyEditorLabels {
  readonly region: string;
  readonly statusHeading: string;
  readonly notRecorded: string;
  readonly notRecordedAction: string;
  readonly unableToAssess: (reason: string) => string;
  readonly noneKnown: (by: string, on: string) => string;
  readonly declareNoneKnown: string;
  readonly declareUnableToAssess: string;
  readonly unableToAssessReasonLabel: string;
  readonly unableToAssessReasonPlaceholder: string;
  readonly addAllergy: string;
  readonly allergenLabel: string;
  readonly allergenPlaceholder: string;
  readonly categoryLabel: string;
  readonly category: Readonly<Record<AllergenCategory, string>>;
  readonly reactionLabel: string;
  readonly reactionPlaceholder: string;
  readonly reactionNotDocumented: string;
  readonly severityLabel: string;
  readonly severity: Readonly<Record<AllergySeverity, string>>;
  readonly criticalityLabel: string;
  readonly criticality: Readonly<Record<AllergyCriticality, string>>;
  readonly verificationUnverified: string;
  readonly verificationConfirmed: (by: string, on: string) => string;
  readonly verificationRefuted: (by: string, on: string) => string;
  readonly confirm: string;
  readonly refute: string;
  readonly remove: string;
  readonly save: string;
  readonly cancel: string;
  readonly listLabel: string;
  readonly recordedByPrefix: string;
}

export interface AllergyEditorProps {
  readonly statement: AllergyStatement;
  readonly onChange: (statement: AllergyStatement) => void;
  readonly labels: AllergyEditorLabels;
  /** The signed-in clinician and today's date — a component never reads a clock. */
  readonly asserter: { readonly name: string; readonly on: string };
  /** Coded list for `unable-to-assess`; a free-text-only reason is not acceptable. */
  readonly unableToAssessReasons: readonly CodedOption[];
  /**
   * Injected id factory. `Math.random` is banned repo-wide (CLAUDE.md §4) and a
   * component must not mint a persistent identifier on its own.
   */
  readonly newEntryId: () => string;
  /** Only roles with the verification permission may confirm or refute (docs/05). */
  readonly canVerify?: boolean;
  readonly className?: string;
}

const CATEGORIES: readonly AllergenCategory[] = [
  'drug',
  'drug-class',
  'food',
  'environment',
  'contrast-media',
  'latex',
  'other',
];
const SEVERITIES: readonly AllergySeverity[] = ['mild', 'moderate', 'severe', 'unknown'];
const CRITICALITIES: readonly AllergyCriticality[] = ['high', 'low', 'unable-to-assess'];

function VerificationChip({
  verification,
  labels,
}: {
  readonly verification: AllergyVerification;
  readonly labels: AllergyEditorLabels;
}): React.JSX.Element {
  switch (verification.kind) {
    case 'unverified':
      return (
        <Badge tone="warning" data-verification="unverified" icon={<ShieldQuestion aria-hidden="true" />}>
          {labels.verificationUnverified}
        </Badge>
      );
    case 'confirmed':
      return (
        <Badge tone="success" data-verification="confirmed" icon={<BadgeCheck aria-hidden="true" />}>
          {labels.verificationConfirmed(verification.by, verification.on)}
        </Badge>
      );
    case 'refuted':
      return (
        <Badge tone="neutral" data-verification="refuted" icon={<CircleHelp aria-hidden="true" />}>
          {labels.verificationRefuted(verification.by, verification.on)}
        </Badge>
      );
  }
}

/** The four statements, each rendered so it can never be read as one of the others. */
function StatementBanner({
  statement,
  labels,
}: {
  readonly statement: AllergyStatement;
  readonly labels: AllergyEditorLabels;
}): React.JSX.Element | null {
  switch (statement.kind) {
    case 'not-recorded':
      return (
        <p
          data-statement="not-recorded"
          className={cn(
            'flex items-center gap-2 rounded-md border border-warning-border',
            'bg-warning-surface px-3 py-2 text-md text-warning-on-surface',
          )}
        >
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          <span>{labels.notRecorded}</span>
          <span className="text-xs">{labels.notRecordedAction}</span>
        </p>
      );
    case 'unable-to-assess':
      return (
        <p
          data-statement="unable-to-assess"
          className={cn(
            'flex items-center gap-2 rounded-md border border-violet-border',
            'bg-violet-surface px-3 py-2 text-md text-violet-on-surface',
          )}
        >
          <ShieldQuestion aria-hidden="true" className="size-4 shrink-0" />
          {labels.unableToAssess(statement.reason)}
        </p>
      );
    case 'none-known':
      return (
        <p
          data-statement="none-known"
          className={cn(
            'flex items-center gap-2 rounded-md border border-success-border',
            'bg-success-surface px-3 py-2 text-md text-success-on-surface',
          )}
        >
          <BadgeCheck aria-hidden="true" className="size-4 shrink-0" />
          {labels.noneKnown(statement.assertedBy, statement.assertedOn)}
        </p>
      );
    case 'known':
      return null;
  }
}

export function AllergyEditor({
  statement,
  onChange,
  labels,
  asserter,
  unableToAssessReasons,
  newEntryId,
  canVerify = false,
  className,
}: AllergyEditorProps): React.JSX.Element {
  const fieldId = useId();
  const [adding, setAdding] = useState(false);
  const [draftAllergen, setDraftAllergen] = useState('');
  const [draftCategory, setDraftCategory] = useState<AllergenCategory>('drug');
  const [draftReaction, setDraftReaction] = useState('');
  const [draftSeverity, setDraftSeverity] = useState<AllergySeverity>('unknown');
  const [draftCriticality, setDraftCriticality] = useState<AllergyCriticality>('unable-to-assess');

  const entries = statement.kind === 'known' ? statement.entries : [];

  const replaceEntries = (next: readonly AllergyEntry[]): void => {
    const [first, ...rest] = next;
    if (first === undefined) {
      // Removing the last entry cannot silently become "no known allergies" — the
      // record goes back to "not recorded" until a human asserts something.
      onChange({ kind: 'not-recorded' });
      return;
    }
    onChange({ kind: 'known', entries: [first, ...rest] });
  };

  const resetDraft = (): void => {
    setAdding(false);
    setDraftAllergen('');
    setDraftCategory('drug');
    setDraftReaction('');
    setDraftSeverity('unknown');
    setDraftCriticality('unable-to-assess');
  };

  const commitDraft = (): void => {
    const allergen = draftAllergen.trim();
    if (allergen === '') return;
    const reactionText = draftReaction.trim();
    const entry: AllergyEntry = {
      id: newEntryId(),
      allergen: { display: allergen, category: draftCategory },
      reactions:
        reactionText === '' ? { kind: 'not-documented' } : { kind: 'documented', reactions: [reactionText] },
      severity: draftSeverity,
      criticality: draftCriticality,
      // A newly typed allergy is always UNVERIFIED. There is no code path that
      // creates a confirmed entry, because the person typing is not the evidence.
      verification: { kind: 'unverified' },
      recordedBy: asserter.name,
      recordedOn: asserter.on,
    };
    replaceEntries([...entries, entry]);
    resetDraft();
  };

  const setVerification = (id: string, verification: AllergyVerification): void => {
    replaceEntries(entries.map((entry) => (entry.id === id ? { ...entry, verification } : entry)));
  };

  return (
    <section
      data-slot="allergy-editor"
      data-statement-kind={statement.kind}
      role="region"
      aria-label={labels.region}
      className={cn('flex flex-col gap-3', className)}
    >
      <h3 className="text-md font-semibold text-fg-default">{labels.statusHeading}</h3>

      <StatementBanner statement={statement} labels={labels} />

      {statement.kind === 'known' ? (
        <ul aria-label={labels.listLabel} className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li
              key={entry.id}
              data-allergy-id={entry.id}
              data-verification-kind={entry.verification.kind}
              className={cn(
                'flex flex-col gap-1 rounded-md border p-2',
                entry.verification.kind === 'refuted'
                  ? 'border-default bg-layer-3 text-fg-muted'
                  : 'border-danger-border bg-danger-surface text-danger-on-surface',
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Ban aria-hidden="true" className="size-4 shrink-0" />
                <span
                  className={cn(
                    'text-md font-semibold',
                    entry.verification.kind === 'refuted' ? 'line-through' : '',
                  )}
                >
                  {entry.allergen.display}
                </span>
                <span className="text-xs">{labels.category[entry.allergen.category]}</span>
                <span className="text-xs">
                  {entry.reactions.kind === 'documented'
                    ? entry.reactions.reactions.join(', ')
                    : labels.reactionNotDocumented}
                </span>
                <span className="text-xs">{labels.severity[entry.severity]}</span>
                <span className="text-xs">{labels.criticality[entry.criticality]}</span>
                <VerificationChip verification={entry.verification} labels={labels} />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {entry.recordedBy === undefined ? null : (
                  <span className="text-2xs">
                    {labels.recordedByPrefix} {entry.recordedBy} {entry.recordedOn ?? ''}
                  </span>
                )}
                {canVerify && entry.verification.kind !== 'confirmed' ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setVerification(entry.id, {
                        kind: 'confirmed',
                        by: asserter.name,
                        on: asserter.on,
                      });
                    }}
                  >
                    {labels.confirm}
                  </Button>
                ) : null}
                {canVerify && entry.verification.kind !== 'refuted' ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setVerification(entry.id, {
                        kind: 'refuted',
                        by: asserter.name,
                        on: asserter.on,
                      });
                    }}
                  >
                    {labels.refute}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    replaceEntries(entries.filter((other) => other.id !== entry.id));
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  {labels.remove}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {adding ? (
        <div className="flex flex-col gap-2 rounded-md border border-default bg-layer-3 p-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${fieldId}-allergen`} required>
              {labels.allergenLabel}
            </Label>
            <Input
              id={`${fieldId}-allergen`}
              value={draftAllergen}
              autoComplete="off"
              aria-required="true"
              placeholder={labels.allergenPlaceholder}
              onChange={(event) => {
                setDraftAllergen(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitDraft();
                }
              }}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={`${fieldId}-category`}>{labels.categoryLabel}</Label>
            <Select
              value={draftCategory}
              onValueChange={(value) => {
                setDraftCategory(value as AllergenCategory);
              }}
            >
              <SelectTrigger id={`${fieldId}-category`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((category) => (
                  <SelectItem key={category} value={category}>
                    {labels.category[category]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={`${fieldId}-reaction`}>{labels.reactionLabel}</Label>
            <Input
              id={`${fieldId}-reaction`}
              value={draftReaction}
              autoComplete="off"
              placeholder={labels.reactionPlaceholder}
              aria-describedby={`${fieldId}-reaction-hint`}
              onChange={(event) => {
                setDraftReaction(event.target.value);
              }}
            />
            <p id={`${fieldId}-reaction-hint`} className="text-xs text-fg-muted">
              {labels.reactionNotDocumented}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="flex min-w-40 flex-1 flex-col gap-1">
              <Label htmlFor={`${fieldId}-severity`}>{labels.severityLabel}</Label>
              <Select
                value={draftSeverity}
                onValueChange={(value) => {
                  setDraftSeverity(value as AllergySeverity);
                }}
              >
                <SelectTrigger id={`${fieldId}-severity`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map((severity) => (
                    <SelectItem key={severity} value={severity}>
                      {labels.severity[severity]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex min-w-40 flex-1 flex-col gap-1">
              <Label htmlFor={`${fieldId}-criticality`}>{labels.criticalityLabel}</Label>
              <Select
                value={draftCriticality}
                onValueChange={(value) => {
                  setDraftCriticality(value as AllergyCriticality);
                }}
              >
                <SelectTrigger id={`${fieldId}-criticality`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CRITICALITIES.map((criticality) => (
                    <SelectItem key={criticality} value={criticality}>
                      {labels.criticality[criticality]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" disabled={draftAllergen.trim() === ''} onClick={commitDraft}>
              {labels.save}
            </Button>
            <Button variant="ghost" size="sm" onClick={resetDraft}>
              {labels.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            data-action="add-allergy"
            onClick={() => {
              setAdding(true);
            }}
          >
            <Plus aria-hidden="true" />
            {labels.addAllergy}
          </Button>

          {statement.kind === 'none-known' ? null : (
            <Button
              variant="secondary"
              size="sm"
              data-action="declare-none-known"
              disabled={statement.kind === 'known'}
              onClick={() => {
                onChange({
                  kind: 'none-known',
                  assertedBy: asserter.name,
                  assertedOn: asserter.on,
                });
              }}
            >
              {labels.declareNoneKnown}
            </Button>
          )}

          {statement.kind === 'known' ? null : (
            <div className="flex items-center gap-2">
              <Label htmlFor={`${fieldId}-unable`} className="text-xs">
                {labels.unableToAssessReasonLabel}
              </Label>
              <Select
                value={statement.kind === 'unable-to-assess' ? statement.reason : ''}
                onValueChange={(value) => {
                  onChange({ kind: 'unable-to-assess', reason: value });
                }}
              >
                <SelectTrigger
                  id={`${fieldId}-unable`}
                  data-action="declare-unable-to-assess"
                  className="w-56"
                  aria-label={labels.declareUnableToAssess}
                >
                  <SelectValue placeholder={labels.unableToAssessReasonPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {unableToAssessReasons.map((reason) => (
                    <SelectItem key={reason.code} value={reason.label}>
                      {reason.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
