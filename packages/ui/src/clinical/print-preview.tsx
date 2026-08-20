'use client';

import { Clock, Printer, PrinterCheck, TriangleAlert } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/button.js';
import { Input, inputClassName } from '../primitives/input.js';
import { Label } from '../primitives/label.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../primitives/select.js';

/**
 * `PrintPreview` — docs/06 §5.2 #35, and the Phase-1 exit gate ("UHID card and
 * wristband print correctly", docs/prompts/phase-01 §Exit gate 1).
 *
 * "Renders the actual print template at scale, printer/target picker (EN-005 agent,
 *  browser fallback), copies, tray, 'print later'; **shows the last print of this
 *  document (who/when/where) to prevent duplicate handouts**."
 *
 * Two behaviours here exist because of what happens on a real counter:
 *
 *  - **The last print is shown, prominently.** Two wristbands on one patient, or two
 *    "original" cash receipts for one payment, are the kind of duplicate that ends in a
 *    dispute. `lastPrint` renders a warning band naming who printed it, when and where.
 *  - **A dead print agent is a designed state, not an error** (docs/06 §1.2.9). When the
 *    agent is disconnected or was never installed, the browser fallback and "print
 *    later" are offered by name — the clerk is never left with a greyed-out button.
 */

export type PaperSize = 'a4' | 'a5' | 'thermal-80' | 'thermal-58' | 'label-50x25' | 'wristband';

/** CSS block/inline sizes of each stock, used to render the preview at true aspect. */
const PAPER_MM: Readonly<Record<PaperSize, { readonly width: number; readonly height: number }>> = {
  a4: { width: 210, height: 297 },
  a5: { width: 148, height: 210 },
  'thermal-80': { width: 80, height: 160 },
  'thermal-58': { width: 58, height: 120 },
  'label-50x25': { width: 50, height: 25 },
  wristband: { width: 280, height: 25 },
};

export type PrinterStatus = 'online' | 'offline' | 'unknown';

export interface PrintTarget {
  readonly id: string;
  /** Already-localised printer name, e.g. "Reception thermal (80 mm)". */
  readonly label: string;
  readonly paper: PaperSize;
  readonly status: PrinterStatus;
  readonly trays?: readonly { readonly id: string; readonly label: string }[];
}

export type PrintAgentState =
  | { readonly kind: 'connected' }
  /** EN-005 agent lost — the browser dialog is the documented fallback. */
  | { readonly kind: 'disconnected'; readonly since: string }
  | { readonly kind: 'not-installed' };

export interface LastPrint {
  /** Who printed it. */
  readonly by: string;
  /** `dd-MM HH:mm` in hospital time (docs/06 §1.2.10). */
  readonly at: string;
  /** Which printer. */
  readonly target: string;
  readonly copies: number;
}

export interface PrintRequest {
  readonly targetId: string;
  readonly trayId?: string;
  readonly copies: number;
  readonly via: 'agent' | 'browser';
}

export interface PrintPreviewLabels {
  readonly region: string;
  readonly previewLabel: string;
  readonly target: string;
  readonly targetPlaceholder: string;
  readonly tray: string;
  readonly copies: string;
  readonly print: string;
  readonly printViaBrowser: string;
  readonly printLater: string;
  readonly agentConnected: string;
  readonly agentDisconnected: (since: string) => string;
  readonly agentNotInstalled: string;
  readonly printerOffline: string;
  readonly lastPrint: (by: string, at: string, target: string, copies: number) => string;
  readonly duplicateWarning: string;
  readonly noTargets: string;
}

export interface PrintPreviewProps {
  /** The actual template markup, rendered at true paper aspect (docs/06 §4.5). */
  readonly children: ReactNode;
  readonly paper: PaperSize;
  readonly targets: readonly PrintTarget[];
  readonly agent: PrintAgentState;
  readonly labels: PrintPreviewLabels;
  readonly onPrint: (request: PrintRequest) => void;
  /** Queues the job for when the printer or the agent comes back. */
  readonly onPrintLater?: (request: Omit<PrintRequest, 'via'>) => void;
  /** §5.2 #35 — surfaced so the same document is not handed out twice. */
  readonly lastPrint?: LastPrint;
  readonly maxCopies?: number;
  readonly className?: string;
}

export function PrintPreview({
  children,
  paper,
  targets,
  agent,
  labels,
  onPrint,
  onPrintLater,
  lastPrint,
  maxCopies = 10,
  className,
}: PrintPreviewProps): React.JSX.Element {
  const fieldId = useId();
  const matching = targets.filter((target) => target.paper === paper);
  const [targetId, setTargetId] = useState<string>(() => matching[0]?.id ?? '');
  const [trayId, setTrayId] = useState<string>('');
  const [copies, setCopies] = useState(1);

  const target = matching.find((candidate) => candidate.id === targetId);
  const agentUsable = agent.kind === 'connected';
  const printerUsable = target !== undefined && target.status !== 'offline';
  const dimensions = PAPER_MM[paper];

  const request = (via: 'agent' | 'browser'): PrintRequest => ({
    targetId,
    copies,
    via,
    ...(trayId === '' ? {} : { trayId }),
  });

  return (
    <section
      data-slot="print-preview"
      data-paper={paper}
      role="group"
      aria-label={labels.region}
      className={cn('flex flex-col gap-3 md:flex-row', className)}
    >
      {/* The preview is the real template at the real aspect ratio — a wristband that
          looks like an A5 in the preview will be trimmed by the printer, not by us. */}
      <div
        role="img"
        aria-label={labels.previewLabel}
        data-paper-preview={paper}
        style={{ aspectRatio: `${String(dimensions.width)} / ${String(dimensions.height)}` }}
        className="w-full max-w-80 overflow-hidden rounded-md border border-strong bg-layer-1 p-2 text-fg-default shadow-e1"
      >
        {children}
      </div>

      <div className="flex min-w-64 flex-1 flex-col gap-3">
        {/* docs/06 §1.2.9 — every degraded mode has a named banner and a named path. */}
        <p
          data-agent-state={agent.kind}
          className={cn(
            'flex items-center gap-2 rounded-md border px-2 py-1 text-xs',
            agentUsable
              ? 'border-success-border bg-success-surface text-success-on-surface'
              : 'border-warning-border bg-warning-surface text-warning-on-surface',
          )}
        >
          {agentUsable ? (
            <PrinterCheck aria-hidden="true" className="size-3" />
          ) : (
            <TriangleAlert aria-hidden="true" className="size-3" />
          )}
          {agent.kind === 'connected'
            ? labels.agentConnected
            : agent.kind === 'disconnected'
              ? labels.agentDisconnected(agent.since)
              : labels.agentNotInstalled}
        </p>

        {lastPrint === undefined ? null : (
          <p
            data-last-print=""
            className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-surface px-2 py-1 text-xs text-warning-on-surface"
          >
            <Clock aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
            <span>
              {labels.lastPrint(lastPrint.by, lastPrint.at, lastPrint.target, lastPrint.copies)}{' '}
              <strong>{labels.duplicateWarning}</strong>
            </span>
          </p>
        )}

        <div className="flex flex-col gap-1">
          <Label htmlFor={`${fieldId}-target`} required>
            {labels.target}
          </Label>
          {matching.length === 0 ? (
            <p className="text-xs text-warning-fg">{labels.noTargets}</p>
          ) : (
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger id={`${fieldId}-target`} aria-required="true">
                <SelectValue placeholder={labels.targetPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {matching.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {target !== undefined && target.status === 'offline' ? (
            <p data-printer-offline="" className="text-xs text-warning-fg">
              {labels.printerOffline}
            </p>
          ) : null}
        </div>

        {target?.trays === undefined || target.trays.length === 0 ? null : (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${fieldId}-tray`}>{labels.tray}</Label>
            <Select value={trayId} onValueChange={setTrayId}>
              <SelectTrigger id={`${fieldId}-tray`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {target.trays.map((tray) => (
                  <SelectItem key={tray.id} value={tray.id}>
                    {tray.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex flex-col gap-1">
          <Label htmlFor={`${fieldId}-copies`}>{labels.copies}</Label>
          <Input
            id={`${fieldId}-copies`}
            type="text"
            inputMode="numeric"
            dir="ltr"
            value={String(copies)}
            className={cn(inputClassName, 'w-24 text-end font-mono tabular-nums')}
            onChange={(event) => {
              const raw = event.target.value.replace(/\D/g, '');
              const parsed = raw === '' ? 1 : Number.parseInt(raw, 10);
              setCopies(Math.min(Math.max(1, parsed), maxCopies));
            }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            data-print="agent"
            disabled={!agentUsable || !printerUsable || targetId === ''}
            onClick={() => {
              onPrint(request('agent'));
            }}
          >
            <Printer aria-hidden="true" />
            {labels.print}
          </Button>
          {/* Always available: the browser dialog is the documented fallback, so a dead
              agent never stops a patient walking out with their card. */}
          <Button
            variant="secondary"
            data-print="browser"
            onClick={() => {
              onPrint(request('browser'));
            }}
          >
            {labels.printViaBrowser}
          </Button>
          {onPrintLater === undefined ? null : (
            <Button
              variant="ghost"
              data-print="later"
              disabled={targetId === ''}
              onClick={() => {
                onPrintLater({ targetId, copies, ...(trayId === '' ? {} : { trayId }) });
              }}
            >
              {labels.printLater}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
