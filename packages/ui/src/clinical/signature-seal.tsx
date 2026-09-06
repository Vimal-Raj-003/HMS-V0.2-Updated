import { BadgeCheck, FileClock, FilePen, FileX2, ShieldCheck } from 'lucide-react';
import { cn } from '../lib/cn.js';

/**
 * `SignatureSeal` — docs/06 §5.2 #40: "Document status seal: Draft / Final v_n /
 * Amended / Cancelled, signer name + reg no + method + timestamp, hash chip,
 * verify link."
 *
 * The seal answers one question — *can I act on this document?* — and the
 * answer has to be unambiguous at a glance, because the alternative is a
 * clinician acting on a draft result or an amended note whose earlier version
 * they have already read.
 *
 * `docs/PROGRESS.md` records the storage-side guarantee this renders:
 * `seal_document_version()` computes the content hash from the content and takes
 * the previous hash from the actual preceding row, so neither is accepted from
 * the caller and the chain cannot be forged or re-linked. The `hash` shown here
 * is therefore a real fingerprint of the sealed bytes, not a decorative chip —
 * which is why it is rendered in full on hover/focus rather than only truncated.
 *
 * A `draft` has no signer, and the union enforces that: there is no way to
 * render a draft that looks signed, and no way to render a final version with
 * nobody's name on it.
 */

export type DocumentSeal =
  /** Not signed. Never actionable, and it says so. */
  | { readonly kind: 'draft' }
  | {
      readonly kind: 'final';
      /** 1-based. §5.2 #40's "Final v_n". */
      readonly version: number;
      readonly signer: Signer;
      readonly hash: string;
    }
  | {
      readonly kind: 'amended';
      readonly version: number;
      readonly signer: Signer;
      readonly hash: string;
      /** Why the earlier version was superseded. Required — an amendment with no reason is not one. */
      readonly reason: string;
    }
  | {
      readonly kind: 'cancelled';
      readonly version: number;
      readonly signer: Signer;
      readonly reason: string;
    };

export interface Signer {
  readonly name: string;
  /** Council registration number — the identity that makes a signature legal. */
  readonly registrationNo: string;
  /** How the signature was made, e.g. "password + OTP", "Aadhaar eSign". */
  readonly method: string;
  /** Already localised and formatted, e.g. "2 Sep 2026, 14:02 IST". */
  readonly signedAt: string;
}

export interface SignatureSealLabels {
  readonly draft: string;
  /** e.g. "Final v{n}" — `{n}` is substituted. */
  readonly final: string;
  /** e.g. "Amended v{n}". */
  readonly amended: string;
  /** e.g. "Cancelled". */
  readonly cancelled: string;
  readonly signedBy: string;
  readonly registrationNo: string;
  readonly method: string;
  readonly hash: string;
  readonly reason: string;
  /** Accessible name for the verify action, e.g. "Verify this signature". */
  readonly verify?: string;
  /** Draft's warning line, e.g. "Not signed. Do not act on this document." */
  readonly draftWarning: string;
}

export interface SignatureSealProps {
  readonly seal: DocumentSeal;
  readonly labels: SignatureSealLabels;
  /** §5.2 #40 — the verify link. Omitted where verification is not offered. */
  readonly onVerify?: () => void;
  readonly className?: string;
}

/**
 * Every pair is a semantic surface with its own foreground. Nothing here fades
 * text with `opacity`: the axe scan in `design-system.spec.ts` failed on exactly
 * that — `text-*-on-surface` at 70 % against its own surface drops under 4.5:1,
 * and the reason the token layer ships `-surface`/`-on-surface` as a *pair* is so
 * that hierarchy is expressed with size and weight instead.
 */
const STYLE = {
  draft: { container: 'border-warning-border bg-warning-surface text-warning-on-surface', Icon: FilePen },
  final: { container: 'border-success-border bg-success-surface text-success-on-surface', Icon: BadgeCheck },
  amended: { container: 'border-accent-border bg-accent-surface text-accent-on-surface', Icon: FileClock },
  cancelled: { container: 'border-danger-border bg-danger-surface text-danger-on-surface', Icon: FileX2 },
} as const;

export function SignatureSeal({ seal, labels, onVerify, className }: SignatureSealProps): React.JSX.Element {
  const style = STYLE[seal.kind];
  const status =
    seal.kind === 'draft'
      ? labels.draft
      : seal.kind === 'final'
        ? labels.final.replace('{n}', String(seal.version))
        : seal.kind === 'amended'
          ? labels.amended.replace('{n}', String(seal.version))
          : labels.cancelled;

  return (
    <section
      data-slot="signature-seal"
      data-kind={seal.kind}
      aria-label={status}
      className={cn('rounded-lg border p-3', style.container, className)}
    >
      <p className="m-0 flex items-center gap-1.5 text-sm font-semibold">
        <style.Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={2.25} />
        {status}
      </p>

      {seal.kind === 'draft' ? (
        // The one state with no signer. It says what not to do, because "Draft"
        // alone is a label and this needs to be an instruction.
        <p className="m-0 mt-1 text-xs">{labels.draftWarning}</p>
      ) : (
        <dl className="m-0 mt-2 grid gap-1 text-xs">
          <div className="flex flex-wrap gap-x-1.5">
            <dt className="font-normal">{labels.signedBy}</dt>
            <dd className="m-0 font-medium">{seal.signer.name}</dd>
            <dd className="m-0 font-mono">
              {labels.registrationNo} {seal.signer.registrationNo}
            </dd>
          </div>
          <div className="flex flex-wrap gap-x-1.5">
            <dt className="font-normal">{labels.method}</dt>
            <dd className="m-0">{seal.signer.method}</dd>
            <dd className="m-0 font-mono tabular-nums">{seal.signer.signedAt}</dd>
          </div>
          {'reason' in seal ? (
            <div className="flex flex-wrap gap-x-1.5">
              <dt className="font-normal">{labels.reason}</dt>
              <dd className="m-0">{seal.reason}</dd>
            </div>
          ) : null}
          {'hash' in seal ? (
            <div className="flex flex-wrap items-baseline gap-x-1.5">
              <dt className="font-normal">{labels.hash}</dt>
              {/*
                Truncated for the eye, complete for the clipboard and the screen
                reader. A hash that only ever appears as "a1b2c3…" cannot be
                compared against anything, which is the only thing a hash is for.
              */}
              <dd className="m-0 max-w-full truncate font-mono text-2xs" title={seal.hash}>
                {seal.hash}
              </dd>
            </div>
          ) : null}
        </dl>
      )}

      {onVerify === undefined || labels.verify === undefined ? null : (
        <button
          type="button"
          onClick={onVerify}
          className="focus-visible:outline-focus mt-2 inline-flex items-center gap-1 rounded text-xs font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <ShieldCheck aria-hidden="true" className="size-3.5" />
          {labels.verify}
        </button>
      )}
    </section>
  );
}
