'use client';

import { Eraser, PenLine } from 'lucide-react';
import { useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/button.js';

/**
 * `SignaturePad` — docs/06 §5.1, used by `ConsentCapture` (§5.2 #19) and later by the
 * discharge/DAMA and blood-consent flows.
 *
 * Drawn with **SVG polylines, not a canvas**. Three reasons, in order of importance:
 *   1. the strokes stay in the DOM, so "has the patient actually signed?" is answerable
 *      without reading pixels back — the submit gate can be honest;
 *   2. the exported `data:` URL is deterministic and vector, so the same signature
 *      prints crisply on an 80 mm thermal receipt and on an A4 consent form;
 *   3. it works everywhere — a locked-down kiosk browser that blocks canvas readback
 *      would silently produce a blank signature.
 *
 * Drawing is a pointer gesture and has no keyboard equivalent, which is exactly why
 * `ConsentCapture` never offers this as the only attestation method (WCAG 2.2 SC 2.1.1
 * is satisfied at the flow level: OTP and witnessed attestation are keyboard-only paths).
 */

export interface SignatureStrokePoint {
  readonly x: number;
  readonly y: number;
}

export type SignatureStroke = readonly SignatureStrokePoint[];

export interface SignaturePadLabels {
  readonly label: string;
  readonly hint: string;
  readonly clear: string;
  /** Announced once the first stroke lands, e.g. "Signature captured". */
  readonly captured: string;
  readonly empty: string;
}

export interface SignaturePadProps {
  readonly labels: SignaturePadLabels;
  /** Fires on every completed stroke with the serialised SVG `data:` URL, or `null`. */
  readonly onChange: (dataUrl: string | null) => void;
  readonly width?: number;
  readonly height?: number;
  readonly disabled?: boolean;
  readonly className?: string;
}

/** Serialises strokes to an inline SVG `data:` URL. Pure — exported for the tests. */
export function strokesToDataUrl(
  strokes: readonly SignatureStroke[],
  width: number,
  height: number,
): string | null {
  const drawn = strokes.filter((stroke) => stroke.length > 0);
  if (drawn.length === 0) return null;
  const paths = drawn
    .map((stroke) => {
      const points = stroke.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
      return `<polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}" width="${String(width)}" height="${String(height)}" color="black">${paths}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function SignaturePad({
  labels,
  onChange,
  width = 480,
  height = 160,
  disabled = false,
  className,
}: SignaturePadProps): React.JSX.Element {
  const padId = useId();
  const surfaceRef = useRef<SVGSVGElement | null>(null);
  const [strokes, setStrokes] = useState<readonly SignatureStroke[]>([]);
  const [drawing, setDrawing] = useState(false);

  const pointFrom = (event: ReactPointerEvent<SVGSVGElement>): SignatureStrokePoint => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    const scaleX = rect !== undefined && rect.width > 0 ? width / rect.width : 1;
    const scaleY = rect !== undefined && rect.height > 0 ? height / rect.height : 1;
    return { x: (event.clientX - left) * scaleX, y: (event.clientY - top) * scaleY };
  };

  const commit = (next: readonly SignatureStroke[]): void => {
    setStrokes(next);
    onChange(strokesToDataUrl(next, width, height));
  };

  const hasSignature = strokes.some((stroke) => stroke.length > 0);

  return (
    <div data-slot="signature-pad" className={cn('flex flex-col gap-1', className)}>
      <span id={`${padId}-label`} className="text-md font-medium text-fg-default">
        {labels.label}
      </span>
      <svg
        ref={surfaceRef}
        data-signature-surface=""
        data-has-signature={hasSignature ? 'true' : 'false'}
        role="img"
        aria-labelledby={`${padId}-label`}
        aria-describedby={`${padId}-hint`}
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        // Height is the touch surface; 160 px is well over the 44 px minimum and gives
        // an elderly patient room for a real signature on a tablet.
        className={cn(
          'h-40 w-full touch-none rounded-md border border-control bg-layer-1 text-fg-default',
          disabled ? 'opacity-60' : 'cursor-crosshair',
        )}
        onPointerDown={(event) => {
          if (disabled) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDrawing(true);
          commit([...strokes, [pointFrom(event)]]);
        }}
        onPointerMove={(event) => {
          if (disabled || !drawing) return;
          const last = strokes.at(-1);
          if (last === undefined) return;
          const next = [...strokes.slice(0, -1), [...last, pointFrom(event)]];
          setStrokes(next);
        }}
        onPointerUp={() => {
          if (!drawing) return;
          setDrawing(false);
          onChange(strokesToDataUrl(strokes, width, height));
        }}
        onPointerLeave={() => {
          if (!drawing) return;
          setDrawing(false);
          onChange(strokesToDataUrl(strokes, width, height));
        }}
      >
        {strokes.map((stroke, index) =>
          stroke.length === 0 ? null : (
            <polyline
              key={index}
              points={stroke.map((point) => `${String(point.x)},${String(point.y)}`).join(' ')}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ),
        )}
      </svg>
      <div className="flex items-center justify-between gap-2">
        <p id={`${padId}-hint`} className="flex items-center gap-1 text-xs text-fg-muted">
          <PenLine aria-hidden="true" className="size-3" />
          {labels.hint}
        </p>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || !hasSignature}
          onClick={() => {
            commit([]);
          }}
        >
          <Eraser aria-hidden="true" />
          {labels.clear}
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {hasSignature ? labels.captured : labels.empty}
      </span>
    </div>
  );
}
