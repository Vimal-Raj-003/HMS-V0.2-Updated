'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  ConfirmWithReasonDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from '@vims/ui';
import { KeyRound, UserPlus, UserSearch, UserX } from '@/lib/icons';
import { useMemo, useState } from 'react';
import { useSession } from '@/lib/session-context';
import {
  createUser,
  deactivateUser,
  getUser,
  listRoles,
  listUsers,
  resetUserPassword,
  revokeRole,
} from '../api/client';
import { adminKeys } from '../api/keys';
import type { UserFilters, UserListItem, UserStatus } from '../api/types';
import { formatCount, formatTimestamp } from '../lib/format';
import { AsyncPanel } from './async-panel';
import { PageHeader } from './page-header';
import { ProblemCard } from './problem-card';

/**
 * Users (EN-007 §3.2, §8 "Users").
 *
 * The worklist archetype from `docs/06` §9.A: filter bar with visible chips,
 * server-side cursor pagination, a row that opens a detail drawer rather than
 * navigating away, and destructive actions behind a reason.
 *
 * Two things this screen deliberately does **not** offer:
 *
 *  - **Delete.** `EN-007 §5` — deactivated users cannot be deleted; the audit
 *    identity has to stay resolvable. The API has no DELETE, and neither does the
 *    UI, so nobody looks for one.
 *  - **Assigning a sensitive role.** Those need two approvers (`EN-007 §5`) and
 *    the approval engine is not wired yet, so the API refuses them. The refusal
 *    is surfaced as the problem it is, rather than hidden behind a disabled
 *    control that would look like a bug.
 */

const STATUSES: readonly UserStatus[] = ['invited', 'active', 'locked', 'suspended', 'deactivated'];

const STATUS_TONE: Readonly<Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'>> = {
  active: 'success',
  invited: 'info',
  locked: 'danger',
  suspended: 'warning',
  deactivated: 'neutral',
};

export function UsersScreen(): React.JSX.Element {
  const { hospitalId, granted, userId } = useSession();
  const keys = adminKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const canCreate = granted.has('admin.user.create');
  const canDeactivate = granted.has('admin.user.deactivate');
  const canReset = granted.has('admin.user.reset');
  const canAssign = granted.has('admin.role.assign');

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<UserStatus | null>(null);
  const [applied, setApplied] = useState<UserFilters>({});
  const [openUserId, setOpenUserId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const list = useInfiniteQuery({
    queryKey: keys.users(applied),
    queryFn: ({ pageParam, signal }) => listUsers(applied, pageParam, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const rows = useMemo(() => (list.data?.pages ?? []).flatMap((page) => page.items), [list.data]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: [...keys.root, 'users'] });
    if (openUserId !== null) void queryClient.invalidateQueries({ queryKey: keys.user(openUserId) });
  };

  const deactivate = useMutation({
    mutationFn: (input: { readonly id: string; readonly reason: string }) =>
      deactivateUser(input.id, input.reason),
    onSuccess: (result) => {
      invalidate();
      publish({
        title: 'User deactivated',
        description: `${formatCount(result.sessionsRevoked)} session(s) were revoked immediately.`,
        severity: 'success',
      });
    },
  });

  const reset = useMutation({
    mutationFn: (input: { readonly id: string; readonly password: string; readonly reason: string }) =>
      resetUserPassword(input.id, input.password, input.reason),
    onSuccess: () => {
      invalidate();
      publish({
        title: 'Password reset',
        description: 'The user must choose a new password at their next sign-in.',
        severity: 'success',
      });
    },
  });

  const create = useMutation({
    mutationFn: createUser,
    onSuccess: (user) => {
      invalidate();
      setCreateOpen(false);
      setOpenUserId(user.id);
      publish({ title: `${user.display_name} created`, severity: 'success' });
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="EN-007"
        title="Users"
        description="Staff, partner and service accounts for this hospital. Accounts are never deleted — deactivation revokes every session at once and keeps the audit identity resolvable."
        primaryAction={
          canCreate ? (
            <Button
              variant="primary"
              data-testid="new-user"
              onClick={() => {
                setCreateOpen(true);
              }}
            >
              <UserPlus aria-hidden="true" />
              New user
            </Button>
          ) : undefined
        }
      />

      {deactivate.isError ? <ProblemCard error={deactivate.error} /> : null}
      {reset.isError ? <ProblemCard error={reset.error} /> : null}
      {create.isError ? <ProblemCard error={create.error} /> : null}

      <form
        aria-label="User filters"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-default bg-layer-1 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied({
            ...(search.trim() === '' ? {} : { q: search.trim() }),
            ...(status === null ? {} : { status }),
          });
        }}
      >
        <div className="min-w-60 flex-1">
          <Label htmlFor="user-search">Search</Label>
          <Input
            id="user-search"
            type="search"
            value={search}
            placeholder="name, username, email or employee ID"
            data-testid="user-search"
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="w-48">
          <Label htmlFor="user-status">Status</Label>
          <Select
            value={status ?? 'any'}
            onValueChange={(value) => {
              setStatus(value === 'any' ? null : (value as UserStatus));
            }}
          >
            <SelectTrigger id="user-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any status</SelectItem>
              {STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="secondary" type="submit" data-testid="user-apply">
          Apply
        </Button>
      </form>

      <AsyncPanel
        loading={list.isPending}
        error={list.error}
        isEmpty={rows.length === 0}
        onRetry={() => void list.refetch()}
        skeletonLabel="Loading users"
        skeletonRows={10}
        skeletonColumns={[3, 2, 2, 1, 1]}
        empty={
          <EmptyState
            icon={<UserSearch />}
            cause="No account matches these filters."
            nextAction="Clear the search, or create the account if this person is new."
            action={{
              label: 'Clear filters',
              onSelect: () => {
                setSearch('');
                setStatus(null);
                setApplied({});
              },
            }}
          />
        }
      >
        <div className="rounded-lg border border-default bg-layer-1">
          <Table scrollRegionLabel="Users">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Username</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>2FA</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((user) => (
                <TableRow key={user.id} data-testid="user-row">
                  <TableCell className="font-medium">{user.display_name}</TableCell>
                  <TableCell className="font-mono text-xs">{user.username}</TableCell>
                  <TableCell>
                    <Badge tone={STATUS_TONE[user.status] ?? 'neutral'} size="sm">
                      {user.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{user.mfa_enabled ? 'Enrolled' : 'Not enrolled'}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {formatTimestamp(user.last_login_at)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setOpenUserId(user.id);
                      }}
                    >
                      Open
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex items-center justify-between gap-2 border-t border-default p-3 text-sm">
            <span aria-live="polite">
              {formatCount(rows.length)} account{rows.length === 1 ? '' : 's'} loaded
            </span>
            <Button
              variant="secondary"
              size="sm"
              data-testid="users-load-more"
              disabled={!list.hasNextPage || list.isFetchingNextPage}
              aria-busy={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        </div>
      </AsyncPanel>

      {openUserId === null ? null : (
        <UserDetailDialog
          userId={openUserId}
          selfUserId={userId}
          onClose={() => {
            setOpenUserId(null);
          }}
          canDeactivate={canDeactivate}
          canReset={canReset}
          canAssign={canAssign}
          onDeactivate={(reason) => {
            deactivate.mutate({ id: openUserId, reason });
          }}
          onReset={(password, reason) => {
            reset.mutate({ id: openUserId, password, reason });
          }}
          onRevoked={invalidate}
        />
      )}

      {canCreate ? (
        <CreateUserDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          saving={create.isPending}
          onSubmit={(input) => {
            create.mutate(input);
          }}
        />
      ) : null}
    </div>
  );
}

// ── detail drawer ────────────────────────────────────────────────────────────

function UserDetailDialog({
  userId,
  selfUserId,
  onClose,
  canDeactivate,
  canReset,
  canAssign,
  onDeactivate,
  onReset,
  onRevoked,
}: {
  readonly userId: string;
  readonly selfUserId: string;
  readonly onClose: () => void;
  readonly canDeactivate: boolean;
  readonly canReset: boolean;
  readonly canAssign: boolean;
  readonly onDeactivate: (reason: string) => void;
  readonly onReset: (password: string, reason: string) => void;
  readonly onRevoked: () => void;
}): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = adminKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const detail = useQuery({
    queryKey: keys.user(userId),
    queryFn: ({ signal }) => getUser(userId, { signal }),
  });

  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);

  const revoke = useMutation({
    mutationFn: (input: { readonly userRoleId: string; readonly reason: string }) =>
      revokeRole(userId, input.userRoleId, input.reason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.user(userId) });
      onRevoked();
      publish({ title: 'Role revoked', severity: 'success' });
    },
  });

  const user = detail.data;
  // `EN-007` never lets an administrator deactivate the account they are signed
  // in with: it would revoke their own session mid-action and leave a
  // single-admin tenant locked out with no second admin to recover it.
  const isSelf = user?.id === selfUserId;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent closeLabel="Close" className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{user?.display_name ?? 'Account'}</DialogTitle>
          <DialogDescription>
            {user === undefined
              ? 'Loading the account…'
              : `${user.username} · ${user.type} · created ${formatTimestamp(user.created_at)}`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <AsyncPanel
            loading={detail.isPending}
            error={detail.error}
            isEmpty={false}
            empty={null}
            onRetry={() => void detail.refetch()}
            skeletonLabel="Loading the account"
            skeletonRows={5}
          >
            {user === undefined ? null : (
              <>
                {revoke.isError ? <ProblemCard error={revoke.error} /> : null}

                <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <Pair label="Status" value={user.status} />
                  <Pair label="Email" value={user.email} />
                  <Pair label="Mobile" value={user.mobile} />
                  <Pair label="Employee ID" value={user.employee_id} />
                  <Pair label="Two-factor" value={user.mfa_enabled ? 'Enrolled' : 'Not enrolled'} />
                  <Pair label="Last sign-in" value={formatTimestamp(user.last_login_at)} />
                  {user.deactivation_reason === null ? null : (
                    <Pair label="Deactivated because" value={user.deactivation_reason} />
                  )}
                </dl>

                <section aria-labelledby="user-roles-heading" className="mt-2">
                  <h3 id="user-roles-heading" className="text-md font-medium">
                    Roles
                  </h3>
                  {user.roles.length === 0 ? (
                    <EmptyState
                      cause="This account holds no role, so it lands on an empty workspace."
                      nextAction="Assign at least one role so the person can do their job."
                      className="mt-2"
                    />
                  ) : (
                    <ul className="mt-2 flex flex-col gap-1">
                      {user.roles.map((assignment) => (
                        <li
                          key={assignment.id}
                          className="flex flex-wrap items-center gap-2 rounded-md border border-default px-2 py-1.5 text-sm"
                        >
                          <span className="font-medium">{assignment.role_name}</span>
                          <span className="font-mono text-xs text-fg-muted">{assignment.role_key}</span>
                          <Badge tone={assignment.active ? 'success' : 'neutral'} size="sm">
                            {assignment.active ? 'active' : 'ended'}
                          </Badge>
                          <span className="text-xs text-fg-muted">
                            from {formatTimestamp(assignment.valid_from)}
                            {assignment.valid_to === null
                              ? ''
                              : ` to ${formatTimestamp(assignment.valid_to)}`}
                          </span>
                          {canAssign && assignment.active ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="ms-auto"
                              onClick={() => {
                                setRevokeTarget(assignment.id);
                              }}
                            >
                              Revoke
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </>
            )}
          </AsyncPanel>
        </DialogBody>
        <DialogFooter>
          {canReset ? (
            <Button
              variant="secondary"
              onClick={() => {
                setResetOpen(true);
              }}
            >
              <KeyRound aria-hidden="true" />
              Reset password
            </Button>
          ) : null}
          {canDeactivate && user !== undefined && user.status !== 'deactivated' && !isSelf ? (
            <Button
              variant="danger"
              data-testid="deactivate-user"
              onClick={() => {
                setDeactivateOpen(true);
              }}
            >
              <UserX aria-hidden="true" />
              Deactivate
            </Button>
          ) : null}
        </DialogFooter>

        {/* Nested inside the drawer's content on purpose. Radix hides everything
            outside an open dialog from assistive technology, and a confirm layer
            portalled as a *sibling* of the drawer can be caught by that and
            announced to nobody. Nesting keeps it inside the visible layer. */}
        <ConfirmWithReasonDialog
          open={deactivateOpen}
          onOpenChange={setDeactivateOpen}
          confirmationValue={user?.username ?? ''}
          labels={{
            title: `Deactivate ${user?.display_name ?? 'this account'}`,
            description:
              'Every session and device token is revoked immediately and the person is signed out wherever they are. The account is kept, not deleted, so their history stays attributable.',
            reasonLabel: 'Reason',
            reasonPlaceholder: 'Choose a reason',
            notePlaceholder: 'e.g. Left the hospital on 18-08-2026 (HR ref 4471)',
            confirm: 'Deactivate the account',
            cancel: 'Keep the account',
            typedValuePrompt: (expected) => `Type the username ${expected} to confirm`,
            reasonRequired: 'A reason is required. It is stored on the account and in the audit log.',
            typedValueMismatch: 'The username must match exactly.',
          }}
          onConfirm={(result) => {
            setDeactivateOpen(false);
            onDeactivate(result.reasonText);
          }}
        />

        <ResetPasswordDialog
          open={resetOpen}
          onOpenChange={setResetOpen}
          username={user?.username ?? ''}
          onSubmit={(password, reason) => {
            setResetOpen(false);
            onReset(password, reason);
          }}
        />

        <ConfirmWithReasonDialog
          open={revokeTarget !== null}
          onOpenChange={(open) => {
            if (!open) setRevokeTarget(null);
          }}
          labels={{
            title: 'Revoke this role',
            description:
              'The grant is ended rather than erased, so the quarterly access review can still answer for it. The person loses the permissions within five seconds.',
            reasonLabel: 'Reason',
            reasonPlaceholder: 'Choose a reason',
            notePlaceholder: 'e.g. Moved from Ward 3B to the day-care unit',
            confirm: 'Revoke the role',
            cancel: 'Keep the role',
            typedValuePrompt: (expected) => `Type ${expected} to confirm`,
            reasonRequired: 'A reason is required and is sent with the request.',
            typedValueMismatch: 'The value must match exactly.',
          }}
          onConfirm={(result) => {
            const target = revokeTarget;
            setRevokeTarget(null);
            if (target !== null) revoke.mutate({ userRoleId: target, reason: result.reasonText });
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function Pair({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | null;
}): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="text-fg-default">{value ?? '—'}</dd>
    </div>
  );
}

// ── password reset ───────────────────────────────────────────────────────────

/**
 * An administrator reset always forces a change at the next sign-in, so the
 * temporary value only ever has to survive one handover. The dialog therefore
 * asks for a reason as well as a password: `admin.user.reset` is
 * `requiresReason`, and the API refuses without the `x-reason` header.
 */
function ResetPasswordDialog({
  open,
  onOpenChange,
  username,
  onSubmit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly username: string;
  readonly onSubmit: (password: string, reason: string) => void;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const valid = password.length >= 12 && reason.trim().length >= 5;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setPassword('');
          setReason('');
        }
        onOpenChange(next);
      }}
    >
      <DialogContent closeLabel="Close">
        <DialogHeader>
          <DialogTitle>Reset the password for {username}</DialogTitle>
          <DialogDescription>
            The person must choose their own password at their next sign-in, so this value is only a handover.
            Say it to them; never send it in the same channel as their username.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-1">
            <Label htmlFor="reset-password" required>
              Temporary password
            </Label>
            <Input
              id="reset-password"
              type="password"
              value={password}
              autoComplete="new-password"
              aria-describedby="reset-password-hint"
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
            <p id="reset-password-hint" className="text-xs text-fg-muted">
              At least 12 characters, per the hospital password policy.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="reset-reason" required>
              Reason
            </Label>
            <Input
              id="reset-reason"
              value={reason}
              data-testid="reset-reason"
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <p className="text-xs text-fg-muted">
              Recorded in the audit log. A reset without a reason is refused by the API.
            </p>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!valid}
            data-testid="reset-submit"
            onClick={() => {
              onSubmit(password, reason.trim());
              setPassword('');
              setReason('');
            }}
          >
            Reset the password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── create ───────────────────────────────────────────────────────────────────

function CreateUserDialog({
  open,
  onOpenChange,
  saving,
  onSubmit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly saving: boolean;
  readonly onSubmit: (input: {
    readonly username: string;
    readonly name: { readonly family: string; readonly given: string };
    readonly email?: string;
    readonly type: 'staff';
    readonly roleAssignments: readonly { readonly roleId: string; readonly branchId: null }[];
    readonly inviteVia: 'none';
  }) => void;
}): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = adminKeys(hospitalId);
  const rolesQuery = useQuery({ queryKey: keys.roles(), queryFn: ({ signal }) => listRoles({ signal }) });

  const [username, setUsername] = useState('');
  const [given, setGiven] = useState('');
  const [family, setFamily] = useState('');
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');

  const roles = rolesQuery.data?.items ?? [];
  const valid =
    /^[a-zA-Z0-9._-]{3,64}$/.test(username) && given.trim() !== '' && family.trim() !== '' && roleId !== '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel="Close">
        <DialogHeader>
          <DialogTitle>New user</DialogTitle>
          <DialogDescription>
            At least one role is required — an account with none lands on an empty workspace and generates a
            helpdesk call on its first day.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-username" required>
              Username
            </Label>
            <Input
              id="new-username"
              value={username}
              autoComplete="off"
              data-testid="new-username"
              onChange={(event) => {
                setUsername(event.target.value);
              }}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="new-given" required>
                Given name
              </Label>
              <Input
                id="new-given"
                value={given}
                onChange={(event) => {
                  setGiven(event.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="new-family" required>
                Family name
              </Label>
              <Input
                id="new-family"
                value={family}
                onChange={(event) => {
                  setFamily(event.target.value);
                }}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-email">Email</Label>
            <Input
              id="new-email"
              type="email"
              value={email}
              autoComplete="off"
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-role" required>
              Role
            </Label>
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger id="new-role" data-testid="new-role">
                <SelectValue placeholder="Choose a role" />
              </SelectTrigger>
              <SelectContent>
                {roles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {role.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-fg-muted">
              Roles flagged for dual approval are refused until a second administrator approves the grant, and
              the refusal will say so.
            </p>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid || saving}
            aria-busy={saving}
            data-testid="create-user-submit"
            onClick={() => {
              onSubmit({
                username,
                name: { family: family.trim(), given: given.trim() },
                ...(email.trim() === '' ? {} : { email: email.trim() }),
                type: 'staff',
                roleAssignments: [{ roleId, branchId: null }],
                inviteVia: 'none',
              });
            }}
          >
            {saving ? 'Creating…' : 'Create the account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type { UserListItem };
