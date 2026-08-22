'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  QueueList,
  SkeletonList,
  TokenDisplay,
  useToast,
  type ConfirmWithReasonLabels,
  type QueueEntry,
  type QueueListLabels,
  type TokenDisplayLabels,
} from '@vims/ui';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import {
  callNext,
  completeToken,
  issueToken,
  listTokens,
  readBoard,
  recallToken,
  skipToken,
  transferToken,
} from '../api/client';
import { frontOfficeKeys } from '../api/keys';
import type { TokenView } from '../api/types';
import { SKIP_REASONS, TRANSFER_REASONS, buildQueueEntries, currentlyServing } from '../lib/queue-console';
import { useRemembered } from '../lib/remembered';
import { useShortcuts, type Shortcut } from '../lib/shortcuts';
import { dayKeyOf, secondsBetween } from '../lib/time';
import { ActionUnavailable } from './frontoffice-gate';
import { ContextField, isIdentifier } from './context-field';
import { ShortcutBar } from './keyboard-sheet';

/**
 * The queue console — EN-006 §8 "Reception Queue Console" and "Counter Console",
 * `docs/prompts/phase-01` §1.5.
 *
 * **Nothing on this screen is licence-gated, and that is a safety decision, not
 * an oversight.** `queue.token.issue` and `queue.board.read` are flagged
 * `clinicalSafetyExempt` in the permission catalogue precisely so that an unpaid
 * invoice or a degraded tier can never stop a hospital handing out a token or
 * showing who is next; calling is on the same path, because a queue that can be
 * joined and displayed but not called is a waiting room that never moves. So this
 * file imports no flag, reads no entitlement, and `screens.ts` records the
 * queue's entitlement as `null`.
 *
 * It is built for one hand at a counter. `Space` calls the next token from
 * anywhere in the list, the arrow keys walk it with a single tab stop, and F9 /
 * F10 / F11 are the bindings EN-006 §8 names — each with an `Alt` alias, because
 * a browser will not always give up F11.
 *
 * **A skip is never silent** (EN-006 §3.3): it goes through the hard-stop reason
 * dialog, the reason travels in the body *and* as the `x-reason` header, and the
 * actor is the session the API resolves for itself.
 */

const POLL_MS = 5_000;

const QUEUE_LABELS: QueueListLabels = {
  listLabel: 'Tokens in this queue',
  state: {
    waiting: 'Waiting',
    called: 'Called',
    'in-progress': 'In service',
    'on-hold': 'On hold',
    skipped: 'Skipped',
    completed: 'Done',
    'no-show': 'Did not attend',
  },
  priority: {
    emergency: 'Emergency',
    'senior-citizen': 'Priority lane',
    'differently-abled': 'Differently abled',
    appointment: 'Appointment',
    'walk-in': 'Walk-in',
  },
  positionPrefix: 'Position',
  roomPrefix: 'At',
  reasonPrefix: 'Reason:',
  waited: (minutes) => `Waiting ${String(minutes)} min`,
  estimated: (minutes) => `Est. ${String(minutes)} min more`,
  tokenSummary: (entry) => summariseToken(entry),
  callNext: 'Call next',
  callSelected: 'Call this one',
  recall: 'Recall',
  hold: 'Hold',
  skip: 'Skip',
  transfer: 'Transfer',
  nothingWaiting: 'Nobody is waiting.',
  counts: (waiting, called) => `${String(waiting)} waiting · ${String(called)} called`,
};

function summariseToken(entry: QueueEntry): string {
  const state = QUEUE_LABELS.state[entry.state.kind];
  const detail =
    entry.state.kind === 'waiting'
      ? `position ${String(entry.state.position)}`
      : entry.state.kind === 'skipped' || entry.state.kind === 'on-hold'
        ? entry.state.reason
        : '';
  return `Token ${entry.token}, ${entry.maskedLabel}, ${state}${detail === '' ? '' : `, ${detail}`}, waiting ${String(entry.waitedMinutes)} minutes`;
}

const BOARD_LABELS: TokenDisplayLabels = {
  region: 'Now serving',
  nowServing: 'Now serving',
  next: 'Next',
  roomPrefix: 'At',
  waiting: (count) => `${String(count)} waiting`,
  averageWait: (minutes) => `Average wait ${String(minutes)} min`,
  idle: 'No token has been called yet.',
  live: 'Live',
  stale: (lastUpdated) => `Last updated ${lastUpdated}`,
  expired: (lastUpdated) => `Out of date since ${lastUpdated}`,
  announcement: (token, room) => `Token ${token}, please go to ${room}.`,
};

const SKIP_LABELS: ConfirmWithReasonLabels = {
  title: 'Skip this token?',
  description:
    'The patient loses their turn and is put back for a later call. EN-006 requires a reason, and it is recorded against your name.',
  reasonLabel: 'Why is it being skipped',
  reasonPlaceholder: 'Choose a reason',
  notePlaceholder: 'What happened, in one line',
  confirm: 'Skip the token',
  cancel: 'Keep the turn',
  typedValuePrompt: (expected) => `Type ${expected} to confirm`,
  reasonRequired: 'A reason is required.',
  typedValueMismatch: 'That does not match.',
};

const TRANSFER_LABELS: ConfirmWithReasonLabels = {
  ...SKIP_LABELS,
  title: 'Transfer this token?',
  description:
    'The token leaves this queue and joins another one. Transfers need a supervisor’s permission and a reason.',
  reasonLabel: 'Why is it being moved',
  confirm: 'Transfer the token',
  cancel: 'Keep it here',
};

export function QueueConsoleScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = frontOfficeKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const [queueId, setQueueId] = useRemembered(hospitalId, 'queue');
  const [counterId, setCounterId] = useRemembered(hospitalId, 'counter');
  const [servingId, setServingId] = useState<string | null>(null);
  const [skipping, setSkipping] = useState<QueueEntry | null>(null);
  const [transferring, setTransferring] = useState<QueueEntry | null>(null);
  const [transferTarget, setTransferTarget] = useState('');
  // Two steps on purpose: the destination is a fact, the reason is a
  // justification, and `queue.token.manage` refuses the call without the latter.
  const [transferConfirming, setTransferConfirming] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [now, setNow] = useState(() => new Date());
  // Reasons this console has just submitted, so a skipped tile is truthful
  // immediately rather than falling back to "recorded in the audit trail".
  const [reasons, setReasons] = useState<ReadonlyMap<string, string>>(() => new Map());

  const canIssue = granted.has('queue.token.issue');
  const canCall = granted.has('queue.token.call');
  const canManage = granted.has('queue.token.manage');
  const canReadBoard = granted.has('queue.board.read');

  const ready = isIdentifier(queueId);
  const today = dayKeyOf(now);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const tokensQuery = useQuery({
    queryKey: keys.queueTokens(queueId, today),
    queryFn: ({ signal }) => listTokens({ queueId, date: today }, { signal }),
    enabled: ready,
    refetchInterval: POLL_MS,
  });

  const boardQuery = useQuery({
    queryKey: keys.queueBoard(queueId),
    queryFn: ({ signal }) => readBoard(queueId, { signal }),
    enabled: ready && canReadBoard,
    refetchInterval: POLL_MS,
  });

  const tokens: readonly TokenView[] = tokensQuery.data?.items ?? [];
  const entries = buildQueueEntries(tokens, { now, knownReasons: reasons });
  const serving = currentlyServing(tokens, servingId);
  const board = boardQuery.data ?? null;

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: keys.queue() });
  };

  const remember = (tokenId: string, reason: string): void => {
    setReasons((current) => new Map(current).set(tokenId, reason));
  };

  const call = useMutation({
    mutationFn: () => callNext(queueId, counterId === '' ? {} : { counterId }),
    onSuccess: (token) => {
      setServingId(token.id);
      invalidate();
      publish({
        title: `Calling ${token.token_display}`,
        description: 'The board and the announcement have been updated.',
        severity: 'success',
      });
    },
  });

  const recall = useMutation({
    mutationFn: (tokenId: string) => recallToken(tokenId),
    onSuccess: (token) => {
      setServingId(token.id);
      invalidate();
      publish({ title: `Recalled ${token.token_display}`, severity: 'info' });
    },
  });

  const skip = useMutation({
    mutationFn: (input: { readonly tokenId: string; readonly reason: string }) =>
      skipToken(input.tokenId, input.reason),
    onSuccess: (token, input) => {
      remember(token.id, input.reason);
      setSkipping(null);
      invalidate();
      publish({
        title: `Skipped ${token.token_display}`,
        description: input.reason,
        severity: 'warning',
      });
    },
  });

  const complete = useMutation({
    mutationFn: (tokenId: string) => completeToken(tokenId),
    onSuccess: (token) => {
      if (servingId === token.id) setServingId(null);
      invalidate();
      publish({ title: `Completed ${token.token_display}`, severity: 'success' });
    },
  });

  const transfer = useMutation({
    mutationFn: (input: { readonly tokenId: string; readonly toQueueId: string; readonly reason: string }) =>
      transferToken(input.tokenId, input.toQueueId, input.reason),
    onSuccess: (token, input) => {
      remember(token.id, input.reason);
      setTransferring(null);
      setTransferTarget('');
      setTransferConfirming(false);
      invalidate();
      publish({ title: `Transferred ${token.token_display}`, severity: 'info' });
    },
  });

  const issue = useMutation({
    mutationFn: () => issueToken({ queueId, source: 'desk' }),
    onSuccess: (token) => {
      setIssuing(false);
      invalidate();
      publish({
        title: `Token ${token.token_display}`,
        description: 'Hand the slip to the patient.',
        severity: 'success',
      });
    },
  });

  const shortcuts: readonly Shortcut[] = useMemo(
    () => [
      {
        key: 'F9',
        label: 'Call next',
        keys: ['F9'],
        enabled: canCall,
        run: () => {
          call.mutate();
        },
      },
      {
        key: 'n',
        alt: true,
        label: 'Call next',
        keys: ['Alt', 'N'],
        enabled: canCall,
        run: () => {
          call.mutate();
        },
      },
      {
        key: 'F10',
        label: 'Recall',
        keys: ['F10'],
        enabled: canCall,
        run: () => {
          if (serving !== null) recall.mutate(serving.id);
        },
      },
      {
        key: 'r',
        alt: true,
        label: 'Recall',
        keys: ['Alt', 'R'],
        enabled: canCall,
        run: () => {
          if (serving !== null) recall.mutate(serving.id);
        },
      },
      {
        key: 'F8',
        label: 'Complete',
        keys: ['F8'],
        enabled: canCall,
        run: () => {
          if (serving !== null) complete.mutate(serving.id);
        },
      },
      {
        key: 'c',
        alt: true,
        label: 'Complete',
        keys: ['Alt', 'C'],
        enabled: canCall,
        run: () => {
          if (serving !== null) complete.mutate(serving.id);
        },
      },
      {
        key: 'F2',
        label: 'Issue a token',
        keys: ['F2'],
        enabled: canIssue,
        run: () => {
          setIssuing(true);
        },
      },
    ],
    [canCall, canIssue, call, recall, complete, serving],
  );

  useShortcuts(shortcuts);

  const servingEntry = serving === null ? null : entries.find((entry) => entry.tokenId === serving.id);

  return (
    <section className="flex flex-col gap-4" data-testid="queue-console">
      <PageHeader
        eyebrow="Front office"
        title="Queue console"
        description="The live queue at this counter. Space calls the next token from anywhere in the list; a skip always asks why."
        primaryAction={
          canCall ? (
            <Button
              variant="primary"
              data-testid="call-next"
              disabled={!ready || call.isPending}
              onClick={() => {
                call.mutate();
              }}
            >
              Call next
            </Button>
          ) : undefined
        }
        actions={
          canIssue ? (
            <Button
              variant="secondary"
              data-testid="issue-token"
              disabled={!ready}
              onClick={() => {
                setIssuing(true);
              }}
            >
              Issue token
            </Button>
          ) : undefined
        }
        meta={
          board === null ? null : (
            <>
              <Badge tone="neutral">{board.queueName}</Badge>
              <Badge tone="info">{board.waiting} waiting</Badge>
              <Badge tone="success">{board.served} served</Badge>
            </>
          )
        }
      />

      <div className="flex flex-wrap items-end gap-4">
        <ContextField
          label="Queue"
          testId="queue-id"
          hint="The queue this counter serves. Remembered on this device."
          value={queueId}
          onChange={setQueueId}
        />
        <ContextField
          label="Counter (optional)"
          testId="counter-id"
          hint="Recorded against every call, so the board can say which window to go to."
          value={counterId}
          onChange={setCounterId}
        />
      </div>

      {!ready ? (
        <EmptyState
          cause="No queue chosen, so there is nothing to call from."
          nextAction="Paste the queue identifier above. This counter will remember it."
        />
      ) : (
        <>
          {canReadBoard && board !== null ? (
            <TokenDisplay
              nowServing={
                board.nowServing[0] === undefined
                  ? null
                  : {
                      token: board.nowServing[0].tokenDisplay,
                      room: board.nowServing[0].roomKey ?? board.nowServing[0].counterId ?? 'the counter',
                      secondsSinceCall:
                        serving?.called_at == null ? 0 : secondsBetween(new Date(serving.called_at), now),
                    }
              }
              next={board.next.map((entry) => ({
                token: entry.tokenDisplay,
                room: entry.roomKey ?? entry.counterId ?? '—',
              }))}
              labels={BOARD_LABELS}
              waitingCount={board.waiting}
              averageWaitMinutes={Math.round(board.avgWaitSeconds / 60)}
              freshness={{ kind: 'live' }}
            />
          ) : null}

          {serving === null ? null : (
            <div
              data-testid="now-serving-actions"
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent-border bg-accent-surface p-3"
            >
              <p className="text-md text-accent-on-surface">
                You are serving <span className="font-mono font-semibold">{serving.token_display}</span>
                {servingEntry === undefined || servingEntry === null
                  ? null
                  : ` · ${servingEntry.maskedLabel}`}
              </p>
              <div className="flex flex-wrap gap-2">
                {canCall ? (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      data-testid="recall-serving"
                      disabled={recall.isPending}
                      onClick={() => {
                        recall.mutate(serving.id);
                      }}
                    >
                      Recall
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      data-testid="complete-serving"
                      disabled={complete.isPending}
                      onClick={() => {
                        complete.mutate(serving.id);
                      }}
                    >
                      Complete
                    </Button>
                  </>
                ) : (
                  <ActionUnavailable
                    title="You can see this queue but not work it"
                    because="Calling, recalling and completing a token belong to whoever runs the room or the counter."
                    permission="queue.token.call"
                  />
                )}
              </div>
            </div>
          )}

          {tokensQuery.error !== null ? (
            <ProblemCard error={tokensQuery.error} onRetry={invalidate} />
          ) : tokensQuery.isPending ? (
            <SkeletonList label="Loading the queue" rows={6} columns={[1, 4, 2]} />
          ) : entries.length === 0 ? (
            <EmptyState
              cause="Nobody is waiting in this queue."
              nextAction={
                canIssue
                  ? 'Issue a token when the next patient arrives at the desk.'
                  : 'Tokens issued at the desk or the kiosk will appear here within a few seconds.'
              }
              {...(canIssue
                ? {
                    action: {
                      label: 'Issue a token',
                      onSelect: () => {
                        setIssuing(true);
                      },
                    },
                  }
                : {})}
            />
          ) : (
            <QueueList
              entries={entries}
              labels={QUEUE_LABELS}
              {...(canCall
                ? {
                    onCallNext: () => {
                      call.mutate();
                    },
                    onRecall: (entry: QueueEntry) => {
                      recall.mutate(entry.tokenId);
                    },
                    onSkipRequested: (entry: QueueEntry) => {
                      setSkipping(entry);
                    },
                  }
                : {})}
              {...(canManage
                ? {
                    onTransferRequested: (entry: QueueEntry) => {
                      setTransferring(entry);
                    },
                  }
                : {})}
            />
          )}

          {!canCall ? (
            <ActionUnavailable
              title="This console is read-only for you"
              because="Reading a queue and working it are separate grants. Calling is scoped to the queues you run, which is why it is not given to everyone who can see the board."
              permission="queue.token.call"
            />
          ) : null}
          {canCall && !canManage ? (
            <ActionUnavailable
              title="Transfers are not yours to make"
              because="Moving a token to another queue changes somebody else's workload, so it sits with a supervisor and always carries a reason."
              permission="queue.token.manage"
            />
          ) : null}
        </>
      )}

      {call.error !== null ? <ProblemCard error={call.error} /> : null}
      {complete.error !== null ? <ProblemCard error={complete.error} /> : null}
      {recall.error !== null ? <ProblemCard error={recall.error} /> : null}
      {skip.error !== null ? <ProblemCard error={skip.error} /> : null}
      {transfer.error !== null ? <ProblemCard error={transfer.error} /> : null}
      {issue.error !== null ? <ProblemCard error={issue.error} /> : null}

      <ConfirmWithReasonDialog
        open={skipping !== null}
        onOpenChange={(next) => {
          if (!next) setSkipping(null);
        }}
        labels={SKIP_LABELS}
        reasonOptions={SKIP_REASONS.map((reason) => ({ ...reason }))}
        onConfirm={(result) => {
          if (skipping === null) return;
          const text =
            result.reasonText.length > 0
              ? `${result.reasonCode ?? 'other'}: ${result.reasonText}`
              : (result.reasonCode ?? 'other');
          skip.mutate({ tokenId: skipping.tokenId, reason: text });
        }}
      />

      <Dialog
        open={transferring !== null && !transferConfirming}
        onOpenChange={(next) => {
          if (!next) {
            setTransferring(null);
            setTransferTarget('');
          }
        }}
      >
        <DialogContent closeLabel="Close">
          <DialogHeader>
            <DialogTitle>Transfer {transferring?.token ?? ''}</DialogTitle>
            <DialogDescription>
              Choose the queue it should join. The reason is asked next and is required.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-1">
              <Label htmlFor="transfer-target" required>
                Destination queue
              </Label>
              <Input
                id="transfer-target"
                data-testid="transfer-target"
                value={transferTarget}
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs"
                onChange={(event) => {
                  setTransferTarget(event.target.value);
                }}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setTransferring(null);
                setTransferTarget('');
              }}
            >
              Keep it here
            </Button>
            <Button
              variant="primary"
              data-testid="transfer-next"
              disabled={!isIdentifier(transferTarget)}
              onClick={() => {
                setTransferConfirming(true);
              }}
            >
              Next: the reason
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmWithReasonDialog
        open={transferConfirming}
        onOpenChange={(next) => {
          if (!next) setTransferConfirming(false);
        }}
        labels={TRANSFER_LABELS}
        reasonOptions={TRANSFER_REASONS.map((reason) => ({ ...reason }))}
        onConfirm={(result) => {
          if (transferring === null) return;
          const text =
            result.reasonText.length > 0
              ? `${result.reasonCode ?? 'other'}: ${result.reasonText}`
              : (result.reasonCode ?? 'other');
          transfer.mutate({
            tokenId: transferring.tokenId,
            toQueueId: transferTarget.trim(),
            reason: text,
          });
        }}
      />

      <Dialog
        open={issuing}
        onOpenChange={(next) => {
          if (!next) setIssuing(false);
        }}
      >
        <DialogContent closeLabel="Close">
          <DialogHeader>
            <DialogTitle>Issue a token</DialogTitle>
            <DialogDescription>
              A walk-in token on this queue, from this desk. Issuing is never blocked by a licence or a
              degraded tier — a hospital must always be able to hand out a number.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setIssuing(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              data-testid="issue-confirm"
              disabled={issue.isPending}
              onClick={() => {
                issue.mutate();
              }}
            >
              Issue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ShortcutBar shortcuts={shortcuts} label="Queue console shortcuts" />
    </section>
  );
}
