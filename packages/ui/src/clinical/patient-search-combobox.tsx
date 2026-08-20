'use client';

import { Clock, CircleAlert, Loader2, ScanLine, Search, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useKeyboardWedge } from '../hooks/use-keyboard-wedge.js';
import { cn } from '../lib/cn.js';
import { inputClassName } from '../primitives/input.js';
import type { PatientSex } from './patient-banner.js';

/**
 * `PatientSearchCombobox` — docs/06 §5.2 #42 (`PatientSearchDialog`), §6.5 (search) and
 * docs/prompts/phase-01 §1.2 ("Search that is actually fast: mobile / UHID / name /
 * ABHA / ID … Recent-patients list. Scan-to-find").
 *
 * This is the single most-used control in the building: every registration, every
 * cash counter, every ⌘K. Four things are therefore non-negotiable and are enforced
 * by the types, not by a comment:
 *
 *  1. **Minimum PHI on screen.** A result carries `mobileLast4`, not a mobile number —
 *     there is no field on `PatientSearchResult` that can hold a full phone number, so
 *     a corridor-visible result list cannot leak one. Two patients called
 *     "Ramesh Kumar" are still separable by UHID + age/sex + last four + last visit.
 *  2. **Break-glass is not optional.** §5.2 #42: "opening a non-care-team patient routes
 *     through break-glass". `onBreakGlassRequired` is a **required** prop and this
 *     component, not the caller, decides which of the two callbacks fires — so there is
 *     no code path that opens a stranger's record without an audited reason (docs/04 §5).
 *  3. **The scanner is a first-class input device.** A wristband or UHID card scanned
 *     with no field focused, or straight into this field, resolves through
 *     `onScanResolve` — a keyboard-wedge burst (§6.2) never becomes a half-typed search.
 *  4. **Never auto-select on blur** (§5.2 #15). Moving away from the field selects
 *     nobody; the wrong-patient error starts exactly here.
 */

export type PatientSearchMode = 'mobile' | 'uhid' | 'abha' | 'identifier' | 'name';

/**
 * Classifies what the clerk typed so the server can pick the right index (trigram vs
 * prefix vs exact) — docs/06 §6.5 "exact-code match always ranks first".
 * Pure and exported: the same rule is asserted in the tests and reused by ⌘K.
 */
export function detectSearchMode(query: string): PatientSearchMode {
  const trimmed = query.trim();
  const digits = trimmed.replace(/[\s-]/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return 'mobile';
  if (/^\d{14}$/.test(digits)) return 'abha';
  if (/@(abdm|sbx)$/i.test(trimmed) || /^[a-z0-9._-]{4,}@[a-z]+$/i.test(trimmed)) return 'abha';
  if (/^\d{4}-\d{4,}$/.test(trimmed) || /^[A-Z]{2,4}[-/]?\d{4,}$/i.test(trimmed)) return 'uhid';
  if (/^[A-Z]{5}\d{4}[A-Z]$/i.test(trimmed)) return 'identifier';
  if (/^\d{4,}$/.test(digits)) return 'uhid';
  return 'name';
}

export interface PatientSearchResult {
  readonly patientId: string;
  readonly uhid: string;
  /** Assembled by the caller as `FAMILY, Given` so sorting and emphasis stay server-side. */
  readonly displayName: string;
  /** Pre-formatted age — `45 y`, `8 m`, `12 d` (docs/06 §8). */
  readonly age: string;
  readonly sex: PatientSex;
  /**
   * The last four digits only. Deliberately not `mobile`: a full number has no business
   * on a shared registration screen, and a type cannot leak a field it does not have.
   */
  readonly mobileLast4?: string;
  /** `dd-MM-yyyy` of the last visit — the field that separates two same-name patients. */
  readonly lastVisitOn?: string;
  readonly activeEpisode?: string;
  readonly photoUrl?: string;
  /** `true` when the searching user is on this patient's care team (docs/04 §5). */
  readonly careTeamMember: boolean;
  /** MPI flagged this as a probable duplicate — offer the merge tool, do not hide it. */
  readonly probableDuplicate?: boolean;
  readonly deceased?: boolean;
}

export type PatientSearchStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'too-short' }
  | { readonly kind: 'searching' }
  | { readonly kind: 'results'; readonly results: readonly PatientSearchResult[] }
  | { readonly kind: 'no-results'; readonly query: string }
  | { readonly kind: 'scanning'; readonly payload: string }
  | { readonly kind: 'scan-unresolved'; readonly payload: string }
  | { readonly kind: 'error' };

export interface PatientSearchLabels {
  readonly fieldLabel: string;
  readonly placeholder: string;
  readonly listLabel: string;
  readonly recentHeading: string;
  readonly resultsHeading: string;
  readonly minCharsHint: (minChars: number) => string;
  readonly searching: string;
  readonly noResults: (query: string) => string;
  readonly noResultsAction: string;
  readonly error: string;
  readonly scanning: string;
  readonly scanUnresolved: (payload: string) => string;
  readonly uhidPrefix: string;
  readonly mobilePrefix: string;
  readonly lastVisitPrefix: string;
  readonly duplicate: string;
  readonly deceased: string;
  readonly breakGlassRequired: string;
  /** Whole-row accessible sentence — docs/06 §7 wants values announced with context. */
  readonly resultSummary: (result: PatientSearchResult) => string;
  readonly modeHint: Readonly<Record<PatientSearchMode, string>>;
}

export interface PatientSearchComboboxProps {
  readonly labels: PatientSearchLabels;
  /** Server-side search. Rejecting renders the error state, never an empty list. */
  readonly onSearch: (query: string, mode: PatientSearchMode) => Promise<readonly PatientSearchResult[]>;
  /** Fires only for a patient the user is already entitled to open. */
  readonly onSelect: (result: PatientSearchResult) => void;
  /** §5.2 #42 — required, so a non-care-team patient always routes through break-glass. */
  readonly onBreakGlassRequired: (result: PatientSearchResult) => void;
  /** §6.5 — "recent-first when empty". */
  readonly recent?: readonly PatientSearchResult[];
  /** EN-013 scan resolver for a wristband / UHID card / ABHA QR. */
  readonly onScanResolve?: (payload: string) => Promise<PatientSearchResult | null>;
  readonly minChars?: number;
  readonly debounceMs?: number;
  /** Device-profile scanner prefix, e.g. `~` for wristbands (§6.2). */
  readonly scannerPrefix?: string;
  /** Listen for scans even when nothing is focused — the counter reality (§6.2). */
  readonly listenForScansGlobally?: boolean;
  readonly autoFocus?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
}

const SEX_SHORT: Readonly<Record<PatientSex, string>> = {
  male: 'M',
  female: 'F',
  other: 'O',
  unknown: '?',
};

export function PatientSearchCombobox({
  labels,
  onSearch,
  onSelect,
  onBreakGlassRequired,
  recent = [],
  onScanResolve,
  minChars = 2,
  debounceMs = 150,
  scannerPrefix,
  listenForScansGlobally = true,
  autoFocus = false,
  disabled = false,
  className,
}: PatientSearchComboboxProps): React.JSX.Element {
  const id = useId();
  const listId = `${id}-listbox`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestRef = useRef(0);
  /**
   * `onSearch` is almost always an inline lambda at the call site, so it has a new
   * identity on every render. Holding it in a ref keeps it out of the debounce
   * effect's dependency list: with it in there, the effect's own `setStatus` would
   * re-render, mint a new `onSearch`, re-run the effect, and spin forever.
   */
  const searchRef = useRef(onSearch);
  searchRef.current = onSearch;

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<PatientSearchStatus>({ kind: 'idle' });
  const [activeIndex, setActiveIndex] = useState(-1);
  const [open, setOpen] = useState(false);

  const mode = detectSearchMode(query);
  const visible: readonly PatientSearchResult[] =
    status.kind === 'results' ? status.results : query.trim() === '' ? recent : [];
  const showingRecent = query.trim() === '' && status.kind !== 'results';

  // ── search, debounced (§6.5: 150 ms, min 2 chars) ──────────────────────────
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === '') {
      setStatus({ kind: 'idle' });
      return undefined;
    }
    if (trimmed.length < minChars) {
      setStatus({ kind: 'too-short' });
      return undefined;
    }
    setStatus({ kind: 'searching' });
    const timer = setTimeout(() => {
      requestRef.current += 1;
      const request = requestRef.current;
      void searchRef
        .current(trimmed, detectSearchMode(trimmed))
        .then((results) => {
          // A stale response must never overwrite a newer one: on a 1 M-patient index
          // the two-character query resolves after the five-character one often enough.
          if (request !== requestRef.current) return;
          setStatus(
            results.length === 0
              ? { kind: 'no-results', query: trimmed }
              : { kind: 'results', results },
          );
          setActiveIndex(results.length === 0 ? -1 : 0);
        })
        .catch(() => {
          if (request !== requestRef.current) return;
          setStatus({ kind: 'error' });
        });
    }, debounceMs);
    return () => {
      clearTimeout(timer);
    };
  }, [query, minChars, debounceMs]);

  // ── scanner (§6.2) ─────────────────────────────────────────────────────────
  const handleScan = (payload: string): void => {
    if (onScanResolve === undefined || payload.trim() === '') return;
    requestRef.current += 1;
    const request = requestRef.current;
    setQuery('');
    setOpen(true);
    setStatus({ kind: 'scanning', payload });
    void onScanResolve(payload)
      .then((result) => {
        if (request !== requestRef.current) return;
        if (result === null) {
          // §6.2 — an unresolved scan shows the raw payload and leaves manual search open.
          setStatus({ kind: 'scan-unresolved', payload });
          return;
        }
        setStatus({ kind: 'results', results: [result] });
        setActiveIndex(0);
        choose(result);
      })
      .catch(() => {
        if (request !== requestRef.current) return;
        setStatus({ kind: 'scan-unresolved', payload });
      });
  };

  useKeyboardWedge({
    onScan: handleScan,
    enabled: !disabled && onScanResolve !== undefined && listenForScansGlobally,
    ...(scannerPrefix === undefined ? {} : { prefix: scannerPrefix }),
  });

  function choose(result: PatientSearchResult): void {
    setOpen(false);
    if (result.careTeamMember) {
      onSelect(result);
      return;
    }
    onBreakGlassRequired(result);
  }

  const move = (delta: number): void => {
    if (visible.length === 0) return;
    setOpen(true);
    setActiveIndex((current) => {
      const next = current + delta;
      if (next < 0) return visible.length - 1;
      if (next >= visible.length) return 0;
      return next;
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'Home':
        if (visible.length > 0) {
          event.preventDefault();
          setActiveIndex(0);
        }
        break;
      case 'End':
        if (visible.length > 0) {
          event.preventDefault();
          setActiveIndex(visible.length - 1);
        }
        break;
      case 'Enter': {
        const active = activeIndex >= 0 ? visible[activeIndex] : undefined;
        if (active !== undefined) {
          event.preventDefault();
          choose(active);
        }
        break;
      }
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        setActiveIndex(-1);
        break;
      default:
        break;
    }
  };

  const expanded = open && (visible.length > 0 || status.kind !== 'idle');

  return (
    <div data-slot="patient-search" className={cn('relative flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-md font-medium text-fg-default">
        {labels.fieldLabel}
      </label>

      <div className="relative flex items-center">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute inset-inline-start-3 size-4 text-fg-muted"
        />
        <input
          id={id}
          ref={inputRef}
          // WAI-ARIA 1.2 combobox: the input owns the expanded state and points at the
          // active option; the popup is a sibling listbox.
          role="combobox"
          type="text"
          autoComplete="off"
          spellCheck={false}
          // §6.2 — this field opts in to the wedge; other free-text fields do not.
          data-scan-target=""
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            expanded && activeIndex >= 0 ? `${listId}-option-${String(activeIndex)}` : undefined
          }
          aria-describedby={`${id}-status`}
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={labels.placeholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActiveIndex(-1);
          }}
          onFocus={() => {
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className={cn(inputClassName, 'ps-9 pe-24')}
        />
        <span className="pointer-events-none absolute inset-inline-end-3 flex items-center gap-1 text-2xs text-fg-muted">
          {status.kind === 'searching' || status.kind === 'scanning' ? (
            <Loader2 aria-hidden="true" className="size-3 motion-safe:animate-spin" />
          ) : (
            <ScanLine aria-hidden="true" className="size-3" />
          )}
          {query.trim() === '' ? null : labels.modeHint[mode]}
        </span>
      </div>

      {/* §1.1.1 — the status of an async search is always visible and announced. */}
      <p id={`${id}-status`} role="status" aria-live="polite" className="min-h-4 text-xs">
        {status.kind === 'too-short' ? (
          <span className="text-fg-muted">{labels.minCharsHint(minChars)}</span>
        ) : null}
        {status.kind === 'searching' ? <span className="text-fg-muted">{labels.searching}</span> : null}
        {status.kind === 'scanning' ? <span className="text-fg-muted">{labels.scanning}</span> : null}
        {status.kind === 'no-results' ? (
          <span className="text-fg-muted">
            {labels.noResults(status.query)} {labels.noResultsAction}
          </span>
        ) : null}
        {status.kind === 'scan-unresolved' ? (
          <span data-scan-state="unresolved" className="text-danger-fg">
            {labels.scanUnresolved(status.payload)}
          </span>
        ) : null}
        {status.kind === 'error' ? (
          <span className="inline-flex items-center gap-1 text-danger-fg">
            <CircleAlert aria-hidden="true" className="size-3" />
            {labels.error}
          </span>
        ) : null}
      </p>

      <ul
        id={listId}
        role="listbox"
        aria-label={labels.listLabel}
        className={cn(
          'absolute inset-inline-start-0 top-full z-dropdown mt-1 w-full',
          'max-h-96 overflow-y-auto rounded-lg border border-default bg-layer-2 p-1 shadow-e3',
          expanded && visible.length > 0 ? '' : 'hidden',
        )}
      >
        {visible.length === 0 ? null : (
          <li role="presentation" className="px-2 py-1 text-2xs font-medium uppercase tracking-[0.08em] text-fg-muted">
            {showingRecent ? labels.recentHeading : labels.resultsHeading}
          </li>
        )}
        {visible.map((result, index) => (
          <li
            key={result.patientId}
            id={`${listId}-option-${String(index)}`}
            role="option"
            aria-selected={index === activeIndex}
            aria-label={labels.resultSummary(result)}
            data-patient-id={result.patientId}
            data-break-glass={result.careTeamMember ? undefined : 'required'}
            // Pointer users get the same behaviour as the keyboard path; `mousedown`
            // rather than `click` so the input's blur cannot cancel the selection.
            onMouseDown={(event) => {
              event.preventDefault();
              choose(result);
            }}
            onMouseEnter={() => {
              setActiveIndex(index);
            }}
            className={cn(
              'flex min-h-11 cursor-default items-center gap-3 rounded-md px-2 py-2',
              index === activeIndex ? 'bg-layer-3' : '',
            )}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-md font-medium text-fg-default">{result.displayName}</span>
                <span className="text-sm text-fg-default">
                  {result.age} / {SEX_SHORT[result.sex]}
                </span>
                <span className="font-mono text-xs text-fg-muted">
                  {labels.uhidPrefix} {result.uhid}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-x-3 text-xs text-fg-muted">
                {result.mobileLast4 === undefined ? null : (
                  <span className="font-mono" dir="ltr">
                    {labels.mobilePrefix} ••••••{result.mobileLast4}
                  </span>
                )}
                {result.lastVisitOn === undefined ? null : (
                  <span className="inline-flex items-center gap-1">
                    <Clock aria-hidden="true" className="size-3" />
                    {labels.lastVisitPrefix} {result.lastVisitOn}
                  </span>
                )}
                {result.activeEpisode === undefined ? null : (
                  <span className="font-mono">{result.activeEpisode}</span>
                )}
              </span>
            </span>

            <span className="flex shrink-0 flex-wrap items-center gap-1">
              {result.probableDuplicate === true ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-warning-border bg-warning-surface px-2 py-0.5 text-2xs text-warning-on-surface">
                  <TriangleAlert aria-hidden="true" className="size-3" />
                  {labels.duplicate}
                </span>
              ) : null}
              {result.deceased === true ? (
                <span className="rounded-full border border-default px-2 py-0.5 text-2xs text-fg-default">
                  {labels.deceased}
                </span>
              ) : null}
              {result.careTeamMember ? null : (
                <span className="inline-flex items-center gap-1 rounded-full border border-danger-border bg-danger-surface px-2 py-0.5 text-2xs text-danger-on-surface">
                  <CircleAlert aria-hidden="true" className="size-3" />
                  {labels.breakGlassRequired}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
