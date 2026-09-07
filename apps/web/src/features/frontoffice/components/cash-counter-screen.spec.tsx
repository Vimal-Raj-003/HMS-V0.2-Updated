import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider, TooltipProvider } from '@vims/ui';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '@/lib/api';
import { SessionProvider, type WorkspaceSession } from '@/lib/session-context';
import type { ShiftView } from '../api/types';
import { CloseShiftPanel } from './close-shift-panel';
import { CollectPaymentPanel } from './collect-payment-panel';
import { MoneyOutPanel } from './money-out-panel';

/**
 * The cash counter's four rules, each asserted where it is enforced.
 *
 *  1. money is exact — a split that does not balance cannot be submitted;
 *  2. §269ST is a refusal, not an error, and it carries the remaining headroom;
 *  3. a cashier cannot approve their own variance and cannot pay a refund, and
 *     is told why rather than shown a control that would be refused;
 *  4. a shift cannot close over an unexplained variance, and the screen says so
 *     before the button is pressed.
 */

const collectPayment = vi.hoisted(() => vi.fn());
const closePreview = vi.hoisted(() => vi.fn());
const closeShift = vi.hoisted(() => vi.fn());
const approveVariance = vi.hoisted(() => vi.fn());
const payRefund = vi.hoisted(() => vi.fn());
const voidReceipt = vi.hoisted(() => vi.fn());

vi.mock('../api/client', () => ({
  collectPayment,
  closePreview,
  closeShift,
  approveVariance,
  payRefund,
  voidReceipt,
  listShifts: vi.fn(),
  openShift: vi.fn(),
  readShift: vi.fn(),
}));

const HOSPITAL = '0192f0e2-0000-7000-8000-000000000011';
const ME = 'user-cashier';

function shift(overrides: Partial<ShiftView> = {}): ShiftView {
  return {
    id: '0192f0e2-0000-7000-8000-0000000000s1'.replace('s', 'c'),
    counterId: '0192f0e2-0000-7000-8000-0000000000c2',
    branchId: '0192f0e2-0000-7000-8000-0000000000b1',
    cashierUserId: ME,
    businessDate: '2026-08-24',
    status: 'open',
    currency: 'INR',
    openingFloat: '2000.00',
    expectedCash: '2000.00',
    countedCash: null,
    variance: null,
    varianceReason: null,
    varianceApprovedBy: null,
    receiptsCount: 0,
    voidsCount: 0,
    refundsCount: 0,
    openedAt: '2026-08-24T03:00:00.000Z',
    closedAt: null,
    totals: [],
    pendingConfirmations: 0,
    blockedBy: null,
    ...overrides,
  };
}

function session(permissions: readonly string[]): WorkspaceSession {
  return {
    userId: ME,
    displayName: 'Suresh K',
    hospitalId: HOSPITAL,
    branchId: 'branch-1',
    roles: ['cashier'],
    permissions,
    enabledModules: [],
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

function typeMoney(testId: string, value: string): void {
  const field = screen.getByTestId(testId);
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
}

const CASHIER = ['receipt.shift.read', 'receipt.shift.open', 'receipt.shift.close', 'receipt.collect'];

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('taking money', () => {
  it('will not submit a split that does not balance', () => {
    render(
      <Harness permissions={CASHIER}>
        <CollectPaymentPanel shift={shift()} onCollected={() => undefined} />
      </Harness>,
    );

    typeMoney('collect-amount', '1500.00');
    typeMoney('tender-amount-cash', '1000.00');

    expect(screen.getByTestId('split-balance')).toHaveTextContent('Still to collect');
    expect(screen.getByTestId('collect-confirm')).toBeDisabled();

    typeMoney('tender-amount-cash', '1500.00');
    expect(screen.getByTestId('split-balance')).toHaveTextContent('balance exactly');
    expect(screen.getByTestId('collect-confirm')).toBeEnabled();
  });

  it('shows the change due on a cash tender, computed in minor units', () => {
    render(
      <Harness permissions={CASHIER}>
        <CollectPaymentPanel shift={shift()} onCollected={() => undefined} />
      </Harness>,
    );
    typeMoney('collect-amount', '470.00');
    typeMoney('tender-amount-cash', '470.00');
    typeMoney('tender-handed-over', '500.00');
    expect(screen.getByTestId('change-due')).toHaveTextContent('30.00');
  });

  /**
   * §269ST forbids receiving ₹2,00,000 **or more** in cash from one person in
   * one day, so a single tender at the cap can never be accepted whatever the
   * payer's running total is. Refusing it here saves the patient a second queue.
   */
  it('refuses a cash tender that is on its own at the statutory cap', () => {
    render(
      <Harness permissions={CASHIER}>
        <CollectPaymentPanel shift={shift()} onCollected={() => undefined} />
      </Harness>,
    );
    typeMoney('collect-amount', '200000.00');
    typeMoney('tender-amount-cash', '200000.00');

    const refusal = screen.getByText(/can never be accepted/u).closest('[role="alert"]');
    // Indian grouping: ₹1,99,999.99 — one paisa below the cap.
    expect(refusal).toHaveTextContent('1,99,999.99');
    expect(screen.getByTestId('collect-confirm')).toBeDisabled();
  });

  it('renders the server’s §269ST refusal with the remaining headroom, and never a retry', async () => {
    collectPayment.mockRejectedValue(
      new ApiProblem(
        {
          type: 'https://errors.vimshms.com/statutory-limit',
          title: 'A statutory limit prevents this',
          status: 422,
          detail:
            'Cash from this payer today would reach 220000.00, which meets or exceeds the §269ST limit of 200000.00.',
          nextAction: 'Take the balance by card, UPI, cheque or bank transfer.',
          reference: 'trace-269st',
        },
        422,
      ),
    );

    render(
      <Harness permissions={CASHIER}>
        <CollectPaymentPanel shift={shift()} onCollected={() => undefined} />
      </Harness>,
    );

    typeMoney('collect-amount', '60000.00');
    typeMoney('tender-amount-cash', '60000.00');
    fireEvent.click(screen.getByTestId('collect-confirm'));

    const notice = await screen.findByTestId('cash-cap-notice');
    expect(notice).toHaveTextContent('§269ST');
    expect(screen.getByTestId('cap-already')).toHaveTextContent('1,60,000.00');
    expect(screen.getByTestId('cap-headroom')).toHaveTextContent('39,999.99');
    expect(screen.getByTestId('cap-reference')).toHaveTextContent('trace-269st');
    // Not a retryable error: there is nothing to try.
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('problem-card')).not.toBeInTheDocument();
  });
});

describe('money leaving the drawer', () => {
  it('does not offer a cashier a refund or a void, and explains who holds them', () => {
    render(
      <Harness permissions={CASHIER}>
        <MoneyOutPanel shift={shift()} onChanged={() => undefined} />
      </Harness>,
    );

    expect(screen.queryByTestId('refund-confirm')).not.toBeInTheDocument();
    expect(screen.queryByTestId('void-confirm')).not.toBeInTheDocument();

    const keys = screen.getAllByTestId('required-permission').map((node) => node.textContent);
    expect(keys).toContain('receipt.refund.pay');
    expect(keys).toContain('receipt.void');
    expect(screen.getByText(/needs a different person from the one who took it in/u)).toBeInTheDocument();
  });

  it('requires a second person even from somebody who holds the key', () => {
    render(
      <Harness permissions={[...CASHIER, 'receipt.refund.pay']}>
        <MoneyOutPanel shift={shift()} onChanged={() => undefined} />
      </Harness>,
    );

    fireEvent.change(screen.getByTestId('refund-id'), {
      target: { value: '0192f0e2-0000-7000-8000-0000000000d1' },
    });
    // The refund exists and is named, and it still cannot be paid alone.
    expect(screen.getByTestId('refund-confirm')).toBeDisabled();

    fireEvent.change(screen.getByTestId('refund-cosigner'), { target: { value: 'head.cashier' } });
    fireEvent.change(screen.getByTestId('refund-credential'), { target: { value: 'their-password' } });
    expect(screen.getByTestId('refund-confirm')).toBeEnabled();
  });
});

describe('closing the drawer', () => {
  it('says plainly what is blocking the close before the button is pressed', async () => {
    closePreview.mockResolvedValue(
      shift({ status: 'closing', variance: '-500.00', varianceReason: 'Short by five hundred' }),
    );
    render(
      <Harness permissions={CASHIER}>
        <CloseShiftPanel shift={shift()} onChanged={() => undefined} />
      </Harness>,
    );

    const blockers = await screen.findByTestId('close-blockers');
    expect(blockers).toHaveTextContent('out by');
    expect(blockers).toHaveTextContent('Short by five hundred');
  });

  it('warns about an unconfirmed digital tender, which is money the hospital does not have', async () => {
    closePreview.mockResolvedValue(shift({ pendingConfirmations: 2 }));
    render(
      <Harness permissions={CASHIER}>
        <CloseShiftPanel shift={shift()} onChanged={() => undefined} />
      </Harness>,
    );
    expect(await screen.findByTestId('close-blockers')).toHaveTextContent(
      'have not been confirmed by the gateway',
    );
  });

  /** NC-001 §5: "cashier ≠ variance approver", even for somebody holding both keys. */
  it('never offers the cashier the approval of their own variance', async () => {
    closePreview.mockResolvedValue(shift({ status: 'closing', variance: '-500.00' }));
    render(
      <Harness permissions={[...CASHIER, 'receipt.shift.variance.approve']}>
        <CloseShiftPanel shift={shift()} onChanged={() => undefined} />
      </Harness>,
    );

    await screen.findByTestId('close-blockers');
    expect(screen.queryByTestId('approve-variance')).not.toBeInTheDocument();
    expect(screen.getByText(/cannot approve a variance on your own shift/u)).toBeInTheDocument();
  });

  it('offers the approval to a supervisor looking at somebody else’s drawer', async () => {
    closePreview.mockResolvedValue(
      shift({ status: 'closing', variance: '-500.00', cashierUserId: 'another-cashier' }),
    );
    approveVariance.mockResolvedValue(shift({ varianceApprovedBy: ME }));
    render(
      <Harness permissions={[...CASHIER, 'receipt.shift.variance.approve']}>
        <CloseShiftPanel shift={shift({ cashierUserId: 'another-cashier' })} onChanged={() => undefined} />
      </Harness>,
    );

    const approve = await screen.findByTestId('approve-variance');
    fireEvent.click(approve);
    await waitFor(() => {
      expect(approveVariance).toHaveBeenCalled();
    });
  });

  it('counts the drawer in whole minor units and will not close a variance without a reason', async () => {
    closePreview.mockResolvedValue(shift({ expectedCash: '2000.00' }));
    render(
      <Harness permissions={CASHIER}>
        <CloseShiftPanel shift={shift()} onChanged={() => undefined} />
      </Harness>,
    );

    await screen.findByTestId('close-panel');
    // One ₹2,000 note is exactly the expected float.
    fireEvent.change(screen.getByLabelText('Count of ₹2,000.00'), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Close the shift' })).toBeEnabled();

    // A second note makes it ₹2,000 over, and now a reason is compulsory.
    fireEvent.change(screen.getByLabelText('Count of ₹2,000.00'), { target: { value: '2' } });
    expect(screen.getByRole('button', { name: 'Close the shift' })).toBeDisabled();
    expect(screen.getByText(/cannot be closed over silently/u)).toBeInTheDocument();
  });
});
