import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@vims/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '@/lib/session-context';
import { bannerFixture, patientFixture } from '../lib/__fixtures__/patient';
import { Patient360 } from './patient-360';

/**
 * Patient 360, and the two things on it that can hurt somebody:
 *
 *  - the **allergy strip**, which must never read as "none" when nobody has
 *    asked. `docs/06` §10 names that conflation as a defect, and the first block
 *    below is its regression test at the screen level rather than only in the
 *    projection.
 *  - the **amendment**, which OP-001 §14 AC-14 requires to carry a reason and the
 *    version it was read at. The reason is sent twice — the header satisfies
 *    `patient.record.update`'s `requiresReason`, the body is written to
 *    `patient.demographic_history` — and `api/client.spec.ts` asserts the header
 *    half; this file asserts the screen collects it at all.
 */

const client = vi.hoisted(() => ({
  getPatient: vi.fn(),
  getPatientHistory: vi.fn(),
  listPatientVisits: vi.fn(),
  updatePatient: vi.fn(),
}));
vi.mock('../api/client', () => client);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const READ_ONLY = ['patient.record.read'];
const DESK = ['patient.record.read', 'patient.record.update', 'visit.list'];

function wrapperWith(permissions: readonly string[]) {
  return function Wrapper({ children }: { readonly children: ReactNode }): React.JSX.Element {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return (
      <QueryClientProvider client={queryClient}>
        <SessionProvider
          session={{
            userId: 'me',
            displayName: 'A. Receptionist',
            hospitalId: 'h1',
            branchId: 'b1',
            roles: ['receptionist'],
            permissions,
          }}
        >
          <ToastProvider>{children}</ToastProvider>
        </SessionProvider>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.getPatient.mockResolvedValue(patientFixture());
  client.getPatientHistory.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
  client.listPatientVisits.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
  client.updatePatient.mockImplementation((_id: string, body: { version: number }) =>
    Promise.resolve(patientFixture({ version: body.version + 1 })),
  );
  router.push.mockReset();
});

describe('the allergy strip', () => {
  it('says allergies are NOT RECORDED when nobody has asked — never “no known allergies”', async () => {
    client.getPatient.mockResolvedValue(
      patientFixture({
        allergy_statement: 'not_recorded',
        banner: bannerFixture({ allergy_statement: 'not_recorded' }),
      }),
    );
    const { container } = render(<Patient360 patientId="p1" />, { wrapper: wrapperWith(READ_ONLY) });

    expect(await screen.findAllByText(/allergies not recorded/i)).not.toHaveLength(0);
    // The banner's own chip, by the attribute the design system stamps on it.
    expect(container.querySelector('[data-flag="allergy-not-recorded"]')).not.toBeNull();
    expect(container.querySelector('[data-flag="allergy-none-known"]')).toBeNull();
    expect(container.querySelector('[data-statement-kind="not-recorded"]')).not.toBeNull();
  });

  it('says “no known allergies” only when somebody actually asserted it', async () => {
    client.getPatient.mockResolvedValue(
      patientFixture({
        allergy_statement: 'none_known',
        allergy_asserted_by: 'S. Nurse',
        allergy_asserted_at: '2026-08-12T04:30:00.000Z',
        banner: bannerFixture({
          allergy_statement: 'none_known',
          allergy_asserted_at: '2026-08-12T04:30:00.000Z',
        }),
      }),
    );
    const { container } = render(<Patient360 patientId="p1" />, { wrapper: wrapperWith(READ_ONLY) });

    await waitFor(() => {
      expect(container.querySelector('[data-flag="allergy-none-known"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-flag="allergy-not-recorded"]')).toBeNull();
    expect(container.querySelector('[data-statement-kind="none-known"]')).not.toBeNull();
  });

  it('shows the reason when the history could not be established', async () => {
    client.getPatient.mockResolvedValue(
      patientFixture({
        allergy_statement: 'unable_to_assess',
        allergy_unable_reason: 'Patient unconscious, no attendant present',
        banner: bannerFixture({
          allergy_statement: 'unable_to_assess',
          allergy_unable_reason: 'Patient unconscious, no attendant present',
        }),
      }),
    );
    const { container } = render(<Patient360 patientId="p1" />, { wrapper: wrapperWith(READ_ONLY) });

    expect(await screen.findAllByText(/no attendant present/i)).not.toHaveLength(0);
    expect(container.querySelector('[data-flag="allergy-unable-to-assess"]')).not.toBeNull();
    expect(container.querySelector('[data-flag="allergy-none-known"]')).toBeNull();
  });
});

describe('safety notices', () => {
  it('warns that a merged record is an alias and points at the survivor', async () => {
    client.getPatient.mockResolvedValue(
      patientFixture({ merged_into_id: 'survivor-1', merged_at: '2026-08-21T05:00:00.000Z' }),
    );
    render(<Patient360 patientId="p1" />, { wrapper: wrapperWith(READ_ONLY) });

    expect(await screen.findByTestId('merged-notice')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('open-survivor'));
    expect(router.push).toHaveBeenCalledWith('/patients/survivor-1');
  });

  it('says a deceased patient is deceased before anybody books them an appointment', async () => {
    client.getPatient.mockResolvedValue(
      patientFixture({ is_deceased: true, deceased_at: '2026-07-01T00:00:00.000Z' }),
    );
    render(<Patient360 patientId="p1" />, { wrapper: wrapperWith(READ_ONLY) });
    expect(await screen.findByTestId('deceased-notice')).toHaveTextContent('01-07-2026');
  });

  it('shows the reason a record was created past a duplicate stop', async () => {
    client.getPatient.mockResolvedValue(
      patientFixture({ created_override_reason: 'Twin brother, different date of birth on the passport' }),
    );
    render(<Patient360 patientId="p1" />, { wrapper: wrapperWith(READ_ONLY) });
    expect(await screen.findByTestId('override-notice')).toHaveTextContent('Twin brother');
  });
});

describe('amending', () => {
  it('is not offered at all without patient.record.update', async () => {
    render(<Patient360 patientId="p1" />, { wrapper: wrapperWith(READ_ONLY) });
    await screen.findByTestId('patient-360');
    expect(screen.queryByTestId('amend-open')).not.toBeInTheDocument();
  });

  it('will not save until something has changed AND a reason has been given', async () => {
    render(<Patient360 patientId="p1" />, { wrapper: wrapperWith(DESK) });
    fireEvent.click(await screen.findByTestId('amend-open'));

    expect(screen.getByTestId('amend-no-changes')).toBeInTheDocument();
    expect(screen.getByTestId('amend-save')).toBeDisabled();

    fireEvent.change(screen.getByTestId('amend-last-name'), { target: { value: 'Sharmaa' } });
    expect(screen.getByTestId('amend-changed-fields')).toHaveTextContent('Last name');
    // A change without a reason is still refused: the reason is what the register
    // will show a year from now.
    expect(screen.getByTestId('amend-save')).toBeDisabled();

    fireEvent.change(screen.getByTestId('amend-reason'), {
      target: { value: 'Surname misspelled at registration; corrected against the passport' },
    });
    expect(screen.getByTestId('amend-save')).toBeEnabled();
  });

  it('warns louder when the change is to a field that decides who the patient is', async () => {
    render(<Patient360 patientId="p1" />, { wrapper: wrapperWith(DESK) });
    fireEvent.click(await screen.findByTestId('amend-open'));

    expect(screen.queryByTestId('amend-identity-warning')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('amend-dob'), { target: { value: '1981-04-13' } });
    expect(screen.getByTestId('amend-identity-warning')).toBeInTheDocument();
  });

  it('sends only what changed, with the reason and the version it read', async () => {
    render(<Patient360 patientId="p1" />, { wrapper: wrapperWith(DESK) });
    fireEvent.click(await screen.findByTestId('amend-open'));

    fireEvent.change(screen.getByTestId('amend-mobile'), { target: { value: '9845099999' } });
    fireEvent.change(screen.getByTestId('amend-reason'), {
      target: { value: 'New number given at the counter; old one belongs to the previous tenant' },
    });
    fireEvent.click(screen.getByTestId('amend-save'));

    await waitFor(() => {
      expect(client.updatePatient).toHaveBeenCalledTimes(1);
    });
    const [id, body] = client.updatePatient.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('p1');
    expect(body).toEqual({
      version: 1,
      channel: 'desk',
      reason: 'New number given at the counter; old one belongs to the previous tenant',
      mobile: '9845099999',
    });
    // Nothing else travelled: an unchanged field in the body becomes a row in the
    // demographic history in which nothing changed.
    expect(body).not.toHaveProperty('firstName');
  });

  it('opens on F5, as OP-001 §8 specifies', async () => {
    render(<Patient360 patientId="p1" />, { wrapper: wrapperWith(DESK) });
    await screen.findByTestId('amend-open');
    fireEvent.keyDown(document, { key: 'F5' });
    expect(await screen.findByTestId('amend-reason')).toBeInTheDocument();
  });
});

describe('the record’s own history', () => {
  it('shows what changed, from what to what, and why', async () => {
    client.getPatientHistory.mockResolvedValue({
      items: [
        {
          id: 'h1',
          changed_fields: ['mobile'],
          before: { mobile: '+919845012345' },
          after: { mobile: '+919845099999' },
          reason: 'New number given at the counter',
          channel: 'desk',
          changed_by: 'user-1',
          changed_at: '2026-08-21T05:00:00.000Z',
          audit_id: 'a1',
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    render(<Patient360 patientId="p1" />, { wrapper: wrapperWith(DESK) });

    // Radix activates a tab on `mousedown`, not on `click`.
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'What changed' }));
    const history = await screen.findByTestId('demographic-history');
    expect(history).toHaveTextContent('Mobile');
    expect(history).toHaveTextContent('+919845012345');
    expect(history).toHaveTextContent('+919845099999');
    expect(history).toHaveTextContent('New number given at the counter');
  });
});

describe('the visit history', () => {
  it('explains its absence rather than showing an empty list to somebody who cannot read it', async () => {
    render(<Patient360 patientId="p1" />, { wrapper: wrapperWith(READ_ONLY) });
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Visits' }));
    expect(await screen.findByText(/visit\.list/)).toBeInTheDocument();
    expect(client.listPatientVisits).not.toHaveBeenCalled();
  });
});
