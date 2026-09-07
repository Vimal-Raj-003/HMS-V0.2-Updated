import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider, TooltipProvider } from '@vims/ui';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '@/lib/api';
import { SessionProvider, type WorkspaceSession } from '@/lib/session-context';
import { readOutbox } from '../lib/offline';
import type { EncounterDetail, NoteHistory } from '../api/types';
import { DoctorConsoleScreen } from './doctor-console-screen';

/**
 * The consultation.
 *
 * Under test: a signed note is amended rather than edited, a lost race is shown
 * rather than absorbed, and a save with no network is *held* rather than
 * reported as saved.
 */

const getEncounter = vi.hoisted(() => vi.fn());
const updateEncounter = vi.hoisted(() => vi.fn());
const completeEncounter = vi.hoisted(() => vi.fn());
const amendEncounter = vi.hoisted(() => vi.fn());
const recordDiagnoses = vi.hoisted(() => vi.fn());
const getNoteVersions = vi.hoisted(() => vi.fn());
const getTimeline = vi.hoisted(() => vi.fn());
const getProblems = vi.hoisted(() => vi.fn());
const getMedications = vi.hoisted(() => vi.fn());
const getAllergies = vi.hoisted(() => vi.fn());
const listAlerts = vi.hoisted(() => vi.fn());
const respondToAlert = vi.hoisted(() => vi.fn());
const getPatient = vi.hoisted(() => vi.fn());

vi.mock('../api/client', () => ({
  getEncounter,
  updateEncounter,
  completeEncounter,
  amendEncounter,
  recordDiagnoses,
  getNoteVersions,
  getTimeline,
  getProblems,
  getMedications,
  getAllergies,
  listAlerts,
  respondToAlert,
}));

vi.mock('@/features/patient/api/client', () => ({ getPatient }));

const HOSPITAL = '0192f0e2-0000-7000-8000-000000000011';
const ENCOUNTER = '0192f0e2-0000-7000-8000-0000000000e1';
const PATIENT = '0192f0e2-0000-7000-8000-0000000000a1';

const DOCTOR = [
  'opd.encounter.read',
  'opd.encounter.update',
  'opd.encounter.sign',
  'opd.encounter.amend',
  'opd.diagnosis.update',
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

function encounter(overrides: Partial<EncounterDetail> = {}): EncounterDetail {
  return {
    id: ENCOUNTER,
    patient_id: PATIENT,
    visit_id: 'vis-1',
    practitioner_key: null,
    doctor_user_id: 'user-doctor',
    department_key: null,
    type: 'opd',
    status: 'in_progress',
    started_at: '2026-08-22T09:00:00.000Z',
    completed_at: null,
    cancelled_at: null,
    cancel_reason: null,
    active_seconds: 60,
    chief_complaint_text: 'Cough for three days',
    chief_complaint_codes: [],
    treatment_plan: 'Rest and fluids',
    advice: null,
    follow_up_date: null,
    no_diagnosis_reason: null,
    dosing_weight_kg: null,
    dosing_weight_source: 'unknown',
    dosing_weight_at: null,
    dosing_weight_by: null,
    dosing_weight_vitals_id: null,
    cosign_required: false,
    signed_document_id: null,
    version: 4,
    diagnoses: [],
    note: {},
    note_document_id: null,
    note_version: null,
    note_status: 'draft',
    break_glass: false,
    ...overrides,
  };
}

function noteHistory(): NoteHistory {
  return {
    documentId: 'doc-1',
    chain: {
      valid: true,
      versions: [
        { version: 2, status: 'amended', hash_matches: true, link_matches: true },
        { version: 1, status: 'superseded', hash_matches: true, link_matches: true },
      ],
    },
    versions: [
      {
        version: 2,
        status: 'amended',
        content: { plan: 'Azithromycin 500 mg OD' },
        content_text: null,
        content_sha256: 'bbbb2222bbbb2222',
        prev_sha256: 'aaaa1111aaaa1111',
        signed_by: 'user-doctor',
        signed_at: '2026-08-22T10:00:00.000Z',
        sign_method: 'system',
        signer_registration_no: 'NMC-1234',
        amendment_reason: 'Culture came back resistant to amoxicillin.',
        superseded_by_version: null,
        superseded_at: null,
        created_at: '2026-08-22T10:00:00.000Z',
        created_by: 'user-doctor',
      },
      {
        version: 1,
        status: 'superseded',
        content: { plan: 'Amoxicillin 500 mg TDS' },
        content_text: null,
        content_sha256: 'aaaa1111aaaa1111',
        prev_sha256: null,
        signed_by: 'user-doctor',
        signed_at: '2026-08-22T09:30:00.000Z',
        sign_method: 'system',
        signer_registration_no: 'NMC-1234',
        amendment_reason: null,
        superseded_by_version: 2,
        superseded_at: '2026-08-22T10:00:00.000Z',
        created_at: '2026-08-22T09:30:00.000Z',
        created_by: 'user-doctor',
      },
    ],
  };
}

function patientRecord(): unknown {
  return {
    id: PATIENT,
    uhid: 'VH-000123',
    full_name: 'Radha Sharma',
    gender: 'female',
    dob: '1988-04-02',
    allergy_statement: 'none_known',
    allergy_asserted_by: 'Sister Rani',
    allergy_asserted_at: '2026-08-01T09:00:00.000Z',
    allergy_unable_reason: null,
    payer_type: 'self',
    banner: {
      uhid: 'VH-000123',
      full_name: 'Radha Sharma',
      gender: 'female',
      age_display: '38 y',
      blood_group: 'unknown',
      photo_file_id: null,
      allergy_statement: 'none_known',
      allergy_asserted_at: '2026-08-01T09:00:00.000Z',
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

function open(): void {
  fireEvent.change(screen.getByTestId('console-encounter'), { target: { value: ENCOUNTER } });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  getEncounter.mockResolvedValue(encounter());
  getTimeline.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
  getProblems.mockResolvedValue([]);
  getMedications.mockResolvedValue([]);
  getAllergies.mockResolvedValue([]);
  listAlerts.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
  getNoteVersions.mockResolvedValue(noteHistory());
  getPatient.mockResolvedValue(patientRecord());
});

afterEach(() => {
  window.localStorage.clear();
});

describe('a draft consultation', () => {
  it('opens the note for editing with what the server holds', async () => {
    render(
      <Harness permissions={DOCTOR}>
        <DoctorConsoleScreen />
      </Harness>,
    );
    open();

    const field = await screen.findByTestId('note-field-chiefComplaint');
    expect(field).toHaveValue('Cough for three days');
  });

  it('saves on demand and reports the save only once the server answered', async () => {
    updateEncounter.mockResolvedValue(encounter({ version: 5, chief_complaint_text: 'Cough, four days' }));

    render(
      <Harness permissions={DOCTOR}>
        <DoctorConsoleScreen />
      </Harness>,
    );
    open();
    const field = await screen.findByTestId('note-field-chiefComplaint');
    fireEvent.change(field, { target: { value: 'Cough, four days' } });

    fireEvent.keyDown(document, { key: 's', ctrlKey: true });

    await waitFor(() => {
      expect(updateEncounter).toHaveBeenCalledWith(
        ENCOUNTER,
        expect.objectContaining({ version: 4, chiefComplaintText: 'Cough, four days' }),
      );
    });
    expect(await screen.findByTestId('autosave-saved')).toBeInTheDocument();
  });
});

describe('a signed consultation', () => {
  it('is read-only — there is no field to type into', async () => {
    getEncounter.mockResolvedValue(encounter({ status: 'completed', signed_document_id: 'doc-1' }));

    render(
      <Harness permissions={DOCTOR}>
        <DoctorConsoleScreen />
      </Harness>,
    );
    open();

    await screen.findByTestId('note-readonly');
    expect(screen.queryByTestId('note-field-chiefComplaint')).toBeNull();
    expect(screen.getByTestId('note-readonly').textContent).toMatch(/amendment creates a new version/iu);
  });

  it('amends with a reason, and never edits in place', async () => {
    getEncounter.mockResolvedValue(encounter({ status: 'completed', signed_document_id: 'doc-1' }));
    amendEncounter.mockResolvedValue(encounter({ status: 'amended', version: 5 }));

    render(
      <Harness permissions={DOCTOR}>
        <DoctorConsoleScreen />
      </Harness>,
    );
    open();

    fireEvent.click(await screen.findByTestId('amend-open'));
    // The note is a tab strip and Radix mounts only the open panel, so the
    // section being amended is opened first — which is what a doctor does too.
    // `mouseDown` rather than `click`: that is the event Radix's trigger acts on.
    fireEvent.mouseDown(await screen.findByTestId('note-tab-plan'));
    const field = await screen.findByTestId('note-field-plan');
    fireEvent.change(field, { target: { value: 'Azithromycin 500 mg OD' } });

    fireEvent.click(screen.getByTestId('amend-save'));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Culture came back resistant to amoxicillin.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /create the amended version/iu }));

    await waitFor(() => {
      expect(amendEncounter).toHaveBeenCalledWith(
        ENCOUNTER,
        expect.objectContaining({
          reason: 'Culture came back resistant to amoxicillin.',
          note: expect.objectContaining({ plan: 'Azithromycin 500 mg OD' }) as unknown,
        }),
      );
    });
    expect(updateEncounter).not.toHaveBeenCalled();
  });

  it('shows both versions and the reason, with the chain verified', async () => {
    getEncounter.mockResolvedValue(encounter({ status: 'amended', signed_document_id: 'doc-1' }));

    render(
      <Harness permissions={DOCTOR}>
        <DoctorConsoleScreen />
      </Harness>,
    );
    open();

    await screen.findByTestId('note-versions');
    expect(screen.getByTestId('chain-valid')).toBeInTheDocument();
    expect(screen.getByTestId('note-version-1')).toBeInTheDocument();
    expect(screen.getByTestId('note-version-2')).toBeInTheDocument();
    expect(screen.getByTestId('amendment-reason')).toHaveTextContent('resistant to amoxicillin');
    expect(screen.getByTestId('version-before-plan')).toHaveTextContent('Amoxicillin 500 mg TDS');
    expect(screen.getByTestId('version-after-plan')).toHaveTextContent('Azithromycin 500 mg OD');
  });

  it('offers no amendment to a session without the key', async () => {
    getEncounter.mockResolvedValue(encounter({ status: 'completed', signed_document_id: 'doc-1' }));

    render(
      <Harness permissions={['opd.encounter.read', 'patient.record.read']}>
        <DoctorConsoleScreen />
      </Harness>,
    );
    open();

    await screen.findByTestId('note-readonly');
    expect(screen.queryByTestId('amend-open')).toBeNull();
  });
});

describe('when somebody else saved first', () => {
  it('shows both texts and overwrites neither', async () => {
    updateEncounter.mockRejectedValue(
      new ApiProblem(
        {
          type: 'https://errors.vimshms.com/optimistic-lock-conflict',
          title: 'Someone else saved this record first',
          status: 409,
          reference: 'trace-conflict',
        },
        409,
      ),
    );

    render(
      <Harness permissions={DOCTOR}>
        <DoctorConsoleScreen />
      </Harness>,
    );
    open();
    const field = await screen.findByTestId('note-field-chiefComplaint');
    fireEvent.change(field, { target: { value: 'Cough, four days, now with fever' } });
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });

    const conflict = await screen.findByTestId('note-conflict');
    expect(within(conflict).getByTestId('conflict-mine-chiefComplaint')).toHaveTextContent(
      'Cough, four days, now with fever',
    );
    expect(within(conflict).getByTestId('conflict-theirs-chiefComplaint')).toHaveTextContent(
      'Cough for three days',
    );
    // The doctor's text is still in the editor: nothing was discarded.
    expect(screen.getByTestId('note-field-chiefComplaint')).toHaveValue('Cough, four days, now with fever');
  });
});

describe('with no network', () => {
  it('holds the draft on the device and never claims it saved', async () => {
    updateEncounter.mockRejectedValue(new TypeError('Failed to fetch'));

    render(
      <Harness permissions={DOCTOR}>
        <DoctorConsoleScreen />
      </Harness>,
    );
    open();
    fireEvent.mouseDown(await screen.findByTestId('note-tab-plan'));
    const field = await screen.findByTestId('note-field-plan');
    fireEvent.change(field, { target: { value: 'Amoxicillin 500 mg TDS for five days' } });
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });

    const badge = await screen.findByTestId('autosave-queued');
    expect(badge).toHaveTextContent(/not on the server/iu);
    expect(screen.queryByTestId('autosave-saved')).toBeNull();

    const queued = readOutbox({ hospitalId: HOSPITAL, userId: 'user-doctor' });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.draft.plan).toBe('Amoxicillin 500 mg TDS for five days');
    expect(queued[0]?.baseVersion).toBe(4);
  });

  it('restores the held draft when the consultation is reopened', async () => {
    updateEncounter.mockRejectedValue(new TypeError('Failed to fetch'));

    const { unmount } = render(
      <Harness permissions={DOCTOR}>
        <DoctorConsoleScreen />
      </Harness>,
    );
    open();
    fireEvent.mouseDown(await screen.findByTestId('note-tab-plan'));
    fireEvent.change(await screen.findByTestId('note-field-plan'), {
      target: { value: 'Held offline' },
    });
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    await screen.findByTestId('autosave-queued');
    unmount();

    render(
      <Harness permissions={DOCTOR}>
        <DoctorConsoleScreen />
      </Harness>,
    );
    open();
    fireEvent.mouseDown(await screen.findByTestId('note-tab-plan'));
    expect(await screen.findByTestId('note-field-plan')).toHaveValue('Held offline');
  });
});

describe('before a consultation is opened', () => {
  it('reads nothing', () => {
    render(
      <Harness permissions={DOCTOR}>
        <DoctorConsoleScreen />
      </Harness>,
    );
    expect(screen.getByText(/No consultation opened/iu)).toBeInTheDocument();
    expect(getEncounter).not.toHaveBeenCalled();
  });
});
