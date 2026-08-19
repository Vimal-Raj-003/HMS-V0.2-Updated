import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TokenBoard } from '../features/board/token-board';
import { snapshot } from './fixtures';

const NOW = new Date('2026-08-19T14:07:02');
const UPDATED = new Date('2026-08-19T14:07:01');

describe('TokenBoard (live)', () => {
  it('renders the now-serving token, its room and the clinician', () => {
    render(
      <TokenBoard
        snapshot={snapshot()}
        freshness="live"
        status="live"
        lastUpdatedAt={UPDATED}
        now={NOW}
        transportKind="polling"
      />,
    );

    expect(screen.getByTestId('now-serving-token')).toHaveTextContent('C-45');
    const nowServing = screen.getByTestId('now-serving');
    expect(within(nowServing).getByText('Now serving')).toBeInTheDocument();
    expect(within(nowServing).getByText('Room 3')).toBeInTheDocument();
    expect(within(nowServing).getByText('Dr A. Menon')).toBeInTheDocument();
    expect(nowServing).toHaveAttribute('aria-disabled', 'false');
  });

  it('renders the next-in-queue list with rooms and ETAs', () => {
    render(
      <TokenBoard
        snapshot={snapshot()}
        freshness="live"
        status="live"
        lastUpdatedAt={UPDATED}
        now={NOW}
        transportKind="polling"
      />,
    );

    const rows = screen.getAllByTestId('next-token-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('C-46');
    expect(rows[0]).toHaveTextContent('~6 min');
    expect(rows[2]).toHaveTextContent('Room 4');
  });

  it('caps the next list at the seven rows docs/06 §4.4 allows at 8 m', () => {
    const many = snapshot({
      nextTokens: Array.from({ length: 7 }, (_, index) => ({
        id: `tok-${String(index)}`,
        tokenDisplay: `C-${String(50 + index)}`,
        status: 'waiting' as const,
        roomLabel: 'Room 3',
        etaMinutes: index * 5,
      })),
    });

    render(
      <TokenBoard
        snapshot={many}
        freshness="live"
        status="live"
        lastUpdatedAt={UPDATED}
        now={NOW}
        transportKind="polling"
      />,
    );

    expect(screen.getAllByTestId('next-token-row')).toHaveLength(7);
  });

  it('paints queue state from design tokens, never from a literal colour', () => {
    render(
      <TokenBoard
        snapshot={snapshot()}
        freshness="live"
        status="live"
        lastUpdatedAt={UPDATED}
        now={NOW}
        transportKind="polling"
      />,
    );

    expect(screen.getByTestId('now-serving-token').className).toContain('text-q-called');
  });

  it('shows a live chip carrying the update time and the transport in use', () => {
    render(
      <TokenBoard
        snapshot={snapshot()}
        freshness="live"
        status="live"
        lastUpdatedAt={UPDATED}
        now={NOW}
        transportKind="polling"
      />,
    );

    const chip = screen.getByTestId('board-status-chip');
    expect(chip).toHaveAttribute('data-freshness', 'live');
    expect(chip).toHaveTextContent('Live');
    expect(chip).toHaveTextContent('Last updated 14:07:01');
    expect(chip).toHaveTextContent('polling');
  });

  it('shifts the safe area deterministically for burn-in, with no randomness', () => {
    const { container, rerender } = render(
      <TokenBoard
        snapshot={snapshot()}
        freshness="live"
        status="live"
        lastUpdatedAt={UPDATED}
        now={NOW}
        transportKind="polling"
      />,
    );
    const first = container.querySelector('.board-safe-area')?.getAttribute('style');

    rerender(
      <TokenBoard
        snapshot={snapshot()}
        freshness="live"
        status="live"
        lastUpdatedAt={UPDATED}
        now={new Date(NOW.getTime() + 1000)}
        transportKind="polling"
      />,
    );

    expect(container.querySelector('.board-safe-area')?.getAttribute('style')).toBe(first);
    expect(first).toMatch(/translate3d/);
  });
});

describe('TokenBoard (degraded)', () => {
  const renderStale = (freshness: 'stale' | 'expired', status: 'reconnecting' | 'live') =>
    render(
      <TokenBoard
        snapshot={snapshot()}
        freshness={freshness}
        status={status}
        lastUpdatedAt={new Date('2026-08-19T14:05:02')}
        now={NOW}
        transportKind="polling"
      />,
    );

  it('says it is reconnecting, with the last update time, while still trusted', () => {
    renderStale('stale', 'reconnecting');

    const chip = screen.getByTestId('board-status-chip');
    expect(chip).toHaveAttribute('data-freshness', 'stale');
    expect(chip).toHaveTextContent('Reconnecting');
    expect(chip).toHaveTextContent('Last updated 14:05:02');
    expect(screen.queryByTestId('not-live-banner')).not.toBeInTheDocument();
  });

  it('stops presenting expired tokens as a current call', () => {
    renderStale('expired', 'reconnecting');

    // The heading is the safety signal: the numerals are history, not an instruction.
    const nowServing = screen.getByTestId('now-serving');
    expect(within(nowServing).getByText('Last called — not live')).toBeInTheDocument();
    expect(within(nowServing).queryByText('Now serving')).not.toBeInTheDocument();
    expect(nowServing).toHaveAttribute('aria-disabled', 'true');
    expect(nowServing).toHaveAttribute('data-freshness', 'expired');

    expect(screen.getByTestId('not-live-banner')).toHaveTextContent(/not receiving updates.*reception desk/i);

    const chip = screen.getByTestId('board-status-chip');
    expect(chip).toHaveAttribute('data-freshness', 'expired');
    expect(chip).toHaveTextContent('Not live');
    expect(chip).toHaveTextContent('Last updated 14:05:02');
    expect(chip).toHaveTextContent('(2 min ago)');
  });
});
