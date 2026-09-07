import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider, TooltipProvider } from '@vims/ui';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '@/lib/api';
import { SessionProvider, type WorkspaceSession } from '@/lib/session-context';
import type { AlertView, DrugSearchResult, EvaluationView } from '../api/types';
import { PrescriptionScreen } from './prescription-screen';

/**
 * The prescribing screen's safety behaviour.
 *
 * Every test here is written so that it **fails if the behaviour is removed**:
 *
 *  - the hard-stop tests assert the *absence* of any control that submits, and
 *    scan every button on the screen for a "proceed anyway" affordance by name.
 *    Re-adding a disabled "Prescribe" button, or a "prescribe anyway"
 *    confirmation, fails them;
 *  - the refusal test asserts the API was called exactly **once**, so an
 *    automatic retry of a refused prescription fails it;
 *  - the soft-stop test asserts the confirm control is unusable until a coded
 *    reason is chosen, so offering free text alone fails it;
 *  - the weight test asserts the instruction is on screen, so surfacing the raw
 *    refusal fails it.
 */

const evaluate = vi.hoisted(() => vi.fn());
const createPrescription = vi.hoisted(() => vi.fn());
const searchDrugs = vi.hoisted(() => vi.fn());
const getAllergies = vi.hoisted(() => vi.fn());
const checkDosing = vi.hoisted(() => vi.fn());
const signPrescription = vi.hoisted(() => vi.fn());
const getPatient = vi.hoisted(() => vi.fn());

vi.mock('../api/client', () => ({
  evaluate,
  createPrescription,
  searchDrugs,
  getAllergies,
  checkDosing,
  signPrescription,
}));

vi.mock('@/features/patient/api/client', () => ({ getPatient }));

const HOSPITAL = '0192f0e2-0000-7000-8000-000000000011';
const PATIENT = '0192f0e2-0000-7000-8000-0000000000a1';
const ENCOUNTER = '0192f0e2-0000-7000-8000-0000000000e1';

const PRESCRIBER = [
  'rx.create',
  'rx.sign',
  'rx.drug.search',
  'cdss.evaluate',
  'cdss.alert.read',
  'patient.record.read',
];

function session(permissions: readonly string[]): WorkspaceSession {
  return {
    userId: 'user-doctor',
    displayName: 'Dr A Menon',
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

function drug(overrides: Partial<DrugSearchResult> = {}): DrugSearchResult {
  return {
    record_key: '0192f0e2-0000-7000-8000-0000000000d1',
    code: 'AMOX500',
    generic_name: 'Amoxicillin',
    brand_name: 'Novamox',
    strength_text: '500 mg',
    form: 'capsule',
    route: 'oral',
    schedule: 'h',
    is_high_alert: false,
    is_lasa: false,
    tall_man_display: null,
    in_formulary: true,
    ...overrides,
  };
}

function alert(overrides: Partial<AlertView> = {}): AlertView {
  return {
    alertEventId: 'alert-1',
    firedAt: '2026-08-22T09:00:00.000Z',
    lineNo: 1,
    family: 'allergy',
    severity: 'contraindicated',
    interruption: 'hard_stop',
    safetyFloorKey: 'allergy_documented_anaphylaxis',
    title: 'Documented anaphylaxis to this ingredient',
    detail: 'The patient has a recorded anaphylactic reaction to penicillin.',
    suggestedAction: 'Choose a drug from another class.',
    subjectCode: 'PEN',
    overrideReasonCode: null,
    cleared: false,
    ...overrides,
  };
}

function evaluation(overrides: Partial<EvaluationView> = {}): EvaluationView {
  return {
    alerts: [],
    blocking: [],
    needsCodedReason: [],
    degraded: false,
    degradedFamilies: [],
    snapshotDigest: 'digest',
    latencyMs: 14,
    ruleLatencyMs: 9,
    ...overrides,
  };
}

function patientRecord(): unknown {
  return {
    id: PATIENT,
    uhid: 'VH-000123',
    full_name: 'Radha Sharma',
    gender: 'female',
    dob: '1988-04-02',
    dob_is_estimated: false,
    age_years: 38,
    mobile: '9000000000',
    category: 'general',
    status: 'active',
    merged_into_id: null,
    branch_id: 'branch-1',
    last_visit_at: null,
    registered_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    mpi_group_id: null,
    title_code: null,
    first_name: 'Radha',
    middle_name: null,
    last_name: 'Sharma',
    local_name: null,
    age_months: null,
    age_days: null,
    blood_group: 'unknown',
    marital_status: null,
    allergy_statement: 'known',
    allergy_asserted_by: 'Dr A Menon',
    allergy_asserted_at: '2026-01-04T10:00:00.000Z',
    allergy_unable_reason: null,
    payer_type: 'self',
    banner: {
      uhid: 'VH-000123',
      full_name: 'Radha Sharma',
      gender: 'female',
      age_display: '38 y',
      blood_group: 'unknown',
      photo_file_id: null,
      allergy_statement: 'known',
      allergy_asserted_at: '2026-01-04T10:00:00.000Z',
      allergy_unable_reason: null,
      allergies: [
        {
          id: 'a1',
          category: 'drug',
          substance_text: 'Penicillin',
          criticality: 'high',
          severity: 'severe',
          status: 'active',
        },
      ],
      alerts: [],
      is_vip: false,
      is_deceased: false,
      status: 'active',
      merged_into_id: null,
    },
  };
}

async function addDrugLine(): Promise<void> {
  fireEvent.change(screen.getByTestId('rx-patient'), { target: { value: PATIENT } });
  fireEvent.change(screen.getByTestId('drug-search-input'), { target: { value: 'amox' } });
  const option = await screen.findByTestId('drug-option-AMOX500', undefined, { timeout: 3000 });
  fireEvent.click(option);
}

/** Every button on screen, by its accessible text. */
function buttonNames(): readonly string[] {
  return screen.queryAllByRole('button').map((button) => button.textContent ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  searchDrugs.mockResolvedValue({ items: [drug()] });
  getAllergies.mockResolvedValue([
    {
      id: 'a1',
      category: 'drug',
      substance_text: 'Penicillin',
      substance_code: null,
      reaction: ['anaphylaxis'],
      criticality: 'high',
      severity: 'anaphylaxis',
      status: 'active',
      verification: 'confirmed',
      recorded_by: 'Dr A Menon',
      recorded_at: '2026-01-04T10:00:00.000Z',
    },
  ]);
  getPatient.mockResolvedValue(patientRecord());
  evaluate.mockResolvedValue(evaluation());
  checkDosing.mockResolvedValue({
    encounterId: ENCOUNTER,
    weightKg: 14,
    source: 'measured',
    assertedAt: '2026-08-22T08:00:00.000Z',
    assertedBy: 'nurse',
    vitalsId: 'v1',
    doseMg: 140,
  });
});

describe('a hard stop', () => {
  it('removes the ability to prescribe rather than disabling it', async () => {
    evaluate.mockResolvedValue(evaluation({ alerts: [alert()], blocking: [alert()] }));

    render(
      <Harness permissions={PRESCRIBER}>
        <PrescriptionScreen />
      </Harness>,
    );
    await addDrugLine();

    await screen.findByTestId('cdss-hard-stop', undefined, { timeout: 3000 });
    expect(screen.queryByTestId('rx-submit')).toBeNull();
  });

  it('offers no "proceed anyway" affordance of any kind', async () => {
    evaluate.mockResolvedValue(evaluation({ alerts: [alert()], blocking: [alert()] }));

    render(
      <Harness permissions={PRESCRIBER}>
        <PrescriptionScreen />
      </Harness>,
    );
    await addDrugLine();
    await screen.findByTestId('cdss-hard-stop', undefined, { timeout: 3000 });

    for (const name of buttonNames()) {
      expect(name).not.toMatch(/anyway|override|proceed|continue|force|ignore|bypass|dismiss/iu);
    }
    // And nothing that would submit, under any label.
    expect(screen.queryByRole('button', { name: /prescribe/iu })).toBeNull();
  });

  it('says what does clear it — a second clinician, not this one', async () => {
    evaluate.mockResolvedValue(evaluation({ alerts: [alert()], blocking: [alert()] }));

    render(
      <Harness permissions={PRESCRIBER}>
        <PrescriptionScreen />
      </Harness>,
    );
    await addDrugLine();

    const card = await screen.findByTestId('cdss-hard-stop', undefined, { timeout: 3000 });
    expect(within(card).getByTestId('hard-stop-alert-id')).toHaveTextContent('alert-1');
    expect(card.textContent).toMatch(/countersign/iu);
    expect(card.textContent).toMatch(/cannot be given here|second person/iu);
  });

  it('keeps the block however many coded reasons are recorded', async () => {
    evaluate.mockResolvedValue(
      evaluation({
        alerts: [alert(), alert({ alertEventId: 'alert-2', family: 'ddi', interruption: 'soft_stop' })],
        blocking: [alert()],
        needsCodedReason: [alert({ alertEventId: 'alert-2', family: 'ddi', interruption: 'soft_stop' })],
      }),
    );

    render(
      <Harness permissions={PRESCRIBER}>
        <PrescriptionScreen />
      </Harness>,
    );
    await addDrugLine();
    await screen.findByTestId('cdss-hard-stop', undefined, { timeout: 3000 });

    fireEvent.click(screen.getByTestId('soft-stop-answer-ddi'));
    expect(screen.queryByTestId('rx-submit')).toBeNull();
  });
});

describe('a hard stop the server raises at submission', () => {
  const refusal = new ApiProblem(
    {
      type: 'https://errors.vimshms.com/clinical-hard-stop',
      title: 'Stopped for patient safety',
      status: 422,
      reference: 'trace-xyz789',
      detail: 'This prescription was stopped for patient safety.',
      nextAction: 'Change the prescription, or have a consultant countersign the alert.',
      errors: [{ path: 'items/0', code: 'alert-77', message: 'Documented anaphylaxis' }],
    },
    422,
  );

  it('shows the refusal with its reference and never retries it', async () => {
    createPrescription.mockRejectedValue(refusal);

    render(
      <Harness permissions={PRESCRIBER}>
        <PrescriptionScreen />
      </Harness>,
    );
    await addDrugLine();

    const submit = await screen.findByTestId('rx-submit', undefined, { timeout: 3000 });
    await waitFor(() => {
      expect(submit).not.toBeDisabled();
    });
    fireEvent.click(submit);

    const card = await screen.findByTestId('rx-refused-hard-stop');
    expect(within(card).getByTestId('refused-reference')).toHaveTextContent('trace-xyz789');
    expect(within(card).getByTestId('refused-alert-ids')).toHaveTextContent('alert-77');

    // One attempt. A refused prescription is never re-sent by this screen.
    await waitFor(() => {
      expect(createPrescription).toHaveBeenCalledTimes(1);
    });
    // And no retry affordance on the refusal itself.
    expect(within(card).queryByRole('button')).toBeNull();
  });
});

describe('a soft stop', () => {
  const softAlert = alert({
    alertEventId: 'alert-9',
    family: 'ddi',
    interruption: 'soft_stop',
    severity: 'major',
    safetyFloorKey: null,
    title: 'Major interaction with warfarin',
  });

  it('will not let the prescription go until a coded reason is recorded', async () => {
    evaluate.mockResolvedValue(evaluation({ alerts: [softAlert], needsCodedReason: [softAlert] }));

    render(
      <Harness permissions={PRESCRIBER}>
        <PrescriptionScreen />
      </Harness>,
    );
    await addDrugLine();

    await screen.findByTestId('soft-stop-ddi', undefined, { timeout: 3000 });
    expect(screen.getByTestId('rx-submit')).toBeDisabled();
  });

  it('demands a code — a note on its own cannot confirm it', async () => {
    evaluate.mockResolvedValue(evaluation({ alerts: [softAlert], needsCodedReason: [softAlert] }));

    render(
      <Harness permissions={PRESCRIBER}>
        <PrescriptionScreen />
      </Harness>,
    );
    await addDrugLine();
    fireEvent.click(await screen.findByTestId('soft-stop-answer-ddi', undefined, { timeout: 3000 }));

    const dialog = await screen.findByRole('alertdialog');
    const textarea = within(dialog).getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'the patient has taken both for years' } });

    const confirm = within(dialog).getByRole('button', { name: /record the reason/iu });
    expect(confirm).toBeDisabled();
  });
});

describe('a per-kilogram dose with no recorded weight', () => {
  it('reads as an instruction, not as a raw refusal', async () => {
    checkDosing.mockRejectedValue(
      new ApiProblem(
        {
          type: 'https://errors.vimshms.com/clinical-hard-stop',
          title: 'Stopped for patient safety',
          status: 422,
          reference: 'trace-weight-1',
          detail: 'Amoxicillin is dosed per kilogram and this patient has no recorded weight.',
          nextAction: 'Weigh the patient, or record a stated weight on the encounter.',
          clinicalImpact: 'A per-kilogram dose computed from a guessed weight is a dosing error.',
        },
        422,
      ),
    );

    render(
      <Harness permissions={PRESCRIBER}>
        <PrescriptionScreen />
      </Harness>,
    );
    await addDrugLine();
    fireEvent.change(screen.getByTestId('rx-encounter'), { target: { value: ENCOUNTER } });

    const dose = screen.getByTestId('rx-dose-line-1');
    fireEvent.change(dose, { target: { value: '10' } });

    const basisTrigger = screen.getByTestId('rx-basis-line-1');
    fireEvent.click(basisTrigger);
    fireEvent.click(await screen.findByRole('option', { name: /per kilogram/iu }));

    const block = await screen.findByTestId('rx-weight-required-line-1', undefined, { timeout: 3000 });
    expect(block.textContent).toMatch(/weight/iu);
    expect(block.textContent).toMatch(/Weigh the patient/iu);
    expect(block.textContent).not.toMatch(/\b500\b/u);
    expect(within(block).getByTestId('weight-required-reference')).toHaveTextContent('trace-weight-1');
  });
});

describe('a session that cannot prescribe', () => {
  it('explains rather than showing a control that would be refused', () => {
    render(
      <Harness permissions={['patient.record.read', 'cdss.evaluate']}>
        <PrescriptionScreen />
      </Harness>,
    );
    expect(screen.getByTestId('action-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('required-permission')).toHaveTextContent('rx.create');
    expect(screen.queryByTestId('rx-submit')).toBeNull();
  });
});
