'use client';

import { Badge } from '@vims/ui';
import { Check, Info, OctagonAlert, TriangleAlert } from '@/lib/icons';
import type { VitalFlag } from '../api/types';

/**
 * One observation's verdict, as a chip.
 *
 * `docs/06` §1.2.3: colour is never the only signal, so every state carries an
 * icon **and** a word as well as a tone. A red dot beside a number is listed in
 * §10 as a defect, and it is the exact defect a colour-blind nurse on a bright
 * ward meets.
 *
 * The fourth state is the one that matters most and the one most likely to be
 * dropped by a later edit: **`null` is "not scored", not "normal".** A hospital
 * that has configured no band for a parameter gets a neutral "not scored" chip,
 * because a green tick over an unscored value is a lie the screen tells with
 * confidence.
 */
export function FlagChip({ flag, label }: { readonly flag: VitalFlag | null; readonly label?: string }) {
  switch (flag) {
    case 'critical':
      return (
        <Badge tone="danger" data-testid="flag-critical" icon={<OctagonAlert aria-hidden="true" />}>
          {label ?? 'Critical'}
        </Badge>
      );
    case 'abnormal':
      return (
        <Badge tone="warning" data-testid="flag-abnormal" icon={<TriangleAlert aria-hidden="true" />}>
          {label ?? 'Abnormal'}
        </Badge>
      );
    case 'normal':
      return (
        <Badge tone="success" data-testid="flag-normal" icon={<Check aria-hidden="true" />}>
          {label ?? 'Normal'}
        </Badge>
      );
    case null:
      return (
        <Badge tone="neutral" data-testid="flag-not-scored" icon={<Info aria-hidden="true" />}>
          {label ?? 'Not scored'}
        </Badge>
      );
  }
}

/**
 * The NEWS2 chip.
 *
 * The score and the band are **the server's** (`news2_score`, `news2_band` on
 * the saved observation). Nothing here recomputes them: two implementations of
 * RCP 2017 that disagree by one point is how a medium-risk patient is shown as
 * low-risk, and the client has no business holding a second copy of a clinical
 * score.
 *
 * A record with no score renders the fact that it has none, rather than nothing:
 * NEWS2 needs a set of observations, and "not enough was measured to score" is
 * information a doctor acts on.
 */
export function Ews2Badge({
  score,
  band,
}: {
  readonly score: number | null;
  readonly band: string | null;
}): React.JSX.Element {
  if (score === null) {
    return (
      <Badge tone="neutral" data-testid="news2-unscored" icon={<Info aria-hidden="true" />}>
        NEWS2 not scored
      </Badge>
    );
  }

  const tone = band === 'high' ? 'danger' : band === 'medium' ? 'warning' : 'success';
  const icon =
    band === 'high' ? (
      <OctagonAlert aria-hidden="true" />
    ) : band === 'medium' ? (
      <TriangleAlert aria-hidden="true" />
    ) : (
      <Check aria-hidden="true" />
    );
  const response =
    band === 'high'
      ? 'emergency response'
      : band === 'medium'
        ? 'urgent doctor review'
        : 'routine monitoring';

  return (
    <Badge tone={tone} data-testid="news2-badge" icon={icon}>
      NEWS2 {score} — {band ?? 'unbanded'}, {response}
    </Badge>
  );
}
