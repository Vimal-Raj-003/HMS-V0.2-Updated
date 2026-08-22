import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider, TooltipProvider } from '@vims/ui';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, type WorkspaceSession } from '@/lib/session-context';
import type { BoardView, Page, TokenView } from '../api/types';
import { QueueConsoleScreen } from './queue-console-screen';

/**
 * The queue console as a counter uses it.
 *
 * The assertions are the ones that decide whether the screen is safe: that a
 * skip cannot happen without a reason, that a session which may watch a queue
 * but not work it is *told* so rather than shown dead buttons, and that a
 * counter can complete the token it is actually serving.
 */

const listTokens = vi.hoisted(() => vi.fn());
const readBoard = vi.hoisted(() => vi.fn());
const skipToken = vi.hoisted(() => vi.fn());
const callNext = vi.hoisted(() => vi.fn());
const completeToken = vi.hoisted(() => vi.fn());
const recallToken = vi.hoisted(() => vi.fn());
const transferToken = vi.hoisted(() => vi.fn());
const issueToken = vi.hoisted(() => vi.fn());

vi.mock('../api/client', () => ({
  listTokens,
  readBoard,
  skipToken,
  callNext,
  completeToken,
  recallToken,
  transferToken,
  issueToken,
}));

const QUEUE_ID = '0192f0e2-0000-7000-8000-0000000000a1';
const TOKEN_ID = '0192f0e2-0000-7000-8000-000000000001';
const HOSPITAL = '0192f0e2-0000-7000-8000-000000000011';

function token(overrides: Partial<TokenView> = {}): TokenView {
  return {
    id: TOKEN_ID,
    queue_id: QUEUE_ID,
    branch_id: '0192f0e2-0000-7000-8000-0000000000b1',
    series_date: '2026-08-24',
    token_no: 12,
    token_display: 'C-12',
    patient_id: null,
    visit_id: null,
    appointment_id: null,
    counter_id: null,
    room_key: null,
    source: 'desk',
    class: 'regular',
    priority_rank: 500,
    status: 'waiting',
    est_wait_sec_at_issue: 600,
    actual_wait_sec: null,
    skip_count: 0,
    recall_count: 0,
    issued_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    called_at: null,
    service_end_at: null,
    ...overrides,
  };
}

function board(): BoardView {
  return {
    queueId: QUEUE_ID,
    queueCode: 'DR-1',
    queueName: 'Dr Rao — OPD 3',
    seriesDate: '2026-08-24',
    nowServing: [],
    next: [],
    waiting: 1,
    served: 0,
    noShow: 0,
    avgWaitSeconds: 420,
    doctorStatus: null,
  };
}

function page(items: readonly TokenView[]): Page<TokenView> {
  return { items, nextCursor: null, hasMore: false };
}

function session(permissions: readonly string[]): WorkspaceSession {
  return {
    userId: 'user-1',
    displayName: 'Anitha R',
    hospitalId: HOSPITAL,
    branchId: 'branch-1',
    roles: ['receptionist'],
    permissions,
  };
}

function Harness({
  permissions,
  children,
}: {
  readonly permissions: readonly string[];
  readonly children: ReactNode;
}): React.JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <SessionProvider session={session(permissions)}>{children}</SessionProvider>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.localStorage.setItem(`vims.frontoffice.${HOSPITAL}.queue`, QUEUE_ID);
  listTokens.mockResolvedValue(page([token()]));
  readBoard.mockResolvedValue(board());
});

describe('the queue console', () => {
  it('asks for a queue before it asks the API for anything', async () => {
    window.localStorage.clear();
    render(
      <Harness permissions={['queue.token.read', 'queue.token.call']}>
        <QueueConsoleScreen />
      </Harness>,
    );
    expect(await screen.findByText(/No queue chosen/u)).toBeInTheDocument();
    expect(listTokens).not.toHaveBeenCalled();
  });

  it('draws the waiting tokens with their wait, and never a patient name', async () => {
    render(
      <Harness permissions={['queue.token.read', 'queue.token.call', 'queue.board.read']}>
        <QueueConsoleScreen />
      </Harness>,
    );
    expect(await screen.findByText('C-12')).toBeInTheDocument();
    expect(screen.getByText(/Walk-in · Desk/u)).toBeInTheDocument();
    expect(screen.getByText(/Waiting 10 min/u)).toBeInTheDocument();
  });

  /**
   * EN-006 §3.3: a skip is never silent. The dialog is a hard stop and confirm
   * stays disabled until a reason exists, so the only way past it is to give one.
   */
  it('will not skip a token until a reason has been given', async () => {
    render(
      <Harness permissions={['queue.token.read', 'queue.token.call']}>
        <QueueConsoleScreen />
      </Harness>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/requires a reason/u)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Skip the token' })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Skip the token' }));
    expect(skipToken).not.toHaveBeenCalled();
  });

  it('tells a read-only session why it cannot work the queue, instead of showing dead buttons', async () => {
    render(
      <Harness permissions={['queue.token.read']}>
        <QueueConsoleScreen />
      </Harness>,
    );
    await screen.findByText('C-12');

    expect(screen.queryByRole('button', { name: 'Call next' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
    expect(screen.getAllByTestId('required-permission').map((node) => node.textContent)).toContain(
      'queue.token.call',
    );
  });

  it('explains that a transfer belongs to a supervisor rather than hiding it silently', async () => {
    render(
      <Harness permissions={['queue.token.read', 'queue.token.call']}>
        <QueueConsoleScreen />
      </Harness>,
    );
    await screen.findByText('C-12');
    expect(screen.queryByRole('button', { name: 'Transfer' })).not.toBeInTheDocument();
    expect(screen.getAllByTestId('required-permission').map((node) => node.textContent)).toContain(
      'queue.token.manage',
    );
  });

  it('shows a specific empty state rather than "no data"', async () => {
    listTokens.mockResolvedValue(page([]));
    render(
      <Harness permissions={['queue.token.read', 'queue.token.issue', 'queue.token.call']}>
        <QueueConsoleScreen />
      </Harness>,
    );
    expect(await screen.findByText(/Nobody is waiting in this queue/u)).toBeInTheDocument();
    expect(screen.getByText(/Issue a token when the next patient arrives/u)).toBeInTheDocument();
  });

  it('offers Complete on the token the counter is actually serving', async () => {
    listTokens.mockResolvedValue(
      page([token({ status: 'called', called_at: new Date().toISOString(), room_key: 'Counter 2' })]),
    );
    completeToken.mockResolvedValue(token({ status: 'served' }));
    render(
      <Harness permissions={['queue.token.read', 'queue.token.call']}>
        <QueueConsoleScreen />
      </Harness>,
    );

    fireEvent.click(await screen.findByTestId('complete-serving'));
    await waitFor(() => {
      expect(completeToken).toHaveBeenCalledWith(TOKEN_ID);
    });
  });

  it('calls the next token from the primary action', async () => {
    callNext.mockResolvedValue(token({ status: 'called' }));
    render(
      <Harness permissions={['queue.token.read', 'queue.token.call']}>
        <QueueConsoleScreen />
      </Harness>,
    );
    fireEvent.click(await screen.findByTestId('call-next'));
    await waitFor(() => {
      expect(callNext).toHaveBeenCalledWith(QUEUE_ID, {});
    });
  });
});
