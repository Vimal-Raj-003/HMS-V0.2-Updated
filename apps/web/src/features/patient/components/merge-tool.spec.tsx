import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@vims/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '@/lib/session-context';
import type { DedupeCandidateItem, MergePreview, MergeResult } from '../api/types';
import { patientFixture } from '../lib/__fixtures__/patient';
import { MergeTool } from './merge-tool';

/**
 * The merge tool.
 *
 * OP-001 §5 requires a **two-step confirm** and `docs/06` §6.9 puts a merge at
 * friction level 5 — confirm, reason, and a typed value. The tests below are the
 * ones that fail if either is quietly reduced to a single button:
 *
 *  - preparing must not merge anything;
 *  - committing must name the prepared merge rather than the two patients;
 *  - the impact must be on screen *before* the confirmation, not after;
 *  - the retiring UHID must be typed out by hand.
 */

const client = vi.hoisted(() => ({
  listDedupeCandidates: vi.fn(),
  getPatient: vi.fn(),
  prepareMerge: vi.fn(),
  commitMerge: vi.fn(),
  unmerge: vi.fn(),
  searchPatients: vi.fn(),
  listRecentPatients: vi.fn(),
}));
vi.mock('../api/client', () => client);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const SURVIVOR = patientFixture({
  id: 'survivor-1',
  uhid: 'UH-0001',
  full_name: 'SHARMA, Ramesh',
  mobile: '+919845012345',
  email: null,
});

const VICTIM = patientFixture({
  id: 'victim-1',
  uhid: 'UH-0002',
  full_name: 'SHARMA, Rameshh',
  mobile: '+919845099999',
  email: 'ramesh@example.org',
});

const PAIR: DedupeCandidateItem = {
  id: 'pair-1',
  patient_a_id: SURVIVOR.id,
  patient_a_uhid: SURVIVOR.uhid,
  patient_a_name: SURVIVOR.full_name,
  patient_b_id: VICTIM.id,
  patient_b_uhid: VICTIM.uhid,
  patient_b_name: VICTIM.full_name,
  score: '0.910',
  rule_hits: {},
  detected_by: 'registration',
  status: 'open',
  reviewed_by: null,
  reviewed_at: null,
  merge_id: null,
  created_at: '2026-08-21T05:00:00.000Z',
};

const PREVIEW: MergePreview = {
  mergeId: 'merge-1',
  status: 'prepared',
  survivorId: SURVIVOR.id,
  survivorUhid: SURVIVOR.uhid,
  victimId: VICTIM.id,
  victimUhid: VICTIM.uhid,
  reason: 'Same person, second record created at the ER counter',
  unmergeDeadline: '2026-09-21T05:00:00.000Z',
  impact: [
    { table: 'op_visits', rows: 3 },
    { table: 'patient_identifiers', rows: 0 },
  ],
};

const RESULT: MergeResult = {
  ...PREVIEW,
  status: 'merged',
  mergedAt: '2026-08-22T09:00:00.000Z',
  repointed: [{ table: 'op_visits', rows: 3 }],
};

const MRD = ['patient.merge.review', 'patient.merge.execute', 'patient.record.read', 'patient.record.list'];

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
            displayName: 'M. Records',
            hospitalId: 'h1',
            branchId: 'b1',
            roles: ['mrd_officer'],
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

async function pickThePair(): Promise<void> {
  const row = await screen.findByText(SURVIVOR.full_name);
  fireEvent.doubleClick(row.closest('tr') as HTMLElement);
  await screen.findByTestId('merge-comparison');
}

const GOOD_REASON = 'Same person, second record created at the ER counter with a misspelled surname';

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  router.push.mockReset();
  client.listDedupeCandidates.mockResolvedValue({ items: [PAIR], nextCursor: null, hasMore: false });
  client.listRecentPatients.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
  client.getPatient.mockImplementation((id: string) =>
    Promise.resolve(id === SURVIVOR.id ? SURVIVOR : VICTIM),
  );
  client.prepareMerge.mockResolvedValue(PREVIEW);
  client.commitMerge.mockResolvedValue(RESULT);
  client.unmerge.mockResolvedValue({
    mergeId: 'merge-1',
    survivorId: SURVIVOR.id,
    victimId: VICTIM.id,
    victimUhid: VICTIM.uhid,
    unmergedAt: '2026-08-22T10:00:00.000Z',
    restored: [{ table: 'op_visits', rows: 3 }],
  });
});

describe('the duplicate queue', () => {
  it('lists the flagged pairs with their match score', async () => {
    render(<MergeTool />, { wrapper: wrapperWith(MRD) });
    expect(await screen.findByText('91%')).toBeInTheDocument();
    expect(screen.getByText(SURVIVOR.full_name)).toBeInTheDocument();
    expect(screen.getByText(VICTIM.full_name)).toBeInTheDocument();
  });

  it('loads both records when a pair is opened', async () => {
    render(<MergeTool />, { wrapper: wrapperWith(MRD) });
    await pickThePair();
    expect(client.getPatient).toHaveBeenCalledWith(SURVIVOR.id, expect.anything());
    expect(client.getPatient).toHaveBeenCalledWith(VICTIM.id, expect.anything());
  });
});

describe('the comparison', () => {
  it('asks about the fields that differ and stays quiet about the ones that do not', async () => {
    render(<MergeTool />, { wrapper: wrapperWith(MRD) });
    await pickThePair();

    const comparison = screen.getByTestId('merge-comparison');
    expect(within(comparison).getByText('Mobile')).toBeInTheDocument();
    expect(within(comparison).getByText('Name')).toBeInTheDocument();
    // Identical on both records, so there is nothing to decide.
    expect(within(comparison).queryByText('Category')).not.toBeInTheDocument();
  });

  it('defaults a field only the retiring record has filled in to that record’s value', async () => {
    render(<MergeTool />, { wrapper: wrapperWith(MRD) });
    await pickThePair();

    const group = screen.getByRole('radiogroup', { name: 'Which Email to keep' });
    const chosen = within(group)
      .getAllByRole('radio')
      .find((radio) => radio.getAttribute('aria-checked') === 'true');
    // Defaulting to the survivor here would silently discard the hospital's only
    // copy of the email address.
    expect(chosen?.getAttribute('value')).toBe('victim');
  });
});

describe('the first of the two steps', () => {
  it('refuses to prepare without a reason', async () => {
    render(<MergeTool />, { wrapper: wrapperWith(MRD) });
    await pickThePair();
    expect(screen.getByTestId('merge-prepare')).toBeDisabled();

    fireEvent.change(screen.getByTestId('merge-reason'), { target: { value: 'dup' } });
    expect(screen.getByTestId('merge-prepare')).toBeDisabled();

    fireEvent.change(screen.getByTestId('merge-reason'), { target: { value: GOOD_REASON } });
    expect(screen.getByTestId('merge-prepare')).toBeEnabled();
  });

  it('prepares without committing, and shows what will move before anything does', async () => {
    render(<MergeTool />, { wrapper: wrapperWith(MRD) });
    await pickThePair();
    fireEvent.change(screen.getByTestId('merge-reason'), { target: { value: GOOD_REASON } });
    fireEvent.click(screen.getByTestId('merge-prepare'));

    const preview = await screen.findByTestId('merge-preview');
    expect(preview).toHaveTextContent('Nothing has changed yet');
    expect(within(preview).getByTestId('merge-impact')).toHaveTextContent('3 × Op visits');
    // The fan-out is named, because the officer is deciding for every module.
    expect(preview).toHaveTextContent('patient.merged');
    expect(client.commitMerge).not.toHaveBeenCalled();
  });

  it('sends the field choices with the preparation', async () => {
    render(<MergeTool />, { wrapper: wrapperWith(MRD) });
    await pickThePair();
    fireEvent.change(screen.getByTestId('merge-reason'), { target: { value: GOOD_REASON } });
    fireEvent.click(screen.getByTestId('merge-prepare'));

    await waitFor(() => {
      expect(client.prepareMerge).toHaveBeenCalledTimes(1);
    });
    const [body] = client.prepareMerge.mock.calls[0] as [Record<string, unknown>, string];
    expect(body).toMatchObject({
      survivorId: SURVIVOR.id,
      victimId: VICTIM.id,
      reason: GOOD_REASON,
    });
    expect(body['fieldChoices']).toMatchObject({ email: 'victim', mobile: 'survivor' });
  });
});

describe('the second of the two steps', () => {
  async function prepare(): Promise<void> {
    await pickThePair();
    fireEvent.change(screen.getByTestId('merge-reason'), { target: { value: GOOD_REASON } });
    fireEvent.click(screen.getByTestId('merge-prepare'));
    await screen.findByTestId('merge-preview');
  }

  it('needs the retiring UHID typed out before it will commit', async () => {
    render(<MergeTool />, { wrapper: wrapperWith(MRD) });
    await prepare();

    fireEvent.click(screen.getByTestId('merge-commit'));
    const confirm = await screen.findByRole('alertdialog');

    const button = within(confirm).getByRole('button', { name: 'Merge the records' });
    expect(button).toBeDisabled();

    const typed = within(confirm).getByLabelText(/Type the retiring UHID/i);
    fireEvent.change(typed, { target: { value: 'UH-000' } });
    fireEvent.change(within(confirm).getByLabelText(/^Reason/), { target: { value: GOOD_REASON } });
    expect(button).toBeDisabled();

    fireEvent.change(typed, { target: { value: VICTIM.uhid } });
    expect(button).toBeEnabled();
  });

  it('commits by naming the prepared merge, never the two patients again', async () => {
    render(<MergeTool />, { wrapper: wrapperWith(MRD) });
    await prepare();

    fireEvent.click(screen.getByTestId('merge-commit'));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.change(within(confirm).getByLabelText(/Type the retiring UHID/i), {
      target: { value: VICTIM.uhid },
    });
    fireEvent.change(within(confirm).getByLabelText(/^Reason/), { target: { value: GOOD_REASON } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Merge the records' }));

    await waitFor(() => {
      expect(client.commitMerge).toHaveBeenCalledTimes(1);
    });
    expect(client.commitMerge.mock.calls[0]?.[0]).toBe('merge-1');
  });

  it('says what moved and keeps the thirty-day reversal in reach', async () => {
    render(<MergeTool />, { wrapper: wrapperWith(MRD) });
    await prepare();

    fireEvent.click(screen.getByTestId('merge-commit'));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.change(within(confirm).getByLabelText(/Type the retiring UHID/i), {
      target: { value: VICTIM.uhid },
    });
    fireEvent.change(within(confirm).getByLabelText(/^Reason/), { target: { value: GOOD_REASON } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Merge the records' }));

    const result = await screen.findByTestId('merge-result');
    expect(result).toHaveTextContent('UH-0002');
    expect(result).toHaveTextContent('3 × Op visits moved');
    expect(within(result).getByTestId('merge-reverse')).toBeInTheDocument();
  });
});

describe('without the execute permission', () => {
  it('shows the queue and the comparison but names the key it is missing', async () => {
    render(<MergeTool />, {
      wrapper: wrapperWith(['patient.merge.review', 'patient.record.read', 'patient.record.list']),
    });
    await pickThePair();

    expect(screen.getByTestId('merge-not-permitted')).toHaveTextContent('patient.merge.execute');
    fireEvent.change(screen.getByTestId('merge-reason'), { target: { value: GOOD_REASON } });
    expect(screen.getByTestId('merge-prepare')).toBeDisabled();
  });
});

describe('records that must not be merged', () => {
  it('refuses a record that has already been merged, before the API is asked', async () => {
    client.getPatient.mockImplementation((id: string) =>
      Promise.resolve(
        id === SURVIVOR.id ? SURVIVOR : patientFixture({ ...VICTIM, merged_into_id: 'somebody-else' }),
      ),
    );
    render(<MergeTool />, { wrapper: wrapperWith(MRD) });
    await pickThePair();

    expect(screen.getByTestId('merge-refusals')).toHaveTextContent('already been merged');
    fireEvent.change(screen.getByTestId('merge-reason'), { target: { value: GOOD_REASON } });
    expect(screen.getByTestId('merge-prepare')).toBeDisabled();
  });
});
