import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalTimeline, type ApprovalTimelineLabels } from '../clinical/approval-timeline.js';
import { AuditDiffViewer, type AuditDiffViewerLabels } from '../clinical/audit-diff-viewer.js';
import { EmptyState } from '../clinical/empty-state.js';
import { ErrorBoundaryCard, type ErrorBoundaryCardLabels } from '../clinical/error-boundary-card.js';
import { OfflineBadge, type OfflineBadgeLabels } from '../clinical/offline-badge.js';
import { SkeletonList } from '../clinical/skeleton-list.js';
import { findAccessibilityViolations } from './axe.js';

describe('EmptyState — docs/06 §5.2 #36', () => {
  it('states the cause and the next action, never "No data"', async () => {
    const onSelect = vi.fn();
    const { container } = render(
      <EmptyState
        cause="No patients waiting"
        nextAction="Next appointment 10:30"
        action={{ label: 'Register a walk-in', onSelect }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('No patients waiting');
    expect(screen.getByRole('status')).toHaveTextContent('Next appointment 10:30');
    const button = screen.getByRole('button', { name: 'Register a walk-in' });
    button.focus();
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalled();
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});

describe('SkeletonList — docs/06 §5.2 #37', () => {
  it('matches the real row height and announces that it is busy', async () => {
    const { container } = render(<SkeletonList label="Loading worklist" rows={4} rowHeight="touch" />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveTextContent('Loading worklist');
    const rows = container.querySelectorAll('[data-slot="skeleton-list"] > div');
    expect(rows).toHaveLength(4);
    expect(rows[0]?.className).toContain('h-13');
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});

const ERROR_LABELS: ErrorBoundaryCardLabels = {
  title: 'This panel could not load',
  body: 'The rest of the screen is still usable.',
  referencePrefix: 'Reference',
  retry: 'Retry',
  copyDiagnostics: 'Copy diagnostics',
  reportToIt: 'Report to IT',
};

function Boom(): React.JSX.Element {
  throw new Error('kaboom: patient MRN 0021-45871 in the message');
}

describe('ErrorBoundaryCard — docs/06 §5.2 #38', () => {
  it('contains the failure, shows the reference id and never leaks the message or stack', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onReport = vi.fn();
    const { container } = render(
      <ErrorBoundaryCard labels={ERROR_LABELS} reference="req_01J8ZK" onReport={onReport}>
        <Boom />
      </ErrorBoundaryCard>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('This panel could not load');
    expect(screen.getByText(/Reference req_01J8ZK/)).toBeInTheDocument();
    // The thrown message contained an identifier; it must not reach the DOM.
    expect(container.textContent).not.toContain('0021-45871');
    expect(container.textContent).not.toContain('kaboom');

    fireEvent.click(screen.getByRole('button', { name: 'Report to IT' }));
    expect(onReport).toHaveBeenCalledWith(
      expect.objectContaining({ reference: 'req_01J8ZK', errorName: 'Error' }),
    );
    spy.mockRestore();
  });
});

const OFFLINE_LABELS: OfflineBadgeLabels = {
  online: 'Live',
  degraded: 'Slow connection',
  offline: (queued) => `Offline — ${String(queued)} queued`,
  syncing: (done, total) => `Syncing ${String(done)}/${String(total)}`,
  conflict: (conflicts) => `${String(conflicts)} conflicts`,
  openQueue: 'Open the offline queue',
};

describe('OfflineBadge — docs/06 §5.2 #34', () => {
  it('renders every state as role=status with a text label, not colour alone', () => {
    const states = [
      { state: { kind: 'online' } as const, text: 'Live' },
      { state: { kind: 'degraded' } as const, text: 'Slow connection' },
      { state: { kind: 'offline', queued: 3 } as const, text: 'Offline — 3 queued' },
      { state: { kind: 'syncing', done: 2, total: 5 } as const, text: 'Syncing 2/5' },
      { state: { kind: 'conflict', conflicts: 1 } as const, text: '1 conflicts' },
    ];
    for (const { state, text } of states) {
      const { unmount } = render(<OfflineBadge state={state} labels={OFFLINE_LABELS} />);
      expect(screen.getByRole('status')).toHaveTextContent(text);
      unmount();
    }
  });

  it('opens the queue from the keyboard when a handler is supplied', () => {
    const onOpenQueue = vi.fn();
    render(
      <OfflineBadge state={{ kind: 'offline', queued: 2 }} labels={OFFLINE_LABELS} onOpenQueue={onOpenQueue} />,
    );
    const button = screen.getByRole('status');
    expect(button.tagName).toBe('BUTTON');
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onOpenQueue).toHaveBeenCalled();
  });
});

const AUDIT_LABELS: AuditDiffViewerLabels = {
  region: 'History',
  fieldColumn: 'Field',
  beforeColumn: 'Before',
  afterColumn: 'After',
  emptyValue: 'not set',
  reasonPrefix: 'Reason:',
  chainVerified: 'Chain verified',
  chainBroken: 'Chain broken',
  byline: (actor, role, at) => `${actor} (${role}) · ${at}`,
};

describe('AuditDiffViewer — docs/06 §5.2 #29', () => {
  it('strikes the old value, emphasises the new one and shows the chain chip', async () => {
    const { container } = render(
      <AuditDiffViewer
        labels={AUDIT_LABELS}
        entry={{
          id: 'a1',
          actorName: 'Dr A. Menon',
          actorRole: 'Consultant',
          at: '18-08-2026 14:07',
          ipAddress: '10.0.4.19',
          device: 'WS-OPD-03',
          reason: 'Amended after review',
          hashChainVerified: true,
          hashPrefix: '9f3c…',
          changes: [
            { field: 'Diagnosis', before: 'Sprain', after: 'Fracture, distal radius' },
            { field: 'Weight', before: null, after: '72' },
          ],
        }}
      />,
    );
    expect(container.querySelector('del[data-diff="before"]')).toHaveTextContent('Sprain');
    expect(container.querySelector('ins[data-diff="after"]')).toHaveTextContent('Fracture, distal radius');
    expect(container.querySelector('[data-chain-verified="true"]')).toHaveTextContent('Chain verified');
    expect(screen.getByText('Reason: Amended after review')).toBeInTheDocument();
    // Read-only: no control of any kind in an audit entry.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});

const APPROVAL_LABELS: ApprovalTimelineLabels = {
  region: 'Approval history',
  decision: {
    pending: 'Pending',
    approved: 'Approved',
    rejected: 'Rejected',
    escalated: 'Escalated',
    withdrawn: 'Withdrawn',
  },
  reasonPrefix: 'Reason:',
  slaBreached: 'SLA breached',
};

describe('ApprovalTimeline — docs/06 §5.2 #28', () => {
  it('renders steps with actor, decision and SLA, and an action on the pending step', async () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ApprovalTimeline
        labels={APPROVAL_LABELS}
        action={{ label: 'Approve', onSelect }}
        steps={[
          {
            id: 's1',
            title: 'Ward sister',
            actorName: 'S. Rani',
            actorRole: 'Nurse',
            at: '18-08 12:00',
            decision: 'approved',
          },
          {
            id: 's2',
            title: 'Billing manager',
            decision: 'pending',
            sla: '12 m left',
            branch: [{ id: 's2a', title: 'Escalated to CFO', decision: 'escalated' }],
          },
        ]}
      />,
    );

    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('12 m left')).toBeInTheDocument();
    expect(screen.getByText('Escalated')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="approval-step"]')).toHaveLength(3);

    const button = screen.getByRole('button', { name: 'Approve' });
    button.focus();
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith('s2');
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});
