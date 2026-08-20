'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  KeyboardHintBar,
  Label,
  useToast,
} from '@vims/ui';
import { ShieldCheck, Users } from '@/lib/icons';
import { useMemo, useState } from 'react';
import { useSession } from '@/lib/session-context';
import { cloneRole, getPermissionCatalogue, getRole, listRoles, updateRolePermissions } from '../api/client';
import { adminKeys } from '../api/keys';
import type { RoleListItem } from '../api/types';
import { formatCount } from '../lib/format';
import { AsyncPanel } from './async-panel';
import { PageHeader } from './page-header';
import { ProblemCard } from './problem-card';
import { MAX_COMPARISON_ROLES, PermissionMatrix, type ComparisonColumn } from './permission-matrix';

/**
 * Roles & permissions (EN-007 §8).
 *
 * Two panes: the role list, and the matrix editor for whichever role is
 * selected. The list is the column picker as much as it is navigation — adding a
 * role as a *comparison* is what turns "what does this role do" into "how does
 * this role differ from the template it came from", which is the question an
 * access review actually asks.
 *
 * Comparison roles are fetched one query each, keyed by role id, so a role
 * already opened in the editor is served from cache when it is added as a column.
 */
export function RolesScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = adminKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();
  const canConfigure = granted.has('admin.role.configure');

  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [comparisonIds, setComparisonIds] = useState<readonly string[]>([]);
  const [roleSearch, setRoleSearch] = useState('');
  const [cloneOpen, setCloneOpen] = useState(false);

  const catalogueQuery = useQuery({
    queryKey: keys.permissions(),
    queryFn: ({ signal }) => getPermissionCatalogue({ signal }),
    // The catalogue is compiled into the running build; it cannot change until
    // the API is redeployed, at which point the page is reloaded anyway.
    staleTime: Number.POSITIVE_INFINITY,
  });

  const rolesQuery = useQuery({
    queryKey: keys.roles(),
    queryFn: ({ signal }) => listRoles({ signal }),
  });

  const roles = useMemo(() => rolesQuery.data?.items ?? [], [rolesQuery.data]);
  const activeRoleId = selectedRoleId ?? preferredRole(roles)?.id ?? null;

  const roleQuery = useQuery({
    queryKey: keys.role(activeRoleId ?? 'none'),
    queryFn: ({ signal }) => getRole(activeRoleId ?? '', { signal }),
    enabled: activeRoleId !== null,
  });

  const comparisonQueries = useQueries({
    queries: comparisonIds.map((id) => ({
      queryKey: keys.role(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => getRole(id, { signal }),
    })),
  });

  const comparisons: readonly ComparisonColumn[] = comparisonIds.flatMap((id, index) => {
    const role = roles.find((r) => r.id === id);
    if (role === undefined) return [];
    const query = comparisonQueries[index];
    const permissions = query?.data === undefined ? null : new Set(query.data.permissions);
    return [{ role, permissions, loading: query?.isPending ?? true }];
  });

  const save = useMutation({
    mutationFn: (input: { readonly permissions: readonly string[]; readonly reason: string }) =>
      updateRolePermissions({
        id: roleQuery.data?.id ?? '',
        version: roleQuery.data?.version ?? 0,
        permissions: input.permissions,
        reason: input.reason,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.role(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: keys.roles() });
      publish({
        title: `${updated.name} saved`,
        description:
          'Everyone holding this role picks up the change within five seconds. The edit is in the audit log with your reason.',
        severity: 'success',
      });
    },
  });

  const clone = useMutation({
    mutationFn: cloneRole,
    onSuccess: (created) => {
      queryClient.setQueryData(keys.role(created.id), created);
      void queryClient.invalidateQueries({ queryKey: keys.roles() });
      setSelectedRoleId(created.id);
      setCloneOpen(false);
      publish({ title: `${created.name} created`, severity: 'success' });
    },
  });

  const filteredRoles = roles.filter((role) => {
    const needle = roleSearch.trim().toLowerCase();
    if (needle === '') return true;
    return `${role.key} ${role.name} ${role.category}`.toLowerCase().includes(needle);
  });

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <PageHeader
        eyebrow="EN-007"
        title="Roles & permissions"
        description="One role is edited at a time; add up to four more as read-only columns to compare against. Every change is versioned, reasoned and audited, and reaches live sessions within five seconds."
        meta={
          <>
            <Badge tone="neutral" icon={<ShieldCheck aria-hidden="true" />}>
              {formatCount(catalogueQuery.data?.total ?? 0)} permission keys
            </Badge>
            <Badge tone="neutral" icon={<Users aria-hidden="true" />}>
              {formatCount(roles.length)} roles
            </Badge>
          </>
        }
      />

      {save.isError ? <ProblemCard error={save.error} /> : null}
      {clone.isError ? <ProblemCard error={clone.error} /> : null}

      <div className="flex min-h-0 flex-col gap-4 xl:flex-row">
        <aside aria-label="Roles" className="w-full shrink-0 xl:w-72">
          <Label htmlFor="role-search">Find a role</Label>
          <Input
            id="role-search"
            type="search"
            value={roleSearch}
            placeholder="name, key or category"
            data-testid="role-search"
            onChange={(event) => {
              setRoleSearch(event.target.value);
            }}
          />

          <AsyncPanel
            loading={rolesQuery.isPending}
            error={rolesQuery.error}
            isEmpty={filteredRoles.length === 0}
            onRetry={() => void rolesQuery.refetch()}
            skeletonLabel="Loading roles"
            skeletonRows={10}
            skeletonColumns={[4, 1]}
            empty={
              <EmptyState
                cause="No role matches that search."
                nextAction="Clear the search to see all seeded templates and your hospital's own roles."
              />
            }
          >
            <ul className="mt-2 flex max-h-[60vh] flex-col gap-1 overflow-y-auto" data-testid="role-list">
              {filteredRoles.map((role) => (
                <li key={role.id}>
                  <RoleListRow
                    role={role}
                    active={role.id === activeRoleId}
                    comparing={comparisonIds.includes(role.id)}
                    canCompare={comparisonIds.length < MAX_COMPARISON_ROLES}
                    onSelect={() => {
                      setSelectedRoleId(role.id);
                      setComparisonIds((current) => current.filter((id) => id !== role.id));
                    }}
                    onToggleCompare={() => {
                      setComparisonIds((current) =>
                        current.includes(role.id)
                          ? current.filter((id) => id !== role.id)
                          : [...current, role.id].slice(0, MAX_COMPARISON_ROLES),
                      );
                    }}
                  />
                </li>
              ))}
            </ul>
          </AsyncPanel>
        </aside>

        <div className="min-w-0 flex-1">
          <AsyncPanel
            loading={catalogueQuery.isPending || roleQuery.isPending || activeRoleId === null}
            error={catalogueQuery.error ?? roleQuery.error}
            isEmpty={false}
            empty={null}
            onRetry={() => {
              void catalogueQuery.refetch();
              void roleQuery.refetch();
            }}
            skeletonLabel="Loading the permission matrix"
            skeletonRows={12}
            skeletonColumns={[5, 1, 1]}
          >
            {catalogueQuery.data !== undefined && roleQuery.data !== undefined ? (
              <PermissionMatrix
                catalogue={catalogueQuery.data}
                role={roleQuery.data}
                comparisons={comparisons}
                canConfigure={canConfigure}
                saving={save.isPending}
                onSave={(permissions, reason) => {
                  save.mutate({ permissions, reason });
                }}
                {...(canConfigure
                  ? {
                      onCloneRequested: () => {
                        setCloneOpen(true);
                      },
                    }
                  : {})}
              />
            ) : null}
          </AsyncPanel>
        </div>
      </div>

      <KeyboardHintBar
        label="Permission matrix shortcuts"
        hints={[
          { keys: ['↑', '↓'], label: 'Move row' },
          { keys: ['←', '→'], label: 'Move column' },
          { keys: ['Space'], label: 'Toggle permission' },
          { keys: ['Home', 'End'], label: 'First / last row' },
          { keys: ['⌘', 'K'], label: 'Command palette' },
        ]}
      />

      {roleQuery.data === undefined ? null : (
        <CloneRoleDialog
          open={cloneOpen}
          onOpenChange={setCloneOpen}
          templateKey={roleQuery.data.key}
          templateName={roleQuery.data.name}
          homeWorkspace={roleQuery.data.home_workspace}
          permissions={roleQuery.data.permissions}
          saving={clone.isPending}
          onSubmit={(input) => {
            clone.mutate(input);
          }}
        />
      )}
    </div>
  );
}

/**
 * Which role the editor opens on.
 *
 * A hospital's own role is the useful default — a system template cannot be
 * edited, so opening on one presents a read-only grid as the landing state. When
 * there are no custom roles yet, the first template is still better than nothing:
 * it is the thing the administrator will clone.
 */
function preferredRole(roles: readonly RoleListItem[]): RoleListItem | undefined {
  return roles.find((role) => !role.is_system) ?? roles[0];
}

function RoleListRow({
  role,
  active,
  comparing,
  canCompare,
  onSelect,
  onToggleCompare,
}: {
  readonly role: RoleListItem;
  readonly active: boolean;
  readonly comparing: boolean;
  readonly canCompare: boolean;
  readonly onSelect: () => void;
  readonly onToggleCompare: () => void;
}): React.JSX.Element {
  return (
    <div
      data-active={active ? 'true' : 'false'}
      className="flex items-center gap-1 rounded-md border border-transparent data-[active=true]:border-accent-border data-[active=true]:bg-accent-surface"
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        className="min-w-0 flex-1 rounded-md px-2 py-2 text-start hover:bg-layer-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <span className="block truncate text-sm font-medium text-fg-default">{role.name}</span>
        <span className="block truncate font-mono text-3xs text-fg-muted">{role.key}</span>
        <span className="mt-1 flex flex-wrap items-center gap-1">
          <Badge tone={role.is_system ? 'neutral' : 'accent'} size="sm">
            {role.is_system ? 'template' : 'custom'}
          </Badge>
          {role.sensitive_grant ? (
            <Badge tone="danger" size="sm">
              dual approval
            </Badge>
          ) : null}
          <span className="text-3xs text-fg-subtle">{formatCount(role.assigned_users)} assigned</span>
        </span>
      </button>
      {active ? null : (
        <Button
          variant="ghost"
          size="sm"
          disabled={!comparing && !canCompare}
          aria-pressed={comparing}
          onClick={onToggleCompare}
          className="shrink-0"
        >
          {comparing ? 'Comparing' : 'Compare'}
        </Button>
      )}
    </div>
  );
}

function CloneRoleDialog({
  open,
  onOpenChange,
  templateKey,
  templateName,
  homeWorkspace,
  permissions,
  saving,
  onSubmit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly templateKey: string;
  readonly templateName: string;
  readonly homeWorkspace: string;
  readonly permissions: readonly string[];
  readonly saving: boolean;
  readonly onSubmit: (input: {
    readonly key: string;
    readonly name: string;
    readonly description: string;
    readonly templateKey: string;
    readonly permissions: readonly string[];
    readonly homeWorkspace: string;
  }) => void;
}): React.JSX.Element {
  const [key, setKey] = useState(`${templateKey}_custom`);
  const [name, setName] = useState(`${templateName} (custom)`);
  const [description, setDescription] = useState(`Cloned from the ${templateName} template.`);
  const keyValid = /^[a-z][a-z0-9_]{2,63}$/.test(key);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel="Close">
        <DialogHeader>
          <DialogTitle>Clone {templateName}</DialogTitle>
          <DialogDescription>
            The copy starts with the template&rsquo;s {formatCount(permissions.length)} permissions and is
            yours to edit. The template itself stays untouched, so the baseline an auditor compares against
            never moves.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-1">
            <Label htmlFor="clone-key" required>
              Role key
            </Label>
            <Input
              id="clone-key"
              value={key}
              aria-invalid={!keyValid}
              aria-describedby="clone-key-hint"
              onChange={(event) => {
                setKey(event.target.value);
              }}
            />
            <p id="clone-key-hint" className="text-xs text-fg-muted">
              Lower snake_case, 3–64 characters. This is what appears in the audit log for every grant, so it
              cannot be changed later.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="clone-name" required>
              Display name
            </Label>
            <Input
              id="clone-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="clone-description">Description</Label>
            <Input
              id="clone-description"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
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
            disabled={!keyValid || name.trim() === '' || saving}
            aria-busy={saving}
            onClick={() => {
              onSubmit({ key, name, description, templateKey, permissions, homeWorkspace });
            }}
          >
            {saving ? 'Creating…' : 'Create the copy'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
