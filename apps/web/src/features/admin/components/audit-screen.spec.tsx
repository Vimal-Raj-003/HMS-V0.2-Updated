import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '@/lib/api';
import { SessionProvider } from '@/lib/session-context';
import type { AuditFilters, AuditRow, Page } from '../api/types';
import { AuditScreen, describeFilters, normalise } from './audit-screen';

/**
 * The audit viewer as an investigation uses it.
 *
 * The three things asserted are the three that decide whether an investigation is
 * possible at all: that a filter reaches the *server* rather than trimming a page
 * that was already fetched, that the cursor carries forward so the answer beyond
 * page one is reachable, and that a row shows what actually changed.
 *
 * The fourth is that nothing on the screen can write. There is no update path on
 * the API, and the test below asserts the UI grows none.
 */

const searchAudit = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ searchAudit }));

function auditRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: '0192f0e2-0000-7000-8000-000000000001',
    occurred_at: '2026-08-18T08:37:00.000Z',
    actor_user_id: '0192f0e2-0000-7000-8000-0000000000aa',
    actor_role: 'hospital_admin',
    impersonator_user_id: null,
    entity: 'core.roles',
    row_id: null,
    business_key: 'ward_pharmacist',
    action: 'config_change',
    patient_id: null,
    data_class: 'operational',
    sensitivity: 'normal',
    result: 'success',
    denial_reason: null,
    reason_code: null,
    reason_text: 'Pharmacy restructure',
    before: { name: 'Ward pharmacist' },
    after: { name: 'Ward pharmacist (day)' },
    changed_fields: ['name'],
    row_count: 1,
    trace_id: '0192f0e2-aaaa-7000-8000-000000000001',
    api_route: 'PATCH /api/v1/admin/roles/:id',
    sealed_at: '2026-08-18T09:00:00.000Z',
    ...overrides,
  };
}

function page(items: readonly AuditRow[], nextCursor: string | null): Page<AuditRow> {
  return { items, nextCursor, hasMore: nextCursor !== null };
}

function Wrapper({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <SessionProvider
        session={{
          userId: 'u1',
          displayName: 'A. Admin',
          hospitalId: 'h1',
          branchId: 'b1',
          roles: ['hospital_admin'],
          permissions: ['admin.audit.read'],
          enabledModules: [],
        }}
      >
        {children}
      </SessionProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  searchAudit.mockReset();
});

describe('loading the log', () => {
  it('shows the newest rows with actor, action, entity and result', async () => {
    searchAudit.mockResolvedValue(page([auditRow()], null));
    render(<AuditScreen />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getAllByTestId('audit-row')).toHaveLength(1);
    });
    const row = within(screen.getAllByTestId('audit-row')[0] as HTMLElement);
    expect(row.getByText('core.roles')).toBeInTheDocument();
    expect(row.getByText('config_change')).toBeInTheDocument();
    expect(row.getByText('hospital_admin')).toBeInTheDocument();
    // Hospital time, not the browser's: 08:37 UTC is 14:07 in Asia/Kolkata.
    expect(row.getByText('18-08-2026 14:07')).toBeInTheDocument();
  });

  it('marks a refusal distinctly, and never by colour alone', async () => {
    searchAudit.mockResolvedValue(
      page([auditRow({ result: 'denied', denial_reason: 'reason_required' })], null),
    );
    render(<AuditScreen />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('denied')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('audit-row')[0]).toHaveAttribute('data-critical', 'true');
  });

  it('offers an empty state that says a search found nothing, not that nothing happened', async () => {
    searchAudit.mockResolvedValue(page([], null));
    render(<AuditScreen />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('No audit row matches these filters.')).toBeInTheDocument();
    });
    expect(screen.getByText(/the log is never empty/)).toBeInTheDocument();
  });

  it('renders a failure with its problem+json reference for the helpdesk', async () => {
    searchAudit.mockRejectedValue(
      new ApiProblem(
        {
          type: 'https://errors.vimshms.com/permission-denied',
          title: 'You do not have permission to do this',
          status: 403,
          detail: 'Reading the audit trail needs admin.audit.read.',
          reference: 'trace-4471',
        },
        403,
      ),
    );
    render(<AuditScreen />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('problem-card')).toBeInTheDocument();
    });
    expect(screen.getByTestId('problem-reference')).toHaveTextContent('trace-4471');
    expect(screen.getByText('Reading the audit trail needs admin.audit.read.')).toBeInTheDocument();
  });
});

describe('filtering', () => {
  it('sends the filters to the server rather than trimming the page it already has', async () => {
    searchAudit.mockResolvedValue(page([auditRow()], null));
    render(<AuditScreen />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(searchAudit).toHaveBeenCalledTimes(1);
    });
    expect(searchAudit.mock.calls[0]?.[0]).toEqual({});

    fireEvent.change(screen.getByLabelText('Entity'), { target: { value: '  core.roles  ' } });
    fireEvent.click(screen.getByTestId('audit-apply'));

    await waitFor(() => {
      expect(searchAudit).toHaveBeenCalledTimes(2);
    });
    // Trimmed, and the untouched fields are absent rather than sent empty — the
    // API rejects an empty uuid outright.
    expect(searchAudit.mock.calls[1]?.[0]).toEqual({ entity: 'core.roles' });
  });

  it('sends the boolean filters only when they are on', async () => {
    searchAudit.mockResolvedValue(page([auditRow()], null));
    render(<AuditScreen />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(searchAudit).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByLabelText('Refusals only'));
    fireEvent.click(screen.getByTestId('audit-apply'));
    await waitFor(() => {
      expect(searchAudit).toHaveBeenCalledTimes(2);
    });
    expect(searchAudit.mock.calls[1]?.[0]).toEqual({ deniedOnly: true });
  });

  it('shows the applied filters as chips so the result set is never a mystery', async () => {
    searchAudit.mockResolvedValue(page([auditRow()], null));
    render(<AuditScreen />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(searchAudit).toHaveBeenCalled();
    });

    fireEvent.change(screen.getByLabelText('Business key'), { target: { value: 'ward_pharmacist' } });
    fireEvent.click(screen.getByTestId('audit-apply'));

    await waitFor(() => {
      expect(screen.getByTestId('audit-chips')).toHaveTextContent('key ward_pharmacist');
    });
  });

  it('drops every filter when cleared', async () => {
    searchAudit.mockResolvedValue(page([auditRow()], null));
    render(<AuditScreen />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(searchAudit).toHaveBeenCalled();
    });

    fireEvent.change(screen.getByLabelText('Entity'), { target: { value: 'core.roles' } });
    fireEvent.click(screen.getByTestId('audit-apply'));
    await waitFor(() => {
      expect(screen.getByTestId('audit-chips')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => {
      expect(screen.queryByTestId('audit-chips')).not.toBeInTheDocument();
    });
  });
});

describe('pagination', () => {
  it('carries the cursor forward and appends the next page', async () => {
    searchAudit
      .mockResolvedValueOnce(page([auditRow({ id: 'row-1' })], 'cursor-1'))
      .mockResolvedValueOnce(page([auditRow({ id: 'row-2' })], null));

    render(<AuditScreen />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByTestId('audit-count')).toHaveTextContent('1 row loaded — more available');
    });

    fireEvent.click(screen.getByTestId('audit-load-more'));
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-row')).toHaveLength(2);
    });
    expect(searchAudit.mock.calls[1]?.[1]).toBe('cursor-1');
    expect(screen.getByTestId('audit-count')).toHaveTextContent('end of the log');
  });

  it('disables "load more" once the cursor is exhausted', async () => {
    searchAudit.mockResolvedValue(page([auditRow()], null));
    render(<AuditScreen />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getByTestId('audit-load-more')).toBeDisabled();
    });
  });
});

describe('the before-and-after diff', () => {
  it('is hidden until the row is expanded, then shows old struck and new emphasised', async () => {
    searchAudit.mockResolvedValue(page([auditRow()], null));
    render(<AuditScreen />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-row')).toHaveLength(1);
    });

    expect(screen.queryByText('Ward pharmacist (day)')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Show the before and after values/ }));

    const before = await screen.findByText('Ward pharmacist');
    expect(before.tagName).toBe('DEL');
    expect(screen.getByText('Ward pharmacist (day)').tagName).toBe('INS');
    expect(screen.getByText(/Pharmacy restructure/)).toBeInTheDocument();
    expect(screen.getByText('Sealed in the hash chain')).toBeInTheDocument();
  });

  it('shows the trace and the route under their own names, not disguised as a device', async () => {
    searchAudit.mockResolvedValue(page([auditRow()], null));
    render(<AuditScreen />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-row')).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole('button', { name: /Show the before and after values/ }));

    expect(await screen.findByText('PATCH /api/v1/admin/roles/:id')).toBeInTheDocument();
    expect(screen.getByText('Trace')).toBeInTheDocument();
  });
});

describe('read-only by construction', () => {
  it('renders no control that could change a row', async () => {
    searchAudit.mockResolvedValue(page([auditRow()], null));
    render(<AuditScreen />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-row')).toHaveLength(1);
    });

    const forbidden = /edit|delete|remove|amend|redact|correct/i;
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(forbidden);
    }
    expect(screen.getByText('Read-only by construction')).toBeInTheDocument();
  });
});

describe('filter normalisation', () => {
  it('drops blanks, trims values and keeps only the booleans that are on', () => {
    const raw: AuditFilters = {
      entity: '  core.roles ',
      q: '   ',
      deniedOnly: false,
      breakGlassOnly: true,
      userId: undefined,
    };
    expect(normalise(raw)).toEqual({ entity: 'core.roles', breakGlassOnly: true });
  });

  it('describes each applied filter in words for the chip row', () => {
    expect(describeFilters({ entity: 'core.roles', deniedOnly: true })).toEqual([
      'entity core.roles',
      'refusals only',
    ]);
  });
});
