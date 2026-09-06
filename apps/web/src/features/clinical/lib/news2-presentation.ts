import type { EwsBadgeLabels, EwsScore, VitalPoint } from '@vims/ui/clinical';

/**
 * One historical reading, as the history endpoint returns it. Declared here
 * rather than imported from the component it used to live in, so that deleting
 * that component does not take the type with it.
 */
export interface TrendPoint {
  /** ISO-8601 instant. */
  readonly at: string;
  readonly value: number;
}

/**
 * Turns what the server says about NEWS2 into what `EwsBadge` needs to render.
 *
 * The screen used to hold a local `Ews2Badge`. It is replaced by the design
 * system's `EwsBadge` (docs/06 §5.2 #5), and this is the seam between them —
 * kept in `lib` rather than inline in the screen so the mapping can be asserted
 * without rendering a page.
 *
 * **Nothing here computes a score or a band.** The server owns both
 * (`vitals.news2.ts`), and the comment the old component carried is worth
 * repeating because it is the reason this file is a mapping and not a
 * calculation: two implementations of RCP 2017 that disagree by one point is how
 * a medium-risk patient is shown as low-risk.
 *
 * The action sentences are the RCP 2017 clinical responses. They live here,
 * beside the band they belong to, because §5.2 #5 makes the sentence part of the
 * badge's contract — a score without its required action is not renderable — and
 * a sentence that drifts from its band is worse than no sentence.
 */

/** Exactly `News2Band` from `services/api/src/modules/opd/clinical/vitals.news2.ts`. */
export type ServerNews2Band = 'low' | 'medium' | 'high';

/**
 * The server folds RCP's "low-medium" (a single 3 in any parameter) into
 * `medium`, so only three bands ever arrive. `EwsBadge` supports the fourth for
 * PEWS and MEOWS; it is simply never produced here.
 */
const RESPONSE: Record<ServerNews2Band, string> = {
  low: 'Continue routine observations, 12-hourly.',
  medium: 'Urgent review by a clinician competent in acute illness. Increase observations to hourly.',
  high: 'Emergency assessment by a critical-care team. Continuous monitoring. Consider transfer to a higher level of care.',
};

const BAND_NAME: Record<ServerNews2Band, string> = {
  low: 'low risk',
  medium: 'medium risk',
  high: 'high risk',
};

export function news2Score(score: number | null, band: string | null): EwsScore {
  // A score with no band, or a band the server has never produced, is not a
  // score we can act on. Rendering it as "low" would invent a reassurance.
  if (score === null || band === null || !(band in RESPONSE)) {
    return { kind: 'incomplete', missing: [] };
  }
  return { kind: 'scored', total: score, band: band as ServerNews2Band };
}

export function news2Labels(band: string | null): EwsBadgeLabels {
  const known = band !== null && band in RESPONSE ? (band as ServerNews2Band) : null;
  return {
    scoreName: 'NEWS2',
    band: known === null ? 'not scored' : BAND_NAME[known],
    requiredAction: known === null ? 'Record the missing observations to score.' : RESPONSE[known],
    incomplete: 'NEWS2 not scored — not every observation needed for a score was recorded.',
  };
}

/**
 * The reference bands the sparkline draws behind each trend.
 *
 * Adult, and deliberately narrow: these are the ranges outside which a reading
 * is worth a second look, not the ranges that trigger an escalation — the
 * escalation is NEWS2's job and it is scored by the server. A band drawn here is
 * a reading aid, so getting it slightly conservative costs a glance and getting
 * it wide costs the point of drawing it.
 */
export const TREND_REFERENCE: Record<
  'systolic' | 'pulse' | 'spo2',
  { readonly low: number; readonly high: number }
> = {
  systolic: { low: 111, high: 219 },
  pulse: { low: 51, high: 90 },
  spo2: { low: 96, high: 100 },
};

/**
 * Marks the points that fall outside the reference band.
 *
 * `VitalsSparkline` takes `abnormal` per point rather than deriving it, because
 * whether a reading is abnormal depends on age, pregnancy and the patient's own
 * baseline. This adapter supplies the adult default; a paediatric screen would
 * supply its own and the component would not change.
 */
export function toSparklineSeries(
  points: readonly TrendPoint[],
  reference: { readonly low: number; readonly high: number },
): readonly VitalPoint[] {
  return points.map((p) => ({
    at: Date.parse(p.at),
    value: p.value,
    ...(p.value < reference.low || p.value > reference.high ? { abnormal: true } : {}),
  }));
}
