import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider, TooltipProvider } from '@vims/ui';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, type WorkspaceSession } from '@/lib/session-context';
import type { AlertFatigueReport } from '../api/types';
import { AlertFatigueScreen } from './alert-fatigue-screen';

/** Phase-02 exit gate 8 — override rate by rule, and the honesty about small numbers. */

const getAlertFatigue = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ getAlertFatigue }));

const HOSPITAL = '0192f0e2-0000-7000-8000-000000000011';

function session(): WorkspaceSession {
  return {
    userId: 'user-quality',
    displayName: 'Quality lead',
    hospitalId: HOSPITAL,
    branchId: null,
    roles: ['quality_manager'],
    permissions: ['cdss.report.read'],
  };
}

function Harness({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <SessionProvider session={session()}>{children}</SessionProvider>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function report(overrides: Partial<AlertFatigueReport> = {}): AlertFatigueReport {
  return {
    windowDays: 7,
    fires: 100,
    displays: 90,
    blocks: 4,
    overrides: 60,
    acknowledgements: 26,
    overrideRatePct: 60,
    alertsPer1000Orders: 220,
    ordersEvaluated: 455,
    overridesByReason: { PRIOR_TOLERANCE: 40, OTHER: 20 },
    byFamily: [
      { family: 'ddi', fires: 75, overrides: 55, blocks: 0 },
      { family: 'dose_range', fires: 20, overrides: 4, blocks: 0 },
      { family: 'allergy', fires: 5, overrides: 1, blocks: 4 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAlertFatigue.mockResolvedValue(report());
});

describe('the alert-fatigue dashboard', () => {
  it('shows the override rate for each rule family, loudest first', async () => {
    render(
      <Harness>
        <AlertFatigueScreen />
      </Harness>,
    );

    await screen.findByTestId('rate-ddi');
    expect(screen.getByTestId('rate-ddi')).toHaveTextContent('73.3%');
    expect(screen.getByTestId('rate-dose_range')).toHaveTextContent('20%');
  });

  it('refuses to state a rate for a family that has barely fired', async () => {
    render(
      <Harness>
        <AlertFatigueScreen />
      </Harness>,
    );

    expect(await screen.findByTestId('rate-unjudgeable-allergy')).toHaveTextContent('too few to judge');
  });

  it('shows the headline numbers a committee acts on', async () => {
    render(
      <Harness>
        <AlertFatigueScreen />
      </Harness>,
    );

    expect(await screen.findByTestId('alerts-per-1000')).toHaveTextContent('220 alerts per 1000 orders');
    expect(screen.getByTestId('override-rate')).toHaveTextContent('60% overridden');
    expect(screen.getByTestId('fatigue-verdict').textContent).toMatch(/more than half/iu);
  });

  it('names the reasons clinicians gave, in words rather than codes', async () => {
    render(
      <Harness>
        <AlertFatigueScreen />
      </Harness>,
    );

    const reasons = await screen.findByTestId('override-reasons');
    expect(within(reasons).getByTestId('reason-PRIOR_TOLERANCE')).toHaveTextContent(
      'Patient has tolerated this before',
    );
    expect(within(reasons).getByTestId('reason-PRIOR_TOLERANCE')).toHaveTextContent('40 (66.7%)');
  });

  it('re-reads the report over a different window', async () => {
    render(
      <Harness>
        <AlertFatigueScreen />
      </Harness>,
    );
    await screen.findByTestId('rate-ddi');

    fireEvent.click(screen.getByTestId('fatigue-window'));
    fireEvent.click(await screen.findByRole('option', { name: /last 30 days/iu }));

    await waitFor(() => {
      expect(getAlertFatigue).toHaveBeenCalledWith(30, expect.anything());
    });
  });

  it('says plainly when nothing fired, rather than showing an empty grid', async () => {
    getAlertFatigue.mockResolvedValue(report({ fires: 0, byFamily: [], overridesByReason: {} }));

    render(
      <Harness>
        <AlertFatigueScreen />
      </Harness>,
    );

    expect(await screen.findByText(/No safety alert fired in this window/iu)).toBeInTheDocument();
  });
});
