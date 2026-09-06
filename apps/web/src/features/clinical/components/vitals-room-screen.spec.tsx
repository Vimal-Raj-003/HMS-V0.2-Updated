import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider, TooltipProvider } from '@vims/ui';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, type WorkspaceSession } from '@/lib/session-context';
import type { ReferenceRangeRow, VitalsDetail } from '../api/types';
import { VitalsRoomScreen } from './vitals-room-screen';

/**
 * The vitals station.
 *
 * The two properties under test are the ones that would be quietly lost in a
 * refactor:
 *
 *  1. **no threshold is compiled in.** With no readable bands nothing is
 *    coloured — and in particular nothing is coloured green. Hard-coding a
 *    fallback threshold makes the "not scored" assertions fail.
 *  2. **a critical reading cannot be dismissed**, and the acknowledgement is the
 *    doctor's rather than the nurse's.
 */

const listReferenceRanges = vi.hoisted(() => vi.fn());
const listVitals = vi.hoisted(() => vi.fn());
const recordVitals = vi.hoisted(() => vi.fn());
const acknowledgeVitalsAlert = vi.hoisted(() => vi.fn());
const getAllergies = vi.hoisted(() => vi.fn());
const getPatient = vi.hoisted(() => vi.fn());

vi.mock('../api/client', () => ({
  listReferenceRanges,
  listVitals,
  recordVitals,
  acknowledgeVitalsAlert,
  getAllergies,
}));

vi.mock('@/features/patient/api/client', () => ({ getPatient }));

const HOSPITAL = '0192f0e2-0000-7000-8000-000000000011';
const PATIENT = '0192f0e2-0000-7000-8000-0000000000a1';

/** `nurse_opd` (docs/05 row 16) — note the absence of `vitals.configure`. */
const VITALS_NURSE = [
  'vitals.record.create',
  'vitals.record.read',
  'vitals.record.correct',
  'patient.record.read',
];

/** The same nurse on a login that also carries the configuration key. */
const NURSE_WITH_BANDS = [...VITALS_NURSE, 'vitals.configure'];

function session(permissions: readonly string[]): WorkspaceSession {
  return {
    userId: 'user-nurse',
    displayName: 'Sister Rani',
    hospitalId: HOSPITAL,
    branchId: 'branch-1',
    roles: ['nurse_opd'],
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

function bandRow(overrides: Partial<ReferenceRangeRow> = {}): ReferenceRangeRow {
  return {
    id: 'r-sys',
    parameter: 'systolic',
    age_min_days: 0,
    age_max_days: 43_800,
    sex: 'any',
    pregnancy: null,
    scale: null,
    low_abnormal: 100,
    high_abnormal: 140,
    low_critical: 90,
    high_critical: 180,
    low_plausible: 40,
    high_plausible: 300,
    unit: 'mmHg',
    ...overrides,
  };
}

function savedRecord(overrides: Partial<VitalsDetail> = {}): VitalsDetail {
  return {
    id: 'vit-1',
    patient_id: PATIENT,
    visit_id: null,
    encounter_id: null,
    context: 'opd_vitals_room',
    recorded_at: '2026-08-22T09:05:00.000Z',
    recorded_by: 'user-nurse',
    station_id: null,
    systolic: 190,
    diastolic: 96,
    pulse: null,
    spo2: null,
    on_oxygen: false,
    copd_scale2: false,
    temperature_c: null,
    resp_rate: null,
    glucose_mgdl: null,
    glucose_type: null,
    height_cm: null,
    weight_kg: null,
    bmi: null,
    pain_score: null,
    avpu: null,
    gcs_total: null,
    lmp_date: null,
    pregnancy_status: 'unknown',
    news2_score: 6,
    news2_band: 'medium',
    flags: { systolic: 'critical' },
    overall_flag: 'critical',
    source: 'manual',
    notes: null,
    repeat_of_id: null,
    corrects_id: null,
    corrected_reason: null,
    superseded_at: null,
    version: 1,
    alerts: [
      {
        id: 'alert-v1',
        level: 'critical',
        parameters: ['systolic'],
        notified_doctor_id: 'doc-1',
        acknowledged_at: null,
        acknowledged_by: null,
        action_taken: 'none',
        note: null,
      },
    ],
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
    allergy_statement: 'not_recorded',
    allergy_asserted_by: null,
    allergy_asserted_at: null,
    allergy_unable_reason: null,
    payer_type: 'self',
    banner: {
      uhid: 'VH-000123',
      full_name: 'Radha Sharma',
      gender: 'female',
      age_display: '38 y',
      blood_group: 'unknown',
      photo_file_id: null,
      allergy_statement: 'not_recorded',
      allergy_asserted_at: null,
      allergy_unable_reason: null,
      allergies: [],
      alerts: [],
      is_vip: false,
      is_deceased: false,
      status: 'active',
      merged_into_id: null,
    },
  };
}

function openPatient(): void {
  fireEvent.change(screen.getByTestId('vitals-patient'), { target: { value: PATIENT } });
}

beforeEach(() => {
  vi.clearAllMocks();
  listReferenceRanges.mockResolvedValue({ items: [bandRow()], nextCursor: null, hasMore: false });
  listVitals.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
  getAllergies.mockResolvedValue([]);
  getPatient.mockResolvedValue(patientRecord());
  recordVitals.mockResolvedValue(savedRecord());
});

describe('flagging', () => {
  it('colours a reading against the hospital’s own band', async () => {
    render(
      <Harness permissions={NURSE_WITH_BANDS}>
        <VitalsRoomScreen />
      </Harness>,
    );
    openPatient();
    await screen.findByTestId('vitals-entry-pad');

    fireEvent.change(screen.getByTestId('vitals-systolic'), { target: { value: '190' } });
    await waitFor(() => {
      expect(screen.getAllByTestId('flag-critical').length).toBeGreaterThan(0);
    });
  });

  /**
   * The vitals nurse does not hold `vitals.configure`, so this is the *normal*
   * case rather than an edge one. Nothing is coloured, the screen says why, and
   * — critically — nothing reads as normal.
   */
  it('scores nothing at all when this login cannot read the bands', async () => {
    render(
      <Harness permissions={VITALS_NURSE}>
        <VitalsRoomScreen />
      </Harness>,
    );
    openPatient();
    await screen.findByTestId('vitals-entry-pad');

    fireEvent.change(screen.getByTestId('vitals-systolic'), { target: { value: '190' } });

    expect(listReferenceRanges).not.toHaveBeenCalled();
    expect(screen.getByTestId('bands-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('flag-critical')).toBeNull();
    expect(screen.queryByTestId('flag-normal')).toBeNull();
    expect(screen.getAllByTestId('flag-not-scored').length).toBeGreaterThan(0);
  });

  it('refuses a diastolic that is not below the systolic, before the round trip', async () => {
    render(
      <Harness permissions={NURSE_WITH_BANDS}>
        <VitalsRoomScreen />
      </Harness>,
    );
    openPatient();
    await screen.findByTestId('vitals-entry-pad');

    fireEvent.change(screen.getByTestId('vitals-systolic'), { target: { value: '80' } });
    fireEvent.change(screen.getByTestId('vitals-diastolic'), { target: { value: '95' } });

    expect(screen.getByTestId('vitals-problems').textContent).toMatch(/lower than systolic/iu);
    expect(screen.getByTestId('vitals-save')).toBeDisabled();
    expect(recordVitals).not.toHaveBeenCalled();
  });
});

describe('a saved reading', () => {
  it('shows the server’s verdict rather than the one the browser guessed', async () => {
    // The client's band would call 150 abnormal; the server says critical. The
    // server is the one that raised the alert, so the server is what is shown.
    recordVitals.mockResolvedValue(
      savedRecord({ systolic: 150, flags: { systolic: 'critical' }, overall_flag: 'critical' }),
    );

    render(
      <Harness permissions={NURSE_WITH_BANDS}>
        <VitalsRoomScreen />
      </Harness>,
    );
    openPatient();
    await screen.findByTestId('vitals-entry-pad');
    fireEvent.change(screen.getByTestId('vitals-systolic'), { target: { value: '150' } });
    fireEvent.click(screen.getByTestId('vitals-save'));

    const saved = await screen.findByTestId('saved-observation');
    expect(within(saved).getByTestId('flag-critical')).toHaveTextContent('Systolic BP 150 mmHg');
  });

  it('shows the NEWS2 the server scored, and never recomputes it', async () => {
    render(
      <Harness permissions={NURSE_WITH_BANDS}>
        <VitalsRoomScreen />
      </Harness>,
    );
    openPatient();
    await screen.findByTestId('vitals-entry-pad');
    fireEvent.change(screen.getByTestId('vitals-systolic'), { target: { value: '190' } });
    fireEvent.click(screen.getByTestId('vitals-save'));

    // The screen now renders the design system's `EwsBadge` (docs/06 §5.2 #5)
    // rather than a local chip, so the query is by role and the assertion covers
    // the part §5.2 makes non-optional: the score is never shown without the
    // action it obliges.
    const badge = await screen.findByRole('group', { name: /NEWS2 6/ });
    expect(badge).toHaveTextContent('NEWS2');
    expect(badge).toHaveTextContent('6');
    expect(badge).toHaveAccessibleName(/medium risk/);
    expect(badge).toHaveAccessibleName(/Urgent review by a clinician competent in acute illness/);
  });
});

describe('a critical reading', () => {
  async function saveCritical(permissions: readonly string[]): Promise<void> {
    render(
      <Harness permissions={permissions}>
        <VitalsRoomScreen />
      </Harness>,
    );
    openPatient();
    await screen.findByTestId('vitals-entry-pad');
    fireEvent.change(screen.getByTestId('vitals-systolic'), { target: { value: '190' } });
    fireEvent.click(screen.getByTestId('vitals-save'));
    await screen.findByTestId('critical-action-prompt');
  }

  it('raises a prompt that cannot be dismissed', async () => {
    await saveCritical(NURSE_WITH_BANDS);
    const prompt = screen.getByTestId('critical-action-prompt');

    expect(prompt).toHaveAttribute('role', 'alert');
    expect(prompt.textContent).toMatch(/systolic/iu);
    for (const button of within(prompt).queryAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(/dismiss|close|later|ignore|ok\b/iu);
    }
  });

  it('leaves the acknowledgement to the doctor, and says so to the nurse', async () => {
    await saveCritical(NURSE_WITH_BANDS);
    const prompt = screen.getByTestId('critical-action-prompt');

    expect(within(prompt).queryByTestId('critical-acknowledge')).toBeNull();
    expect(within(prompt).getByTestId('required-permission')).toHaveTextContent('vitals.alert.acknowledge');
  });

  it('offers the acknowledgement to a session that holds the doctor’s key', async () => {
    acknowledgeVitalsAlert.mockResolvedValue({
      id: 'alert-v1',
      level: 'critical',
      parameters: ['systolic'],
      notified_doctor_id: 'doc-1',
      acknowledged_at: '2026-08-22T09:10:00.000Z',
      acknowledged_by: 'doc-1',
      action_taken: 'doctor_informed',
      note: null,
    });

    await saveCritical([...NURSE_WITH_BANDS, 'vitals.alert.acknowledge']);
    fireEvent.click(screen.getByTestId('critical-acknowledge'));

    await waitFor(() => {
      expect(acknowledgeVitalsAlert).toHaveBeenCalledWith(
        'vit-1',
        'alert-v1',
        expect.objectContaining({ actionTaken: 'doctor_informed' }),
      );
    });
  });
});

describe('before a patient is chosen', () => {
  it('asks for one rather than reading anything', () => {
    render(
      <Harness permissions={NURSE_WITH_BANDS}>
        <VitalsRoomScreen />
      </Harness>,
    );
    expect(screen.getByText(/No patient chosen yet/iu)).toBeInTheDocument();
    expect(getPatient).not.toHaveBeenCalled();
    expect(listVitals).not.toHaveBeenCalled();
  });
});
