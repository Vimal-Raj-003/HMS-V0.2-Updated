import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  QueueList,
  TokenTile,
  waitTone,
  type QueueEntry,
  type QueueListLabels,
} from '../clinical/queue-list.js';
import {
  ANNOUNCEMENT_MAX_AGE_SECONDS,
  TokenDisplay,
  shouldAnnounce,
  type TokenDisplayLabels,
} from '../clinical/token-display.js';
import { findAccessibilityViolations } from './axe.js';

const labels: QueueListLabels = {
  state: {
    waiting: 'Waiting',
    called: 'Called',
    'in-progress': 'In room',
    'on-hold': 'On hold',
    skipped: 'Skipped',
    completed: 'Completed',
    'no-show': 'No show',
  },
  priority: {
    emergency: 'Emergency',
    'senior-citizen': 'Senior citizen',
    'differently-abled': 'Differently abled',
    appointment: 'Appointment',
    'walk-in': 'Walk-in',
  },
  positionPrefix: 'Position',
  roomPrefix: 'Room',
  reasonPrefix: 'Reason',
  waited: (minutes) => `Waited ${String(minutes)} min`,
  estimated: (minutes) => `About ${String(minutes)} min more`,
  tokenSummary: (entry) => `Token ${entry.token}, ${entry.maskedLabel}`,
  listLabel: 'Queue for Dr A. Menon',
  callNext: 'Call next',
  callSelected: 'Call this token',
  recall: 'Recall',
  hold: 'Hold',
  skip: 'Skip',
  transfer: 'Transfer',
  nothingWaiting: 'No patients waiting',
  counts: (waiting, called) => `${String(waiting)} waiting · ${String(called)} called`,
};

const waitingEntry: QueueEntry = {
  tokenId: 'tok_1',
  token: 'C-45',
  state: { kind: 'waiting', position: 1 },
  priority: 'senior-citizen',
  maskedLabel: 'RS ·8471 45/M',
  visitType: 'Walk-in',
  waitedMinutes: 12,
  estimatedWaitMinutes: 8,
};

const calledEntry: QueueEntry = {
  tokenId: 'tok_2',
  token: 'C-46',
  state: { kind: 'called', room: '3', secondsSinceCall: 12 },
  priority: 'appointment',
  maskedLabel: 'AK ·2210 62/F',
  visitType: 'Appointment 10:30',
  doctor: 'Dr A. Menon',
  waitedMinutes: 64,
};

const heldEntry: QueueEntry = {
  tokenId: 'tok_3',
  token: 'C-47',
  state: { kind: 'on-hold', reason: 'Gone for X-ray' },
  priority: 'walk-in',
  maskedLabel: 'MN ·3391 30/M',
  visitType: 'Walk-in',
  waitedMinutes: 40,
};

describe('waitTone — docs/06 §5.2 #10', () => {
  it('turns amber past 30 minutes and red past 60', () => {
    expect(waitTone(0)).toBe('normal');
    expect(waitTone(30)).toBe('normal');
    expect(waitTone(31)).toBe('warning');
    expect(waitTone(60)).toBe('warning');
    expect(waitTone(61)).toBe('critical');
  });
});

describe('TokenTile', () => {
  it('carries the state as a word and an icon, not only as a colour', () => {
    const { container } = render(<TokenTile entry={waitingEntry} labels={labels} />);
    const chip = container.querySelector('[data-queue-state="waiting"]');
    expect(chip?.textContent).toBe('Waiting');
    expect(chip?.querySelector('svg')).not.toBeNull();
    expect(chip?.className).toContain('text-q-waiting');
  });

  it('shows the room a called token was called to, and pulses within the safe range', () => {
    const { container } = render(<TokenTile entry={calledEntry} labels={labels} />);
    expect(screen.getByText('Room 3')).toBeInTheDocument();
    const chip = container.querySelector('[data-queue-state="called"]');
    // §7 — the pulse is motion-safe only and degrades to a static ring.
    expect(chip?.className).toContain('motion-safe:animate-pulse');
    expect(chip?.className).toContain('motion-reduce:ring-2');
  });

  it('shows a held token with its reason', () => {
    render(<TokenTile entry={heldEntry} labels={labels} />);
    expect(screen.getByText('Reason Gone for X-ray')).toBeInTheDocument();
  });

  it('flags a long wait in amber and a very long wait in red', () => {
    const { container: amber } = render(<TokenTile entry={heldEntry} labels={labels} />);
    expect(amber.querySelector('[data-wait-tone="warning"]')).not.toBeNull();
    const { container: red } = render(<TokenTile entry={calledEntry} labels={labels} />);
    expect(red.querySelector('[data-wait-tone="critical"]')).not.toBeNull();
  });

  it('shows the masked label by default', () => {
    render(<TokenTile entry={waitingEntry} labels={labels} />);
    expect(screen.getByText('RS ·8471 45/M')).toBeInTheDocument();
  });
});

describe('QueueList — EN-006 console', () => {
  const entries = [waitingEntry, calledEntry, heldEntry];

  it('calls the next token with Space, not the focused one', () => {
    const onCallNext = vi.fn();
    const onCall = vi.fn();
    render(<QueueList entries={entries} labels={labels} onCallNext={onCallNext} onCall={onCall} />);
    const list = screen.getByRole('list', { name: labels.listLabel });
    fireEvent.keyDown(list, { key: ' ' });
    expect(onCallNext).toHaveBeenCalledTimes(1);
    expect(onCall).not.toHaveBeenCalled();
  });

  it('moves between tokens with the arrow keys on one tab stop', () => {
    const { container } = render(<QueueList entries={entries} labels={labels} />);
    const tiles = container.querySelectorAll<HTMLButtonElement>('[data-slot="token-tile"]');
    expect(tiles[0]).toHaveAttribute('tabindex', '0');
    expect(tiles[1]).toHaveAttribute('tabindex', '-1');
    const list = screen.getByRole('list', { name: labels.listLabel });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(tiles[1]);
    fireEvent.keyDown(list, { key: 'End' });
    expect(document.activeElement).toBe(tiles[2]);
  });

  it('asks for a skip rather than performing one', () => {
    const onSkipRequested = vi.fn<(entry: QueueEntry) => void>();
    render(<QueueList entries={entries} labels={labels} onSkipRequested={onSkipRequested} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onSkipRequested).toHaveBeenCalledWith(waitingEntry);
  });

  it('acts on the token the user selected', () => {
    const onCall = vi.fn<(entry: QueueEntry) => void>();
    const { container } = render(<QueueList entries={entries} labels={labels} onCall={onCall} />);
    const tiles = container.querySelectorAll<HTMLButtonElement>('[data-slot="token-tile"]');
    fireEvent.click(tiles[1] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Call this token' }));
    expect(onCall).toHaveBeenCalledWith(calledEntry);
  });

  it('opens the selected token with Enter', () => {
    const onOpen = vi.fn<(entry: QueueEntry) => void>();
    render(<QueueList entries={entries} labels={labels} onOpen={onOpen} />);
    fireEvent.keyDown(screen.getByRole('list', { name: labels.listLabel }), { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith(waitingEntry);
  });

  it('announces the live counts where they are shown', () => {
    const { container } = render(<QueueList entries={entries} labels={labels} />);
    const counts = container.querySelector('[data-queue-counts]');
    expect(counts?.textContent).toBe('1 waiting · 1 called');
    expect(counts).toHaveAttribute('aria-live', 'polite');
  });

  it('renders a specific empty state', () => {
    render(<QueueList entries={[]} labels={labels} />);
    expect(screen.getByText('No patients waiting')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <QueueList
        entries={entries}
        labels={labels}
        onCallNext={() => undefined}
        onCall={() => undefined}
        onSkipRequested={() => undefined}
        onHoldRequested={() => undefined}
      />,
    );
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});

const displayLabels: TokenDisplayLabels = {
  region: 'OPD Block A token board',
  nowServing: 'Now serving',
  next: 'Next',
  roomPrefix: 'Room',
  waiting: (count) => `${String(count)} waiting`,
  averageWait: (minutes) => `Average wait ${String(minutes)} min`,
  idle: 'No token called yet',
  live: 'Live',
  stale: (lastUpdated) => `Last updated ${lastUpdated}`,
  expired: (lastUpdated) => `Board offline since ${lastUpdated}`,
  announcement: (token, room) => `Token ${token}, please go to room ${room}`,
};

describe('TokenDisplay — docs/06 §5.2 #11', () => {
  it('suppresses the announcement once a call is older than 90 seconds', () => {
    expect(ANNOUNCEMENT_MAX_AGE_SECONDS).toBe(90);
    expect(shouldAnnounce(0)).toBe(true);
    expect(shouldAnnounce(90)).toBe(true);
    expect(shouldAnnounce(91)).toBe(false);
    expect(shouldAnnounce(-1)).toBe(false);
  });

  it('speaks and shows the same sentence for a fresh call', () => {
    const { container } = render(
      <TokenDisplay
        nowServing={{ token: 'C-45', room: '3', doctor: 'Dr A. Menon', secondsSinceCall: 10 }}
        next={[{ token: 'C-46', room: '3' }]}
        labels={displayLabels}
        waitingCount={18}
        averageWaitMinutes={22}
        freshness={{ kind: 'live' }}
      />,
    );
    expect(container.querySelector('[data-slot="token-display"]')).toHaveAttribute('data-announce', 'true');
    expect(screen.getByText('Token C-45, please go to room 3')).toBeInTheDocument();
    expect(container.querySelector('[data-now-serving-token]')?.textContent).toBe('C-45');
  });

  it('stays silent on a reconnect that replays an old call', () => {
    const { container } = render(
      <TokenDisplay
        nowServing={{ token: 'C-45', room: '3', secondsSinceCall: 400 }}
        next={[]}
        labels={displayLabels}
        waitingCount={4}
        freshness={{ kind: 'stale', lastUpdated: '14:07:02' }}
      />,
    );
    expect(container.querySelector('[data-slot="token-display"]')).toHaveAttribute('data-announce', 'false');
    expect(screen.queryByText(/please go to/)).toBeNull();
    expect(screen.getByText('Last updated 14:07:02')).toBeInTheDocument();
  });

  it('dims and marks an expired board rather than showing stale tokens as live', () => {
    const { container } = render(
      <TokenDisplay
        nowServing={{ token: 'C-45', room: '3', secondsSinceCall: 5 }}
        next={[]}
        labels={displayLabels}
        waitingCount={4}
        freshness={{ kind: 'expired', lastUpdated: '13:55:00' }}
      />,
    );
    expect(container.querySelector('[data-staleness="expired"]')?.textContent).toContain(
      'Board offline since 13:55:00',
    );
    expect(container.querySelector('[data-slot="token-display"]')).toHaveAttribute('data-announce', 'false');
  });

  it('shows at most seven upcoming tokens', () => {
    render(
      <TokenDisplay
        nowServing={null}
        next={Array.from({ length: 12 }, (_, index) => ({
          token: `C-${String(50 + index)}`,
          room: '3',
        }))}
        labels={displayLabels}
        waitingCount={12}
        freshness={{ kind: 'live' }}
      />,
    );
    const list = screen.getByRole('list', { name: displayLabels.next });
    // One heading item plus seven tokens.
    expect(list.querySelectorAll('li')).toHaveLength(8);
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <TokenDisplay
        nowServing={{ token: 'C-45', room: '3', secondsSinceCall: 5 }}
        next={[{ token: 'C-46', room: '4' }]}
        labels={displayLabels}
        waitingCount={18}
        averageWaitMinutes={22}
        freshness={{ kind: 'live' }}
      />,
    );
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});
