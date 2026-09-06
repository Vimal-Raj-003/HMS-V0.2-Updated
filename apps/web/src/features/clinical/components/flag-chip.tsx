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
