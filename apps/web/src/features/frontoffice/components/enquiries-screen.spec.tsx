import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider, TooltipProvider } from '@vims/ui';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, type WorkspaceSession } from '@/lib/session-context';
import type { AppointmentRequestRow } from '../api/types';
import { EnquiriesScreen } from './enquiries-screen';

/**
 * The enquiry worklist as front office uses it.
 *
 * The assertions are the ones that decide whether the screen is honest: that it
 * never calls an enquiry a booking, that a decline cannot happen without a
 * reason reaching the API, and that somebody who may read the queue but not
 * work it is told so rather than shown buttons that will 403.
 */

const listAppointmentRequests = vi.hoisted(() => vi.fn());
const updateAppointmentRequest = vi.hoisted(() => vi.fn());
const convertAppointmentRequest = vi.hoisted(() => vi.fn());

vi.mock('../api/client', () => ({
  listAppointmentRequests,
  updateAppointmentRequest,
  convertAppointmentRequest,
}));

const HOSPITAL = '0192f0e2-0000-7000-8000-000000000011';
const ENQUIRY = '0192f0e2-0000-7000-8000-0000000000e1';

function enquiry(overrides: Partial<AppointmentRequestRow> = {}): AppointmentRequestRow {
  return {
    id: ENQUIRY,
    channel: 'web_assistant',
    requesterName: 'Lakshmi Narayan',
    requesterPhone: '+919845012345',
    requesterEmail: null,
    specialityKey: '0192f0e2-0000-7000-8000-0000000000s1',
    specialityName: 'Orthopaedics',
    practitionerKey: null,
    practitionerName: null,
    slotId: null,
    preferredDate: '2026-09-25',
    preferredPeriod: 'morning',
    reason: 'knee pain, follow up',
    status: 'new',
    appointmentId: null,
    handledAt: null,
    declineReason: null,
    createdAt: new Date('2026-09-20T04:30:00Z').toISOString(),
    ...overrides,
  };
}

function session(permissions: readonly string[]): WorkspaceSession {
  return {
    userId: 'user-1',
    displayName: 'Anitha R',
    hospitalId: HOSPITAL,
    branchId: 'branch-1',
    roles: ['receptionist'],
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

const WORKER = ['appointment.request.list', 'appointment.request.update'];

beforeEach(() => {
  vi.clearAllMocks();
  listAppointmentRequests.mockResolvedValue([enquiry()]);
  updateAppointmentRequest.mockResolvedValue(enquiry({ status: 'contacted' }));
});

describe('the enquiry worklist', () => {
  it('shows who asked, what for, and a number that can be dialled', async () => {
    render(
      <Harness permissions={WORKER}>
        <EnquiriesScreen />
      </Harness>,
    );

    expect(await screen.findByText('Lakshmi Narayan')).toBeInTheDocument();
    expect(screen.getByText('Orthopaedics')).toBeInTheDocument();
    // The column the job is done from: a clerk rings this, so it must be a
    // tel: link rather than text to be copied out and mistyped.
    const phone = screen.getByRole('link', { name: '+919845012345' });
    expect(phone).toHaveAttribute('href', 'tel:+919845012345');
  });

  it('says plainly that these are requests, not bookings', async () => {
    render(
      <Harness permissions={WORKER}>
        <EnquiriesScreen />
      </Harness>,
    );
    await screen.findByText('Lakshmi Narayan');
    // The single most damaging thing this screen could imply is that the
    // patient already has an appointment.
    expect(screen.getByText(/requests, not bookings/i)).toBeInTheDocument();
  });

  it('opens on the new enquiries, because that is the queue being worked', async () => {
    render(
      <Harness permissions={WORKER}>
        <EnquiriesScreen />
      </Harness>,
    );
    await waitFor(() => {
      expect(listAppointmentRequests).toHaveBeenCalledWith('new');
    });
  });

  it('marks an enquiry contacted, carrying the reason the policy engine demands', async () => {
    render(
      <Harness permissions={WORKER}>
        <EnquiriesScreen />
      </Harness>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /mark contacted/i }));

    await waitFor(() => {
      expect(updateAppointmentRequest).toHaveBeenCalledWith(
        ENQUIRY,
        { status: 'contacted' },
        expect.any(String),
      );
    });
    // `appointment.request.update` is `requiresReason`; an empty x-reason is a 403.
    const reason = updateAppointmentRequest.mock.calls[0]?.[2] as string;
    expect(reason.length).toBeGreaterThan(0);
  });

  it('will not decline without a reason reaching the API', async () => {
    render(
      <Harness permissions={WORKER}>
        <EnquiriesScreen />
      </Harness>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^decline$/i }));

    // The dialog explains why a reason is needed before the API refuses.
    expect(await screen.findByText(/cannot be told apart from one somebody dropped/i)).toBeInTheDocument();
    expect(updateAppointmentRequest).not.toHaveBeenCalled();
  });

  it('tells a read-only session it is read-only instead of showing dead buttons', async () => {
    render(
      <Harness permissions={['appointment.request.list']}>
        <EnquiriesScreen />
      </Harness>,
    );
    await screen.findByText('Lakshmi Narayan');
    expect(screen.getByText('Read only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark contacted/i })).not.toBeInTheDocument();
  });

  it('offers no action on an enquiry that is already closed', async () => {
    listAppointmentRequests.mockResolvedValue([enquiry({ status: 'booked', appointmentId: 'appt-1' })]);
    render(
      <Harness permissions={WORKER}>
        <EnquiriesScreen />
      </Harness>,
    );
    await screen.findByText('Lakshmi Narayan');
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^decline$/i })).not.toBeInTheDocument();
  });

  it('explains an empty queue rather than showing a blank table', async () => {
    listAppointmentRequests.mockResolvedValue([]);
    render(
      <Harness permissions={WORKER}>
        <EnquiriesScreen />
      </Harness>,
    );
    expect(await screen.findByText(/nobody has left an enquiry/i)).toBeInTheDocument();
  });
});
