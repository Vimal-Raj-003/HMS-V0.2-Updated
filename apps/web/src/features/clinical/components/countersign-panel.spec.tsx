import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider, TooltipProvider } from '@vims/ui';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '@/lib/api';
import { SessionProvider, type WorkspaceSession } from '@/lib/session-context';
import type { AlertListItem } from '../api/types';
import { CountersignPanel } from './countersign-panel';

/**
 * The second clinician's half of a hard stop.
 *
 * The behaviour under test is that this is the **only** place a hard stop can be
 * cleared from, that clearing it needs a coded reason, and that the API's
 * refusal of a self-countersignature is shown as the rule it is rather than as a
 * generic error.
 */

const listAlerts = vi.hoisted(() => vi.fn());
const respondToAlert = vi.hoisted(() => vi.fn());

vi.mock('../api/client', () => ({ listAlerts, respondToAlert }));

const HOSPITAL = '0192f0e2-0000-7000-8000-000000000011';
const ENCOUNTER = '0192f0e2-0000-7000-8000-0000000000e1';

function session(permissions: readonly string[]): WorkspaceSession {
  return {
    userId: 'user-consultant',
    displayName: 'Dr S Iyer',
    hospitalId: HOSPITAL,
    branchId: 'branch-1',
    roles: ['doctor_consultant_opd'],
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

function alert(overrides: Partial<AlertListItem> = {}): AlertListItem {
  return {
    id: 'alert-1',
    fired_at: '2026-08-22T09:00:00.000Z',
    patient_id: 'pat-1',
    encounter_id: ENCOUNTER,
    safety_floor_key: 'interaction_contraindicated',
    family: 'ddi',
    severity: 'contraindicated',
    interruption: 'hard_stop',
    outcome: 'blocked',
    title: 'Contraindicated interaction with warfarin',
    latency_ms: 21,
    degraded: false,
    context_ref: {},
    action_kind: null,
    override_reason_code: null,
    ...overrides,
  };
}

const CONSULTANT = ['cdss.alert.respond', 'rx.cosign', 'cdss.alert.read'];

beforeEach(() => {
  vi.clearAllMocks();
  listAlerts.mockResolvedValue({ items: [alert()], nextCursor: null, hasMore: false });
});

describe('who may countersign', () => {
  it('shows nothing at all to a session without the consultant key', () => {
    render(
      <Harness permissions={['cdss.alert.respond']}>
        <CountersignPanel encounterId={ENCOUNTER} />
      </Harness>,
    );
    expect(screen.queryByTestId('countersign-panel')).toBeNull();
    expect(listAlerts).not.toHaveBeenCalled();
  });

  it('lists the hard stops waiting on this consultation', async () => {
    render(
      <Harness permissions={CONSULTANT}>
        <CountersignPanel encounterId={ENCOUNTER} />
      </Harness>,
    );
    expect(await screen.findByTestId('countersign-alert-1')).toHaveTextContent(
      'Contraindicated interaction with warfarin',
    );
  });

  it('ignores an alert that has already been answered', async () => {
    listAlerts.mockResolvedValue({
      items: [alert({ action_kind: 'overridden' })],
      nextCursor: null,
      hasMore: false,
    });
    render(
      <Harness permissions={CONSULTANT}>
        <CountersignPanel encounterId={ENCOUNTER} />
      </Harness>,
    );
    expect(await screen.findByText(/Nothing on this consultation is waiting/iu)).toBeInTheDocument();
  });
});

describe('countersigning', () => {
  it('needs a coded reason, and sends the alert’s own fired-at', async () => {
    respondToAlert.mockResolvedValue({ actionId: 'action-1' });

    render(
      <Harness permissions={CONSULTANT}>
        <CountersignPanel encounterId={ENCOUNTER} />
      </Harness>,
    );
    fireEvent.click(await screen.findByTestId('countersign-open-alert-1'));

    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: /^countersign$/iu });
    expect(confirm).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: /prescribed on specialist advice/iu }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^countersign$/iu }));

    await waitFor(() => {
      expect(respondToAlert).toHaveBeenCalledWith(
        'alert-1',
        expect.objectContaining({
          firedAt: '2026-08-22T09:00:00.000Z',
          kind: 'overridden',
          reasonCode: 'SPECIALIST_ADVICE',
        }),
        expect.stringContaining('Countersigning'),
      );
    });
  });

  it('explains the refusal when the prescriber tries to countersign their own alert', async () => {
    respondToAlert.mockRejectedValue(
      new ApiProblem(
        {
          type: 'https://errors.vimshms.com/second-person-required',
          title: 'A second authorised person is required',
          status: 403,
          reference: 'trace-self',
          detail: 'A hard stop is cleared by a second clinician, not by the prescriber who raised it.',
        },
        403,
      ),
    );

    render(
      <Harness permissions={CONSULTANT}>
        <CountersignPanel encounterId={ENCOUNTER} />
      </Harness>,
    );
    fireEvent.click(await screen.findByTestId('countersign-open-alert-1'));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: /prescribed on specialist advice/iu }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^countersign$/iu }));

    const refused = await screen.findByTestId('self-countersign-refused');
    expect(refused.textContent).toMatch(/cannot be the second one/iu);
    expect(refused.textContent).toMatch(/recorded/iu);
  });
});
