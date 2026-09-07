import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@vims/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '@/lib/api';
import { SessionProvider } from '@/lib/session-context';
import { patientFixture } from '../lib/__fixtures__/patient';
import { RegistrationDesk } from './registration-desk';

/**
 * The registration desk, and above all the duplicate hard stop.
 *
 * OP-001 §3.1 and §14 AC-2 make the refusal a **hard stop**: it blocks the save
 * and can only be passed by somebody holding `patient.record.create_override`,
 * acknowledging the specific records, and giving a reason. Every test below is
 * one that fails if that friction is ever relaxed by accident — in particular the
 * second one, which asserts that nothing re-sends the request automatically.
 */

const client = vi.hoisted(() => ({
  registerPatient: vi.fn(),
  searchPatients: vi.fn(),
  listRecentPatients: vi.fn(),
}));
vi.mock('../api/client', () => client);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const CANDIDATE_ID = '018f4b2c-6d3e-7a11-9f22-0c1d2e3f4a5b';

function duplicateProblem(): ApiProblem {
  return new ApiProblem(
    {
      type: 'https://errors.vimshms.com/clinical-hard-stop',
      title: 'This action was refused',
      status: 422,
      detail: 'This looks like a patient who is already registered.',
      reference: 'trace-9',
      clinicalImpact:
        'A second record means allergies, results and prescriptions are recorded against a patient nobody is looking at.',
      nextAction: 'Open the existing record and register the visit against it.',
      errors: [
        {
          path: 'overrideDuplicate/acknowledgedPatientIds/0',
          code: 'duplicate_suspected',
          message: `0021-45871 — SHARMA, Ramesh, male, 45 (id ${CANDIDATE_ID}, score 0.90, mobile+dob)`,
        },
      ],
    },
    422,
  );
}

const DESK_PERMISSIONS = ['patient.record.list', 'patient.record.read', 'patient.record.create'];

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
            enabledModules: [],
          }}
        >
          <ToastProvider>{children}</ToastProvider>
        </SessionProvider>
      </QueryClientProvider>
    );
  };
}

/** Fills the mandatory minimum and presses Register. */
function fillAndSave(): void {
  fireEvent.click(screen.getByTestId('new-patient'));
  fireEvent.change(screen.getByTestId('reg-mobile'), { target: { value: '9845012345' } });
  fireEvent.change(screen.getByTestId('reg-first-name'), { target: { value: 'Ramesh' } });
  fireEvent.change(screen.getByTestId('reg-last-name'), { target: { value: 'Sharma' } });
  fireEvent.change(screen.getByTestId('reg-dob'), { target: { value: '1981-04-12' } });
  fireEvent.click(screen.getByTestId('register-save'));
}

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  router.push.mockReset();
  client.listRecentPatients.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
  client.searchPatients.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
  client.registerPatient.mockResolvedValue(patientFixture());
});

describe('the desk opens on search, not on a blank form', () => {
  it('shows the search rail and no registration form until one is asked for', () => {
    render(<RegistrationDesk />, { wrapper: wrapperWith(DESK_PERMISSIONS) });
    expect(screen.getByRole('heading', { name: 'Search the patient index', level: 2 })).toBeInTheDocument();
    // The field's own label is a different string from the region's heading, so
    // "Find a patient" identifies the control and nothing else.
    expect(screen.getByRole('combobox', { name: 'Find a patient' })).toBeInTheDocument();
    expect(screen.queryByTestId('reg-mobile')).not.toBeInTheDocument();
  });

  it('opens the form on F2 without a mouse ever being used', () => {
    render(<RegistrationDesk />, { wrapper: wrapperWith(DESK_PERMISSIONS) });
    fireEvent.keyDown(document, { key: 'F2' });
    expect(screen.getByTestId('reg-mobile')).toBeInTheDocument();
  });

  it('does not offer to register at all without patient.record.create', () => {
    render(<RegistrationDesk />, { wrapper: wrapperWith(['patient.record.list']) });
    expect(screen.queryByTestId('new-patient')).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'F2' });
    expect(screen.queryByTestId('reg-mobile')).not.toBeInTheDocument();
  });
});

describe('validation before the round trip', () => {
  it('lists the fields that need attention and sends nothing', () => {
    render(<RegistrationDesk />, { wrapper: wrapperWith(DESK_PERMISSIONS) });
    fireEvent.click(screen.getByTestId('new-patient'));
    fireEvent.click(screen.getByTestId('register-save'));

    const summary = screen.getByTestId('registration-error-summary');
    expect(summary).toBeInTheDocument();
    expect(within(summary).getByText(/name/i)).toBeInTheDocument();
    expect(client.registerPatient).not.toHaveBeenCalled();
  });

  it('sends the mandatory minimum with an idempotency key once the form is valid', async () => {
    render(<RegistrationDesk />, { wrapper: wrapperWith(DESK_PERMISSIONS) });
    fillAndSave();

    await waitFor(() => {
      expect(client.registerPatient).toHaveBeenCalledTimes(1);
    });
    const [body, key] = client.registerPatient.mock.calls[0] as [Record<string, unknown>, string];
    expect(body).toMatchObject({ firstName: 'Ramesh', mobile: '9845012345', dob: '1981-04-12' });
    expect(body).not.toHaveProperty('overrideDuplicate');
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(7);
  });

  it('saves on Ctrl+S as well as on the button', async () => {
    render(<RegistrationDesk />, { wrapper: wrapperWith(DESK_PERMISSIONS) });
    fireEvent.click(screen.getByTestId('new-patient'));
    fireEvent.change(screen.getByTestId('reg-mobile'), { target: { value: '9845012345' } });
    fireEvent.change(screen.getByTestId('reg-first-name'), { target: { value: 'Ramesh' } });
    fireEvent.change(screen.getByTestId('reg-dob'), { target: { value: '1981-04-12' } });
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });

    await waitFor(() => {
      expect(client.registerPatient).toHaveBeenCalledTimes(1);
    });
  });
});

describe('the duplicate hard stop', () => {
  it('shows the candidates, the clinical impact and the reference instead of a toast', async () => {
    client.registerPatient.mockRejectedValue(duplicateProblem());
    render(<RegistrationDesk />, { wrapper: wrapperWith(DESK_PERMISSIONS) });
    fillAndSave();

    const stop = await screen.findByTestId('duplicate-hard-stop');
    expect(within(stop).getByTestId('candidate-uhid')).toHaveTextContent('0021-45871');
    expect(within(stop).getByTestId('candidate-score')).toHaveTextContent('90% match');
    expect(within(stop).getByTestId('duplicate-clinical-impact')).toBeInTheDocument();
    expect(within(stop).getByTestId('duplicate-reference')).toHaveTextContent('trace-9');
  });

  it('never re-sends the registration with the override attached by itself', async () => {
    client.registerPatient.mockRejectedValue(duplicateProblem());
    render(<RegistrationDesk />, { wrapper: wrapperWith(DESK_PERMISSIONS) });
    fillAndSave();

    await screen.findByTestId('duplicate-hard-stop');
    // The whole point of a hard stop. One request went out, it was refused, and
    // nothing retried it — a human has to decide.
    expect(client.registerPatient).toHaveBeenCalledTimes(1);
    expect(client.registerPatient.mock.calls[0]?.[0]).not.toHaveProperty('overrideDuplicate');
  });

  it('offers opening the existing record as the primary way out', async () => {
    client.registerPatient.mockRejectedValue(duplicateProblem());
    render(<RegistrationDesk />, { wrapper: wrapperWith(DESK_PERMISSIONS) });
    fillAndSave();

    const stop = await screen.findByTestId('duplicate-hard-stop');
    fireEvent.click(within(stop).getByTestId('candidate-open'));
    expect(router.push).toHaveBeenCalledWith(`/patients/${CANDIDATE_ID}`);
  });

  it('refuses the override to a session that does not hold the permission, and names the key', async () => {
    client.registerPatient.mockRejectedValue(duplicateProblem());
    render(<RegistrationDesk />, { wrapper: wrapperWith(DESK_PERMISSIONS) });
    fillAndSave();

    const stop = await screen.findByTestId('duplicate-hard-stop');
    fireEvent.click(within(stop).getByTestId('duplicate-show-override'));

    expect(within(stop).getByTestId('override-not-permitted')).toHaveTextContent(
      'patient.record.create_override',
    );
    expect(within(stop).queryByTestId('override-reason')).not.toBeInTheDocument();
    // Not merely disabled — absent. `docs/06` §4.1: never render an item the user
    // cannot use, or they learn to keep pressing it.
    expect(within(stop).queryByTestId('duplicate-register-anyway')).not.toBeInTheDocument();
    expect(client.registerPatient).toHaveBeenCalledTimes(1);
  });

  it('with the permission, still needs each record acknowledged and a reason', async () => {
    client.registerPatient.mockRejectedValue(duplicateProblem());
    render(<RegistrationDesk />, {
      wrapper: wrapperWith([...DESK_PERMISSIONS, 'patient.record.create_override']),
    });
    fillAndSave();

    const stop = await screen.findByTestId('duplicate-hard-stop');
    fireEvent.click(within(stop).getByTestId('duplicate-show-override'));

    const button = within(stop).getByTestId('duplicate-register-anyway');
    expect(button).toBeDisabled();

    // A reason alone is not enough: the specific record has to be acknowledged.
    fireEvent.change(within(stop).getByTestId('override-reason'), {
      target: { value: 'Different mother and address; checked the passport at the counter' },
    });
    expect(button).toBeDisabled();

    fireEvent.click(within(stop).getByTestId('candidate-acknowledge'));
    expect(button).toBeEnabled();
  });

  it('a short reason is not a reason', async () => {
    client.registerPatient.mockRejectedValue(duplicateProblem());
    render(<RegistrationDesk />, {
      wrapper: wrapperWith([...DESK_PERMISSIONS, 'patient.record.create_override']),
    });
    fillAndSave();

    const stop = await screen.findByTestId('duplicate-hard-stop');
    fireEvent.click(within(stop).getByTestId('duplicate-show-override'));
    fireEvent.click(within(stop).getByTestId('candidate-acknowledge'));
    fireEvent.change(within(stop).getByTestId('override-reason'), { target: { value: 'diff' } });

    expect(within(stop).getByTestId('duplicate-register-anyway')).toBeDisabled();
  });

  it('sends the override with the acknowledged ids, the reason, and a fresh idempotency key', async () => {
    client.registerPatient.mockRejectedValueOnce(duplicateProblem());
    render(<RegistrationDesk />, {
      wrapper: wrapperWith([...DESK_PERMISSIONS, 'patient.record.create_override']),
    });
    fillAndSave();

    const stop = await screen.findByTestId('duplicate-hard-stop');
    fireEvent.click(within(stop).getByTestId('duplicate-show-override'));
    fireEvent.click(within(stop).getByTestId('candidate-acknowledge'));
    fireEvent.change(within(stop).getByTestId('override-reason'), {
      target: { value: 'Different mother and address; checked the passport at the counter' },
    });

    client.registerPatient.mockResolvedValueOnce(patientFixture({ uhid: '0021-99999' }));
    fireEvent.click(within(stop).getByTestId('duplicate-register-anyway'));

    await waitFor(() => {
      expect(client.registerPatient).toHaveBeenCalledTimes(2);
    });
    const [body, key] = client.registerPatient.mock.calls[1] as [Record<string, unknown>, string];
    expect(body).toMatchObject({
      overrideDuplicate: {
        acknowledgedPatientIds: [CANDIDATE_ID],
        reason: 'Different mother and address; checked the passport at the counter',
      },
    });
    // A different body is a different submission: reusing the first key would be
    // refused as a fingerprint mismatch.
    expect(key).not.toBe(client.registerPatient.mock.calls[0]?.[1]);
  });
});

describe('after a successful registration', () => {
  it('shows the new UHID and the card to print, and returns to search', async () => {
    client.registerPatient.mockResolvedValue(patientFixture({ uhid: '0021-45871' }));
    render(<RegistrationDesk />, { wrapper: wrapperWith(DESK_PERMISSIONS) });
    fillAndSave();

    expect(await screen.findByTestId('new-uhid')).toHaveTextContent('0021-45871');
    expect(screen.getAllByTestId('uhid-card').length).toBeGreaterThan(0);
    // The form is gone, so the next patient starts from search rather than from
    // the previous patient's half-cleared demographics.
    expect(screen.queryByTestId('reg-mobile')).not.toBeInTheDocument();
  });

  it('opens the new record on request', async () => {
    const patient = patientFixture();
    client.registerPatient.mockResolvedValue(patient);
    render(<RegistrationDesk />, { wrapper: wrapperWith(DESK_PERMISSIONS) });
    fillAndSave();

    fireEvent.click(await screen.findByTestId('open-new-patient'));
    expect(router.push).toHaveBeenCalledWith(`/patients/${patient.id}`);
  });
});
