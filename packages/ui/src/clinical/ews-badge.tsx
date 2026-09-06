import { cn } from '../lib/cn.js';

/**
 * `EWSBadge` — docs/06 §5.2 #5: "`type(news2/pews/mews/meows/qsofa), total, band,
 * scale`. Band colour + numeral + 'Scale 2' marker + required-action sentence.
 * Click → component breakdown. **Never shown without the action text.**"
 *
 * That last sentence is the component. An early-warning score is not a label, it
 * is an instruction — "7" means *escalate to the registrar and observe
 * continuously*, and a badge that shows the 7 without saying so has converted an
 * instruction back into trivia. So `requiredAction` is a required prop: a badge
 * with no action text does not compile.
 *
 * Two further rules come out of `docs/PROGRESS.md`'s Phase-2 note that "NEWS2 is
 * scored only when all five components are present, because a partial score
 * reading 'low risk' is the dangerous failure":
 *
 *   - the score is a discriminated union, so `{ kind: 'incomplete' }` is a real
 *     state with its own rendering rather than a `null` total that falls through
 *     to a green badge;
 *   - `--ews-*` bands are only ever applied to a *scored* badge. An incomplete
 *     one is neutral and says which observations are missing.
 *
 * `scale` carries the COPD case: NEWS2 Scale 2 changes the oxygen-saturation
 * scoring for patients with hypercapnic respiratory failure, and a Scale 2 score
 * read as Scale 1 is wrong in the direction that under-escalates.
 */

export type EwsType = 'news2' | 'pews' | 'mews' | 'meows' | 'qsofa';

/** The four NEWS2 bands (§3.5 `--ews-*`). */
export type EwsBand = 'low' | 'low-medium' | 'medium' | 'high';

export type EwsScore =
  /**
   * Not every component was recorded, so there is no score. Rendering this as
   * "0 — low risk" is the failure the union exists to prevent.
   */
  | { readonly kind: 'incomplete'; readonly missing: readonly string[] }
  | { readonly kind: 'scored'; readonly total: number; readonly band: EwsBand };

const BAND_CLASS: Record<EwsBand, string> = {
  low: 'bg-ews-low-bg text-ews-low-fg',
  'low-medium': 'bg-ews-low-medium-bg text-ews-low-medium-fg',
  medium: 'bg-ews-medium-bg text-ews-medium-fg',
  high: 'bg-ews-high-bg text-ews-high-fg',
};

/**
 * Secondary encoding, for the same reason `ResultFlag` carries a glyph: the four
 * bands are green → amber → dark amber → red, and amber against dark amber is
 * not a distinction to bet an escalation on.
 */
const BAND_MARK: Record<EwsBand, string> = {
  low: '○',
  'low-medium': '◔',
  medium: '◑',
  high: '●',
};

export interface EwsBadgeLabels {
  /** e.g. "NEWS2". Shown, so it is the caller's job to localise the acronym. */
  readonly scoreName: string;
  /** e.g. "medium risk". */
  readonly band: string;
  /**
   * §5.2 #5 — the sentence that makes the number actionable. e.g. "Register a
   * medical review within 1 hour and increase observations to hourly."
   */
  readonly requiredAction: string;
  /** e.g. "Scale 2 (hypercapnic respiratory failure)". Only for NEWS2. */
  readonly scaleMarker?: string;
  /** e.g. "Not scored — respiratory rate and consciousness are not recorded." */
  readonly incomplete?: string;
  /** Accessible name for the breakdown control, e.g. "Show score breakdown". */
  readonly breakdown?: string;
}

export interface EwsBadgeProps {
  readonly type: EwsType;
  readonly score: EwsScore;
  readonly labels: EwsBadgeLabels;
  /** §5.2 #5 — "Click → component breakdown". */
  readonly onShowBreakdown?: () => void;
  readonly className?: string;
}

export function EwsBadge({
  type,
  score,
  labels,
  onShowBreakdown,
  className,
}: EwsBadgeProps): React.JSX.Element {
  const interactive = onShowBreakdown !== undefined;

  const body =
    score.kind === 'incomplete' ? (
      <>
        <span
          className={cn(
            'flex h-9 min-w-9 items-center justify-center rounded-md px-2',
            // Deliberately neutral, never a band colour: an unscored patient is
            // not a low-risk patient.
            'bg-sunken text-fg-muted font-display text-xl font-semibold',
          )}
        >
          —
        </span>
        <span className="flex flex-col items-start gap-0.5 text-left">
          <span className="text-fg-default text-xs font-medium">{labels.scoreName}</span>
          <span className="text-fg-muted text-2xs">{labels.incomplete ?? score.missing.join(', ')}</span>
        </span>
      </>
    ) : (
      <>
        <span
          className={cn(
            'flex h-9 min-w-9 items-center justify-center rounded-md px-2',
            'font-display text-xl font-semibold tabular-nums slashed-zero',
            BAND_CLASS[score.band],
          )}
        >
          <span aria-hidden="true" className="mr-1 text-xs">
            {BAND_MARK[score.band]}
          </span>
          {score.total}
        </span>
        <span className="flex flex-col items-start gap-0.5 text-left">
          <span className="text-fg-default text-xs font-medium">
            {labels.scoreName}
            {labels.scaleMarker === undefined ? null : (
              <span className="text-fg-muted ml-1 font-normal">{labels.scaleMarker}</span>
            )}
          </span>
          {/*
            The action text, and it is not truncated. §5.2 #5's "never shown
            without the action text" is only honoured if the sentence is legible;
            an ellipsis in the middle of "escalate to the registrar" is the same
            defect wearing a different hat.
          */}
          <span className="text-fg-muted max-w-[42ch] text-2xs">{labels.requiredAction}</span>
        </span>
      </>
    );

  const shared = cn(
    'inline-flex items-center gap-2.5 rounded-lg border border-default bg-layer-1 p-1.5 pr-3 text-left',
    interactive &&
      'hover:bg-layer-3 focus-visible:outline-focus cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-offset-2',
    className,
  );

  const accessibleName =
    score.kind === 'incomplete'
      ? `${labels.scoreName}: ${labels.incomplete ?? score.missing.join(', ')}`
      : `${labels.scoreName} ${score.total}, ${labels.band}${
          labels.scaleMarker === undefined ? '' : `, ${labels.scaleMarker}`
        }. ${labels.requiredAction}`;

  if (!interactive) {
    return (
      <span
        data-slot="ews-badge"
        data-type={type}
        data-band={score.kind === 'scored' ? score.band : 'incomplete'}
        className={shared}
        role="group"
        aria-label={accessibleName}
      >
        {body}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-slot="ews-badge"
      data-type={type}
      data-band={score.kind === 'scored' ? score.band : 'incomplete'}
      className={shared}
      onClick={onShowBreakdown}
      aria-label={labels.breakdown === undefined ? accessibleName : `${accessibleName}. ${labels.breakdown}`}
    >
      {body}
    </button>
  );
}
