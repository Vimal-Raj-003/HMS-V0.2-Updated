'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  ConfirmWithReasonDialog,
  SkeletonList,
  WorklistTable,
  useToast,
  type WorklistColumn,
} from '@vims/ui';
import { useCallback, useMemo, useState } from 'react';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { listAppointmentRequests, updateAppointmentRequest } from '../api/client';
import { frontOfficeKeys } from '../api/keys';
import type { AppointmentRequestRow, AppointmentRequestStatus } from '../api/types';

/**
 * PE-009 — the enquiries the landing page's assistant leaves behind.
 *
 * This screen existed as a gap for exactly as long as the feature did. The API
 * was built, permissioned and tested; the module doc argued that "a queue
 * nobody can read is worse than a queue that was never collected", and then
 * shipped without anywhere to read it. The hospital was collecting names and
 * phone numbers from its own website into a table with no screen and no owner,
 * which is a DPDP problem as much as an operational one.
 *
 * ── What this screen deliberately cannot do ───────────────────────────────
 *
 * It cannot book. An enquiry becomes an appointment through the appointment
 * book, by somebody holding `appointment.create`, against a real slot with real
 * capacity — and only then is the enquiry linked to what it became. Putting a
 * "Book" button here would be a second booking engine that knows nothing about
 * overbooking or capacity, which is how double-booked clinics happen.
 *
 * What it does is the part front office actually needs: see who asked, what
 * they asked for, ring them, and record the outcome.
 */

const TABS: readonly { readonly key: AppointmentRequestStatus | 'all'; readonly label: string }[] = [
  { key: 'new', label: 'New' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'booked', label: 'Booked' },
  { key: 'declined', label: 'Declined' },
  { key: 'all', label: 'All' },
];

const STATUS_TONE: Readonly<Record<string, 'info' | 'success' | 'warning' | 'neutral'>> = {
  new: 'info',
  contacted: 'warning',
  booked: 'success',
  declined: 'neutral',
  expired: 'neutral',
};

const PERIOD_LABELS: Readonly<Record<string, string>> = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
  any: 'Any time',
};

/** Local time, because a clerk reads this next to a clock on the wall. */
function whenReceived(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function preferredWhen(row: AppointmentRequestRow): string {
  const date = row.preferredDate === null ? null : row.preferredDate;
  const period =
    row.preferredPeriod === null ? null : (PERIOD_LABELS[row.preferredPeriod] ?? row.preferredPeriod);
  if (date === null && period === null) return 'No preference';
  if (date === null) return period ?? 'No preference';
  return period === null ? date : `${date}, ${period.toLowerCase()}`;
}

export function EnquiriesScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = useMemo(() => frontOfficeKeys(hospitalId), [hospitalId]);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const [tab, setTab] = useState<AppointmentRequestStatus | 'all'>('new');
  const [declining, setDeclining] = useState<AppointmentRequestRow | null>(null);

  const canUpdate = granted.has('appointment.request.update');

  const enquiries = useQuery({
    queryKey: keys.enquiries(tab),
    queryFn: () => listAppointmentRequests(tab),
  });

  const settle = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: keys.enquiriesRoot() });
  }, [queryClient, keys]);

  const contact = useMutation({
    mutationFn: (row: AppointmentRequestRow) =>
      updateAppointmentRequest(row.id, { status: 'contacted' }, 'Telephoned the enquirer'),
    onSuccess: (row) => {
      publish({ severity: 'success', title: `${row.requesterName} marked contacted` });
      void settle();
    },
    onError: (error: Error) => {
      publish({ severity: 'danger', title: 'Could not update the enquiry', description: error.message });
    },
  });

  const decline = useMutation({
    mutationFn: ({ row, reason }: { row: AppointmentRequestRow; reason: string }) =>
      updateAppointmentRequest(row.id, { status: 'declined', declineReason: reason }, reason),
    onSuccess: (row) => {
      publish({ severity: 'success', title: `Enquiry from ${row.requesterName} declined` });
      setDeclining(null);
      void settle();
    },
    onError: (error: Error) => {
      publish({ severity: 'danger', title: 'Could not decline the enquiry', description: error.message });
    },
  });

  const columns = useMemo<readonly WorklistColumn<AppointmentRequestRow>[]>(
    () => [
      {
        key: 'name',
        header: 'Name',
        render: (row) => <span className="font-medium">{row.requesterName}</span>,
      },
      {
        key: 'phone',
        header: 'Phone',
        // The column the job is actually done from: a clerk rings this number.
        // `tel:` so it dials from a softphone or a tablet rather than being
        // copied out by hand and mistyped.
        render: (row) => (
          <a className="font-mono text-sm underline underline-offset-2" href={`tel:${row.requesterPhone}`}>
            {row.requesterPhone}
          </a>
        ),
      },
      {
        key: 'department',
        header: 'Department',
        render: (row) => row.specialityName ?? <span className="text-fg-subtle">No preference</span>,
      },
      {
        key: 'preferred',
        header: 'Preferred',
        render: (row) => preferredWhen(row),
      },
      {
        key: 'reason',
        header: 'Reason',
        visibility: 'secondary',
        render: (row) => row.reason ?? <span className="text-fg-subtle">—</span>,
      },
      {
        key: 'received',
        header: 'Received',
        sortable: false,
        render: (row) => <span className="tabular-nums">{whenReceived(row.createdAt)}</span>,
      },
      {
        key: 'status',
        header: 'Status',
        render: (row) => <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.status}</Badge>,
      },
      {
        key: 'actions',
        header: 'Actions',
        render: (row) => {
          // Only an open enquiry can be worked. A booked one is finished, and a
          // declined one already carries its reason.
          if (row.status !== 'new' && row.status !== 'contacted') {
            return <span className="text-fg-subtle text-sm">Closed</span>;
          }
          if (!canUpdate) return <span className="text-fg-subtle text-sm">Read only</span>;
          return (
            <div className="flex flex-wrap gap-2">
              {row.status === 'new' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={contact.isPending}
                  onClick={() => {
                    contact.mutate(row);
                  }}
                >
                  Mark contacted
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDeclining(row);
                }}
              >
                Decline
              </Button>
            </div>
          );
        },
      },
    ],
    [canUpdate, contact],
  );

  return (
    <div className="space-y-6" data-testid="enquiries-screen">
      <PageHeader
        title="Website enquiries"
        description="Appointment requests left by the assistant on the public site. These are requests, not bookings — telephone the enquirer, then book through the appointment book."
      />

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Enquiry status">
        {TABS.map((entry) => (
          <Button
            key={entry.key}
            role="tab"
            aria-selected={tab === entry.key}
            size="sm"
            variant={tab === entry.key ? 'primary' : 'ghost'}
            onClick={() => {
              setTab(entry.key);
            }}
          >
            {entry.label}
          </Button>
        ))}
      </div>

      {enquiries.isPending ? (
        <SkeletonList rows={6} label="Loading enquiries" />
      ) : enquiries.isError ? (
        <ProblemCard error={enquiries.error} />
      ) : (
        <WorklistTable
          rows={enquiries.data}
          getRowId={(row) => row.id}
          columns={columns}
          labels={{
            caption: 'Website enquiries',
            scrollRegion: 'Enquiries, scrollable',
            selectAll: 'Select all enquiries',
            selectRow: 'Select enquiry',
            sortAscending: 'Sorted oldest first',
            sortDescending: 'Sorted newest first',
            notSorted: 'Not sorted',
            density: 'Row height',
            densityOption: { compact: 'Compact', default: 'Default', touch: 'Touch' },
            columns: 'Columns',
            savedView: 'Saved view',
            savedViewPlaceholder: 'Choose a view',
            saveView: 'Save this view',
            loadMore: 'Load more',
            loading: 'Loading',
            selectedCount: (count) => `${String(count)} selected`,
            clearSelection: 'Clear selection',
            rowCount: (count) => `${String(count)} enquiries`,
            expandRow: 'Show the rest of this enquiry',
            rowActions: 'Actions',
          }}
          empty={{
            cause:
              tab === 'new'
                ? 'Nobody has left an enquiry through the website assistant yet.'
                : `No enquiries are marked ${tab}.`,
            nextAction:
              tab === 'new'
                ? 'New requests appear here the moment somebody submits one on the public site.'
                : 'Try the New tab, or All to see every enquiry.',
          }}
        />
      )}

      {declining === null ? null : (
        <ConfirmWithReasonDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeclining(null);
          }}
          labels={{
            title: `Decline the enquiry from ${declining.requesterName}?`,
            // The API refuses a decline without a reason, and this says why
            // before the clerk meets the refusal.
            description:
              'Say why. An enquiry that disappears without a reason cannot be told apart from one somebody dropped, and this person is expecting a call back.',
            reasonLabel: 'Reason',
            reasonPlaceholder: 'Choose a reason',
            notePlaceholder: 'e.g. duplicate of an earlier request, or the caller booked elsewhere',
            confirm: 'Decline enquiry',
            cancel: 'Keep it open',
            typedValuePrompt: (expected) => `Type ${expected} to confirm`,
            reasonRequired: 'A reason is required.',
            typedValueMismatch: 'That does not match.',
          }}
          reasonOptions={[
            { code: 'duplicate', label: 'Duplicate of an earlier enquiry' },
            { code: 'unreachable', label: 'Could not reach the caller' },
            { code: 'not_offered', label: 'We do not offer what they asked for' },
            { code: 'booked_elsewhere', label: 'Caller has gone elsewhere' },
            { code: 'spam', label: 'Not a genuine enquiry' },
          ]}
          onConfirm={(result) => {
            const reason = result.reasonText.trim() === '' ? (result.reasonCode ?? '') : result.reasonText;
            decline.mutate({ row: declining, reason });
          }}
        />
      )}
    </div>
  );
}
