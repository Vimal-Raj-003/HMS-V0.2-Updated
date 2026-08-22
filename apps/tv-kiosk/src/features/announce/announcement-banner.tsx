import type { ReactNode } from 'react';
import { isRtl } from '@vims/i18n';
import type { AnnouncerState } from './use-announcer';

export interface AnnouncementBannerProps {
  readonly state: AnnouncerState;
}

/**
 * The visible half of an announcement, and not an optional one.
 *
 * EN-018 §3.4.4 and the RPwD Act: "every announcement also flashes the token
 * panel and shows the text large for the full announcement duration". A board
 * whose only announcement is audible excludes every deaf patient in the waiting
 * room, and a board whose speakers are muted at night — the usual state of a
 * ward corridor — excludes everybody.
 *
 * `aria-live="assertive"` because this is the one thing on a board that
 * legitimately interrupts: it is a call to act now.
 *
 * It carries the token, the destination and the sentence being spoken. It
 * carries no name, because `PlannedCall` has no field that could hold one
 * (EN-018 §5).
 */
export function AnnouncementBanner(props: AnnouncementBannerProps): ReactNode {
  const { call, speaking, audible } = props.state;
  if (call === null) return null;

  const direction = speaking !== null && isRtl(speaking.localeCode) ? 'rtl' : 'ltr';

  return (
    <div
      className="border-info-border bg-info-surface text-info-fg flex items-center justify-between gap-8 rounded-2xl border-2 px-8 py-5"
      data-testid="announcement-banner"
      data-token={call.tokenDisplay}
      data-audible={audible}
      role="alert"
      aria-live="assertive"
    >
      <div className="flex items-baseline gap-6">
        <span className="font-display text-display-1 leading-none font-semibold tabular-nums">
          {call.tokenDisplay}
        </span>
        <span className="text-tv-body font-semibold">{call.destination}</span>
      </div>
      <p
        className="text-tv-body truncate text-right"
        lang={speaking?.localeCode ?? 'en-IN'}
        dir={direction}
        data-testid="announcement-text"
      >
        {speaking?.text ?? ''}
      </p>
    </div>
  );
}
