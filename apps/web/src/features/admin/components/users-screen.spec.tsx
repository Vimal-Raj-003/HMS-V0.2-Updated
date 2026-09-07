import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@vims/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '@/lib/session-context';
import type { Page, UserDetail, UserListItem } from '../api/types';
import { UsersScreen } from './users-screen';

/**
 * The users worklist, and in particular the friction in front of a deactivation.
 *
 * `docs/06` §6.9 puts deactivating a staff account at friction level 5 — confirm,
 * plus a reason, plus typing a distinguishing value — because it signs the person
 * out of every device mid-shift and cannot be undone by pressing back. The tests
 * below are the ones that would fail if that friction were ever relaxed by
 * accident.
 */

const client = vi.hoisted(() => ({
  listUsers: vi.fn(),
  getUser: vi.fn(),
  listRoles: vi.fn(),
  deactivateUser: vi.fn(),
  resetUserPassword: vi.fn(),
  createUser: vi.fn(),
  revokeRole: vi.fn(),
}));
vi.mock('../api/client', () => client);

const LIST_ITEM: UserListItem = {
  id: 'u1',
  username: 'r.sharma',
  display_name: 'SHARMA, Ramesh',
  email: 'r.sharma@example.org',
  employee_id: 'E-4471',
  type: 'staff',
  status: 'active',
  mfa_enabled: true,
  last_login_at: '2026-08-18T08:37:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
  version: 1,
};

const DETAIL: UserDetail = {
  ...LIST_ITEM,
  mobile: null,
  name: { family: 'Sharma', given: 'Ramesh' },
  professional: null,
  preferences: null,
  must_change_password: false,
  deactivated_at: null,
  deactivation_reason: null,
  roles: [
    {
      id: 'ur1',
      role_id: 'r1',
      role_key: 'ward_pharmacist',
      role_name: 'Ward pharmacist',
      branch_id: null,
      scope: {},
      conditions: {},
      valid_from: '2026-01-01T00:00:00.000Z',
      valid_to: null,
      active: true,
    },
  ],
};

function page(items: readonly UserListItem[]): Page<UserListItem> {
  return { items, nextCursor: null, hasMore: false };
}

const ALL_PERMISSIONS = [
  'admin.user.read',
  'admin.user.create',
  'admin.user.update',
  'admin.user.deactivate',
  'admin.user.reset',
  'admin.role.assign',
];

function wrapperWith(permissions: readonly string[]) {
  return function Wrapper({ children }: { readonly children: ReactNode }): React.JSX.Element {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={queryClient}>
        <SessionProvider
          session={{
            userId: 'me',
            displayName: 'A. Admin',
            hospitalId: 'h1',
            branchId: 'b1',
            roles: ['hospital_admin'],
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

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.listUsers.mockResolvedValue(page([LIST_ITEM]));
  client.getUser.mockResolvedValue(DETAIL);
  client.listRoles.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
  client.deactivateUser.mockResolvedValue({ sessionsRevoked: 3 });
});

async function openTheAccount(): Promise<void> {
  await waitFor(() => {
    expect(screen.getAllByTestId('user-row')).toHaveLength(1);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /Deactivate/ })).toBeInTheDocument();
  });
}

describe('the worklist', () => {
  it('lists accounts with the status and 2FA state an administrator triages on', async () => {
    render(<UsersScreen />, { wrapper: wrapperWith(ALL_PERMISSIONS) });
    await waitFor(() => {
      expect(screen.getByText('SHARMA, Ramesh')).toBeInTheDocument();
    });
    const row = within(screen.getAllByTestId('user-row')[0] as HTMLElement);
    expect(row.getByText('active')).toBeInTheDocument();
    expect(row.getByText('Enrolled')).toBeInTheDocument();
    expect(row.getByText('r.sharma')).toBeInTheDocument();
  });

  it('sends the search to the server rather than filtering the page it holds', async () => {
    render(<UsersScreen />, { wrapper: wrapperWith(ALL_PERMISSIONS) });
    await waitFor(() => {
      expect(client.listUsers).toHaveBeenCalledTimes(1);
    });

    fireEvent.change(screen.getByTestId('user-search'), { target: { value: ' sharma ' } });
    fireEvent.click(screen.getByTestId('user-apply'));

    await waitFor(() => {
      expect(client.listUsers).toHaveBeenCalledTimes(2);
    });
    expect(client.listUsers.mock.calls[1]?.[0]).toEqual({ q: 'sharma' });
  });
});

describe('deactivating an account', () => {
  it('will not proceed on a blank reason, nor on whitespace', async () => {
    render(<UsersScreen />, { wrapper: wrapperWith(ALL_PERMISSIONS) });
    await openTheAccount();
    fireEvent.click(screen.getByTestId('deactivate-user'));

    const confirm = screen.getByRole('button', { name: 'Deactivate the account' });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: '    ' } });
    expect(confirm).toBeDisabled();

    fireEvent.click(confirm);
    expect(client.deactivateUser).not.toHaveBeenCalled();
  });

  it('additionally requires the username to be typed, and then sends the trimmed reason', async () => {
    render(<UsersScreen />, { wrapper: wrapperWith(ALL_PERMISSIONS) });
    await openTheAccount();
    fireEvent.click(screen.getByTestId('deactivate-user'));

    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: '  Left the hospital  ' } });
    const confirm = screen.getByRole('button', { name: 'Deactivate the account' });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Type the username r.sharma to confirm/), {
      target: { value: 'r.sharma' },
    });
    expect(confirm).toBeEnabled();

    fireEvent.click(confirm);
    await waitFor(() => {
      expect(client.deactivateUser).toHaveBeenCalledWith('u1', 'Left the hospital');
    });
  });

  it('says plainly that the account is kept rather than deleted', async () => {
    render(<UsersScreen />, { wrapper: wrapperWith(ALL_PERMISSIONS) });
    await openTheAccount();
    fireEvent.click(screen.getByTestId('deactivate-user'));
    expect(screen.getByText(/The account is kept, not deleted/)).toBeInTheDocument();
  });
});

describe('controls the session cannot use are not drawn at all', () => {
  it('offers no "New user" button without admin.user.create', async () => {
    render(<UsersScreen />, { wrapper: wrapperWith(['admin.user.read']) });
    await waitFor(() => {
      expect(screen.getAllByTestId('user-row')).toHaveLength(1);
    });
    expect(screen.queryByTestId('new-user')).not.toBeInTheDocument();
  });

  it('offers neither deactivate nor reset without their permissions', async () => {
    render(<UsersScreen />, { wrapper: wrapperWith(['admin.user.read']) });
    await waitFor(() => {
      expect(screen.getAllByTestId('user-row')).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => {
      expect(screen.getByText('Ward pharmacist')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('deactivate-user')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reset password/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('never offers to deactivate the account the administrator is signed in with', async () => {
    client.listUsers.mockResolvedValue(page([{ ...LIST_ITEM, id: 'me' }]));
    client.getUser.mockResolvedValue({ ...DETAIL, id: 'me' });

    render(<UsersScreen />, { wrapper: wrapperWith(ALL_PERMISSIONS) });
    await waitFor(() => {
      expect(screen.getAllByTestId('user-row')).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Reset password/ })).toBeInTheDocument();
    });
    expect(screen.queryByTestId('deactivate-user')).not.toBeInTheDocument();
  });
});

describe('resetting a password', () => {
  it('needs both a policy-length password and a reason before it can be sent', async () => {
    render(<UsersScreen />, { wrapper: wrapperWith(ALL_PERMISSIONS) });
    await openTheAccount();
    fireEvent.click(screen.getByRole('button', { name: /Reset password/ }));

    const submit = screen.getByTestId('reset-submit');
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Temporary password/), { target: { value: 'short' } });
    fireEvent.change(screen.getByTestId('reset-reason'), { target: { value: 'Locked out' } });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Temporary password/), {
      target: { value: 'a-long-enough-password' },
    });
    expect(submit).toBeEnabled();

    fireEvent.click(submit);
    await waitFor(() => {
      expect(client.resetUserPassword).toHaveBeenCalledWith('u1', 'a-long-enough-password', 'Locked out');
    });
  });
});
