'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import {
  AuditDiffViewer,
  Badge,
  Button,
  Checkbox,
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
} from '@vims/ui';
import { ChevronDown, ChevronRight, FileSearch, ShieldAlert } from '@/lib/icons';
import { useCallback, useMemo, useState } from 'react';
import { useSession } from '@/lib/session-context';
import { searchAudit } from '../api/client';
import { adminKeys } from '../api/keys';
import type { AuditFilters, AuditRow } from '../api/types';
import { isDenial, toAuditDiffEntry } from '../lib/audit-diff';
import { formatCount, formatTimestamp } from '../lib/format';
import { AsyncPanel } from './async-panel';
import { PageHeader } from './page-header';

/**
 * The audit log viewer (EN-007 §3.6, EN-024 §6).
 *
 * **Read-only by construction.** There is no update path on
 * `/api/v1/admin/audit` — the log is append-only and hash-chained — and there is
 * none here either: no form posts, no mutation hook, not even a delete affordance
 * that would 405. A viewer that offers an edit an auditor believes in is worse
 * than one that offers nothing.
 *
 * The filters are the ones an investigation actually starts from (EN-007 §3.6):
 * "search by user, patient, table/entity, action, date, IP". Each one is a server
 * query parameter, not a client-side array filter, because the table is
 * partitioned monthly and the answer is never in the first page.
 */

const ACTIONS = [
  'create',
  'update',
  'delete',
  'read_phi',
  'login',
  'logout',
  'config_change',
  'permission_denied',
  'export',
] as const;

const DIFF_LABELS = {
  region: 'Change detail',
  fieldColumn: 'Field',
  beforeColumn: 'Before',
  afterColumn: 'After',
  emptyValue: 'not set',
  reasonPrefix: 'Reason:',
  chainVerified: 'Sealed in the hash chain',
  chainBroken: 'Not yet sealed',
  byline: (actor: string, role: string, at: string) => `${actor} · ${role} · ${at}`,
} as const;

export function AuditScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = adminKeys(hospitalId);

  const [draft, setDraft] = useState<AuditFilters>({});
  const [applied, setApplied] = useState<AuditFilters>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = useInfiniteQuery({
    queryKey: keys.audit(applied),
    queryFn: ({ pageParam, signal }) => searchAudit(applied, pageParam, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const rows = useMemo(() => (query.data?.pages ?? []).flatMap((page) => page.items), [query.data]);

  const apply = useCallback(() => {
    setApplied(normalise(draft));
    setExpanded(null);
  }, [draft]);

  const chips = describeFilters(applied);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="EN-024"
        title="Audit log"
        description="Append-only and hash-chained. Every row records who acted, on what, with which result and — where the permission demanded one — why. Nothing on this screen can change a row; the API has no route that could."
        meta={
          <Badge tone="neutral" icon={<ShieldAlert aria-hidden="true" />}>
            Read-only by construction
          </Badge>
        }
      />

      <form
        aria-label="Audit filters"
        className="flex flex-col gap-3 rounded-lg border border-default bg-layer-1 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field
            id="audit-user"
            label="Actor (user ID)"
            hint="The person who acted. Paste an ID from the users screen."
            value={draft.userId ?? ''}
            onChange={(value) => {
              setDraft({ ...draft, userId: value });
            }}
          />
          <Field
            id="audit-patient"
            label="Patient ID"
            hint="Every access to this patient's record, including break-glass reads."
            value={draft.patientId ?? ''}
            onChange={(value) => {
              setDraft({ ...draft, patientId: value });
            }}
          />
          <Field
            id="audit-entity"
            label="Entity"
            hint="The table that was touched, e.g. core.roles."
            value={draft.entity ?? ''}
            onChange={(value) => {
              setDraft({ ...draft, entity: value });
            }}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-action">Action</Label>
            <Select
              value={draft.action ?? 'any'}
              onValueChange={(value) => {
                setDraft({ ...draft, action: value === 'any' ? undefined : value });
              }}
            >
              <SelectTrigger id="audit-action" data-testid="audit-action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any action</SelectItem>
                {ACTIONS.map((action) => (
                  <SelectItem key={action} value={action}>
                    {action}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-fg-muted">What was done, not which screen did it.</p>
          </div>
          <Field
            id="audit-from"
            label="From"
            type="datetime-local"
            hint="Hospital time. Left empty, the search starts at the newest row."
            value={toLocalInput(draft.from)}
            onChange={(value) => {
              setDraft({ ...draft, from: fromLocalInput(value) });
            }}
          />
          <Field
            id="audit-to"
            label="To"
            type="datetime-local"
            hint="Hospital time."
            value={toLocalInput(draft.to)}
            onChange={(value) => {
              setDraft({ ...draft, to: fromLocalInput(value) });
            }}
          />
          <Field
            id="audit-key"
            label="Business key"
            hint="A human identifier such as a bill number or a role key."
            value={draft.businessKey ?? ''}
            onChange={(value) => {
              setDraft({ ...draft, businessKey: value });
            }}
          />
          <Field
            id="audit-q"
            label="Free text"
            hint="Matches the reason text recorded with the action."
            value={draft.q ?? ''}
            onChange={(value) => {
              setDraft({ ...draft, q: value });
            }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <Toggle
            id="audit-break-glass"
            label="Break-glass reads only"
            checked={draft.breakGlassOnly ?? false}
            onChange={(checked) => {
              setDraft({ ...draft, breakGlassOnly: checked });
            }}
          />
          <Toggle
            id="audit-denied"
            label="Refusals only"
            checked={draft.deniedOnly ?? false}
            onChange={(checked) => {
              setDraft({ ...draft, deniedOnly: checked });
            }}
          />
          <Toggle
            id="audit-impersonated"
            label="Impersonated sessions only"
            checked={draft.impersonatedOnly ?? false}
            onChange={(checked) => {
              setDraft({ ...draft, impersonatedOnly: checked });
            }}
          />
          <span className="ms-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft({});
                setApplied({});
              }}
            >
              Clear
            </Button>
            <Button variant="primary" size="sm" type="submit" data-testid="audit-apply">
              Search
            </Button>
          </span>
        </div>

        {chips.length === 0 ? null : (
          <p className="flex flex-wrap items-center gap-1 text-xs text-fg-muted" data-testid="audit-chips">
            Showing:
            {chips.map((chip) => (
              <Badge key={chip} tone="accent" size="sm">
                {chip}
              </Badge>
            ))}
          </p>
        )}
      </form>

      <AsyncPanel
        loading={query.isPending}
        error={query.error}
        isEmpty={rows.length === 0}
        onRetry={() => void query.refetch()}
        skeletonLabel="Searching the audit log"
        skeletonRows={10}
        skeletonColumns={[2, 3, 2, 2, 1]}
        empty={
          <EmptyState
            icon={<FileSearch />}
            cause="No audit row matches these filters."
            nextAction="Widen the date range or clear a filter — the log is never empty, so this is a search result, not an absence of activity."
            action={{
              label: 'Clear filters',
              onSelect: () => {
                setDraft({});
                setApplied({});
              },
            }}
          />
        }
      >
        <div className="rounded-lg border border-default bg-layer-1">
          <Table scrollRegionLabel="Audit log">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <span className="sr-only">Expand</span>
                </TableHead>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <AuditRowView
                  key={row.id}
                  row={row}
                  expanded={expanded === row.id}
                  onToggle={() => {
                    setExpanded((current) => (current === row.id ? null : row.id));
                  }}
                />
              ))}
            </TableBody>
          </Table>

          <div className="flex items-center justify-between gap-2 border-t border-default p-3 text-sm">
            <span aria-live="polite" data-testid="audit-count">
              {formatCount(rows.length)} row{rows.length === 1 ? '' : 's'} loaded
              {query.hasNextPage ? ' — more available' : ' — end of the log for these filters'}
            </span>
            <Button
              variant="secondary"
              size="sm"
              data-testid="audit-load-more"
              disabled={!query.hasNextPage || query.isFetchingNextPage}
              aria-busy={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        </div>
      </AsyncPanel>
    </div>
  );
}

function AuditRowView({
  row,
  expanded,
  onToggle,
}: {
  readonly row: AuditRow;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): React.JSX.Element {
  const denied = isDenial(row);
  const detailId = `audit-detail-${row.id}`;

  return (
    <>
      <TableRow data-critical={denied ? 'true' : 'false'} data-testid="audit-row">
        <TableCell>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={detailId}
            className="rounded-sm p-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {expanded ? (
              <ChevronDown className="size-4" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-4" aria-hidden="true" />
            )}
            <span className="sr-only">
              {expanded ? 'Hide' : 'Show'} the before and after values for this entry
            </span>
          </button>
        </TableCell>
        <TableCell className="whitespace-nowrap font-mono text-xs">
          {formatTimestamp(row.occurred_at)}
        </TableCell>
        <TableCell className="max-w-56 truncate font-mono text-xs">
          {row.actor_user_id ?? 'system'}
          <span className="block text-3xs text-fg-muted">{row.actor_role ?? '—'}</span>
        </TableCell>
        <TableCell className="whitespace-nowrap text-xs">{row.action}</TableCell>
        <TableCell className="max-w-64 truncate font-mono text-xs">
          {row.entity}
          {row.business_key === null ? null : (
            <span className="block text-3xs text-fg-muted">{row.business_key}</span>
          )}
        </TableCell>
        <TableCell>
          <Badge tone={denied ? 'danger' : 'success'} size="sm">
            {denied ? row.result : 'success'}
          </Badge>
          {row.patient_id === null ? null : (
            <Badge tone="violet" size="sm" className="ms-1">
              PHI
            </Badge>
          )}
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow>
          <TableCell colSpan={6} id={detailId} className="bg-sunken">
            <AuditDiffViewer entry={toAuditDiffEntry(row)} labels={DIFF_LABELS} />
            <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
              <Detail label="Trace" value={row.trace_id} mono />
              <Detail label="Route" value={row.api_route} mono />
              <Detail label="Data class" value={row.data_class} />
              <Detail label="Sensitivity" value={row.sensitivity} />
              <Detail label="Refusal reason" value={row.denial_reason} />
              <Detail label="Rows affected" value={row.row_count === null ? null : String(row.row_count)} />
            </dl>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function Detail({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <dt className="text-fg-muted">{label}</dt>
      <dd className={mono ? 'font-mono text-fg-default' : 'text-fg-default'}>{value ?? '—'}</dd>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
  type = 'text',
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        aria-describedby={`${id}-hint`}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <p id={`${id}-hint`} className="text-xs text-fg-muted">
        {hint}
      </p>
    </div>
  );
}

function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => {
          onChange(value === true);
        }}
      />
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
    </span>
  );
}

/** Blank strings must not become `?entity=` — the API would reject an empty uuid. */
export function normalise(filters: AuditFilters): AuditFilters {
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== '') out[key] = trimmed;
    } else if (value === true) {
      out[key] = true;
    }
  }
  return out;
}

/** The applied filters as removable-looking chips (docs/06 §6.5). */
export function describeFilters(filters: AuditFilters): readonly string[] {
  const chips: string[] = [];
  if (filters.userId !== undefined) chips.push(`actor ${filters.userId}`);
  if (filters.patientId !== undefined) chips.push(`patient ${filters.patientId}`);
  if (filters.entity !== undefined) chips.push(`entity ${filters.entity}`);
  if (filters.action !== undefined) chips.push(`action ${filters.action}`);
  if (filters.businessKey !== undefined) chips.push(`key ${filters.businessKey}`);
  if (filters.from !== undefined) chips.push(`from ${formatTimestamp(filters.from)}`);
  if (filters.to !== undefined) chips.push(`to ${formatTimestamp(filters.to)}`);
  if (filters.q !== undefined) chips.push(`text “${filters.q}”`);
  if (filters.breakGlassOnly === true) chips.push('break-glass only');
  if (filters.deniedOnly === true) chips.push('refusals only');
  if (filters.impersonatedOnly === true) chips.push('impersonated only');
  return chips;
}

/** `datetime-local` speaks local wall-clock; the API speaks ISO-8601 with an offset. */
function toLocalInput(iso: string | undefined): string {
  if (iso === undefined) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function fromLocalInput(value: string): string | undefined {
  if (value === '') return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}
