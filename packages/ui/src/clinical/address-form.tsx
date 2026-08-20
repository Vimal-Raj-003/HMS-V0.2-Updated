'use client';

import { CircleAlert, Loader2, MapPin } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/button.js';
import { Input, inputClassName } from '../primitives/input.js';
import { Label } from '../primitives/label.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../primitives/select.js';

/**
 * `AddressForm` — the Indian postal address of OP-001 registration
 * (docs/prompts/phase-01 §1.2: "address with PIN-code lookup").
 *
 * Two rules shape the design:
 *
 *  1. **The lookup is an accelerator, never a gate.** phase-01 §Constraints: *"Never
 *     block registration on ABHA, payment, or an external service being down — degrade
 *     and queue."* Every field the lookup fills stays editable, and a failed or
 *     unavailable lookup renders a named state plus the manual path — never a spinner
 *     that outlives the request or a disabled district field.
 *  2. **RTL and Indic are structural, not a skin.** All spacing uses logical
 *     properties, the free-text fields carry the patient's own `lang` (so a screen
 *     reader switches voice and `--font-indic` applies, docs/06 §8), and the PIN field
 *     is pinned `dir="ltr"` with `inputMode="numeric"` so a six-digit code reads the
 *     same way inside an Arabic or Devanagari form. Resolved place names are wrapped
 *     in `<bdi>` so a Latin district inside a Hindi line does not reorder.
 */

export interface IndianAddress {
  readonly line1: string;
  readonly line2: string;
  readonly landmark: string;
  /** Six digits, first digit 1–9 (India Post). Stored as typed, never as a number. */
  readonly pincode: string;
  /** Village / locality / post office. */
  readonly area: string;
  readonly city: string;
  readonly district: string;
  /** State or UT code from the EN-027 master, e.g. `TN`. */
  readonly stateCode: string;
  /** ISO-3166 alpha-2. `IN` for this form; the field exists so the type is global-ready. */
  readonly country: string;
}

export function emptyIndianAddress(country = 'IN'): IndianAddress {
  return {
    line1: '',
    line2: '',
    landmark: '',
    pincode: '',
    area: '',
    city: '',
    district: '',
    stateCode: '',
    country,
  };
}

/** India Post PIN: exactly six digits, and the first is never 0. */
export function isValidPincode(pincode: string): boolean {
  return /^[1-9]\d{5}$/.test(pincode);
}

export interface PincodeArea {
  readonly area: string;
  readonly city: string;
  readonly district: string;
  readonly stateCode: string;
  /** Already-localised state name for display. */
  readonly stateName: string;
}

export type PincodeLookupState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'looking-up' }
  /** Non-empty by construction: a "resolved" lookup with no areas is not resolved. */
  | { readonly kind: 'resolved'; readonly areas: readonly [PincodeArea, ...PincodeArea[]] }
  | { readonly kind: 'not-found' }
  /** The directory is unreachable. Registration continues by hand. */
  | { readonly kind: 'unavailable' };

export interface CodedOption {
  readonly code: string;
  /** Already-localised. */
  readonly label: string;
}

export interface AddressFormLabels {
  readonly region: string;
  readonly line1: string;
  readonly line2: string;
  readonly landmark: string;
  readonly pincode: string;
  readonly pincodeHint: string;
  readonly pincodeInvalid: string;
  readonly area: string;
  readonly city: string;
  readonly district: string;
  readonly state: string;
  readonly statePlaceholder: string;
  readonly country: string;
  readonly lookingUp: string;
  readonly lookupNotFound: string;
  readonly lookupUnavailable: string;
  readonly lookupManualHint: string;
  readonly chooseArea: string;
  readonly retryLookup: string;
  readonly optional: string;
}

export interface AddressFormProps {
  readonly value: IndianAddress;
  readonly onChange: (value: IndianAddress) => void;
  readonly labels: AddressFormLabels;
  /** State/UT master (EN-027). Never hard-coded in the component. */
  readonly states: readonly CodedOption[];
  /**
   * Resolves a PIN to its post offices. Returning `null` means "no such PIN";
   * rejecting means the directory is down, which renders the `unavailable` state
   * rather than an error the cashier cannot act on.
   */
  readonly lookupPincode?: (pincode: string) => Promise<readonly PincodeArea[] | null>;
  /** BCP-47 tag of the script the patient's address is written in (docs/06 §8). */
  readonly scriptLocale?: string;
  /** Server-side field errors mapped from RFC 9457 problem+json (docs/06 §6.4). */
  readonly errors?: Partial<Record<keyof IndianAddress, string>>;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function AddressForm({
  value,
  onChange,
  labels,
  states,
  lookupPincode,
  scriptLocale,
  errors,
  disabled = false,
  className,
}: AddressFormProps): React.JSX.Element {
  const fieldId = useId();
  const [lookup, setLookup] = useState<PincodeLookupState>({ kind: 'idle' });
  // Guards against a slow lookup for an old PIN landing after a newer one.
  const requestRef = useRef(0);

  const pincodeValid = isValidPincode(value.pincode);
  const pincodeTouchedAndInvalid = value.pincode.length > 0 && !pincodeValid;

  const set = <K extends keyof IndianAddress>(key: K, next: IndianAddress[K]): void => {
    onChange({ ...value, [key]: next });
  };

  const applyArea = (area: PincodeArea): void => {
    onChange({
      ...value,
      area: area.area,
      city: area.city === '' ? value.city : area.city,
      district: area.district,
      stateCode: area.stateCode,
    });
  };

  const runLookup = (pincode: string): void => {
    if (lookupPincode === undefined || !isValidPincode(pincode)) return;
    requestRef.current += 1;
    const request = requestRef.current;
    setLookup({ kind: 'looking-up' });
    void lookupPincode(pincode)
      .then((areas) => {
        if (request !== requestRef.current) return;
        const [first, ...rest] = areas ?? [];
        if (first === undefined) {
          setLookup({ kind: 'not-found' });
          return;
        }
        setLookup({ kind: 'resolved', areas: [first, ...rest] });
        // A single unambiguous post office fills itself; several stay a choice, because
        // guessing a district is how a discharge summary reaches the wrong village.
        if (rest.length === 0) applyArea(first);
      })
      .catch(() => {
        if (request !== requestRef.current) return;
        setLookup({ kind: 'unavailable' });
      });
  };

  useEffect(() => {
    if (!isValidPincode(value.pincode)) setLookup({ kind: 'idle' });
    // Only the PIN's validity resets the lookup; re-running on every keystroke of the
    // rest of the address would clear the resolved list while the user picks from it.
  }, [value.pincode]);

  const fieldClassName = 'flex flex-col gap-1';
  const scriptProps = scriptLocale === undefined ? {} : { lang: scriptLocale };

  const errorFor = (key: keyof IndianAddress): string | undefined => errors?.[key];

  const renderError = (key: keyof IndianAddress): React.JSX.Element | null => {
    const message = errorFor(key);
    if (message === undefined) return null;
    return (
      <p id={`${fieldId}-${key}-error`} role="alert" className="flex items-center gap-1 text-xs text-danger-fg">
        <CircleAlert aria-hidden="true" className="size-3" />
        {message}
      </p>
    );
  };

  return (
    <section
      data-slot="address-form"
      role="group"
      aria-label={labels.region}
      className={cn('grid grid-cols-1 gap-3 md:grid-cols-2', className)}
    >
      <div className={cn(fieldClassName, 'md:col-span-2')}>
        <Label htmlFor={`${fieldId}-line1`} required>
          {labels.line1}
        </Label>
        <Input
          id={`${fieldId}-line1`}
          value={value.line1}
          disabled={disabled}
          autoComplete="address-line1"
          aria-required="true"
          aria-invalid={errorFor('line1') !== undefined}
          aria-describedby={errorFor('line1') === undefined ? undefined : `${fieldId}-line1-error`}
          {...scriptProps}
          onChange={(event) => {
            set('line1', event.target.value);
          }}
        />
        {renderError('line1')}
      </div>

      <div className={fieldClassName}>
        <Label htmlFor={`${fieldId}-line2`}>
          {labels.line2} <span className="text-fg-subtle">{labels.optional}</span>
        </Label>
        <Input
          id={`${fieldId}-line2`}
          value={value.line2}
          disabled={disabled}
          autoComplete="address-line2"
          {...scriptProps}
          onChange={(event) => {
            set('line2', event.target.value);
          }}
        />
      </div>

      <div className={fieldClassName}>
        <Label htmlFor={`${fieldId}-landmark`}>
          {labels.landmark} <span className="text-fg-subtle">{labels.optional}</span>
        </Label>
        <Input
          id={`${fieldId}-landmark`}
          value={value.landmark}
          disabled={disabled}
          {...scriptProps}
          onChange={(event) => {
            set('landmark', event.target.value);
          }}
        />
      </div>

      <div className={fieldClassName}>
        <Label htmlFor={`${fieldId}-pincode`} required>
          {labels.pincode}
        </Label>
        <div className="flex items-center gap-2">
          <div className="relative flex flex-1 items-center">
            <MapPin
              aria-hidden="true"
              className="pointer-events-none absolute inset-inline-start-3 size-4 text-fg-muted"
            />
            <input
              id={`${fieldId}-pincode`}
              // §8 — numerals stay LTR inside an RTL form, and tablets get a number pad.
              dir="ltr"
              type="text"
              inputMode="numeric"
              autoComplete="postal-code"
              maxLength={6}
              disabled={disabled}
              value={value.pincode}
              aria-required="true"
              aria-invalid={pincodeTouchedAndInvalid || errorFor('pincode') !== undefined}
              aria-describedby={`${fieldId}-pincode-hint`}
              onChange={(event) => {
                const next = event.target.value.replace(/\D/g, '').slice(0, 6);
                set('pincode', next);
                if (isValidPincode(next)) runLookup(next);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  runLookup(value.pincode);
                }
              }}
              className={cn(inputClassName, 'ps-9 font-mono tabular-nums')}
            />
          </div>
          {lookup.kind === 'unavailable' || lookup.kind === 'not-found' ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled || !pincodeValid}
              onClick={() => {
                runLookup(value.pincode);
              }}
            >
              {labels.retryLookup}
            </Button>
          ) : null}
        </div>
        <p id={`${fieldId}-pincode-hint`} className="flex items-center gap-1 text-xs text-fg-muted">
          {lookup.kind === 'looking-up' ? (
            <>
              <Loader2 aria-hidden="true" className="size-3 motion-safe:animate-spin" />
              {labels.lookingUp}
            </>
          ) : null}
          {lookup.kind === 'not-found' ? (
            <span data-lookup="not-found" className="text-warning-fg">
              {labels.lookupNotFound} {labels.lookupManualHint}
            </span>
          ) : null}
          {lookup.kind === 'unavailable' ? (
            <span data-lookup="unavailable" className="text-warning-fg">
              {labels.lookupUnavailable} {labels.lookupManualHint}
            </span>
          ) : null}
          {lookup.kind === 'idle' || lookup.kind === 'resolved' ? (
            <span>{pincodeTouchedAndInvalid ? labels.pincodeInvalid : labels.pincodeHint}</span>
          ) : null}
        </p>
        {renderError('pincode')}
      </div>

      {lookup.kind === 'resolved' && lookup.areas.length > 1 ? (
        <div className={cn(fieldClassName, 'md:col-span-2')} data-lookup="choose-area">
          <span className="text-xs text-fg-muted">{labels.chooseArea}</span>
          <div className="flex flex-wrap gap-2">
            {lookup.areas.map((area) => (
              <Button
                key={`${area.area}-${area.district}`}
                variant={value.area === area.area ? 'primary' : 'secondary'}
                size="sm"
                disabled={disabled}
                onClick={() => {
                  applyArea(area);
                }}
              >
                <bdi>{area.area}</bdi>
                <span className="text-fg-subtle">
                  · <bdi>{area.district}</bdi>
                </span>
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <div className={fieldClassName}>
        <Label htmlFor={`${fieldId}-area`} required>
          {labels.area}
        </Label>
        <Input
          id={`${fieldId}-area`}
          value={value.area}
          disabled={disabled}
          aria-required="true"
          {...scriptProps}
          onChange={(event) => {
            set('area', event.target.value);
          }}
        />
        {renderError('area')}
      </div>

      <div className={fieldClassName}>
        <Label htmlFor={`${fieldId}-city`} required>
          {labels.city}
        </Label>
        <Input
          id={`${fieldId}-city`}
          value={value.city}
          disabled={disabled}
          autoComplete="address-level2"
          aria-required="true"
          {...scriptProps}
          onChange={(event) => {
            set('city', event.target.value);
          }}
        />
        {renderError('city')}
      </div>

      <div className={fieldClassName}>
        {/* Filled by the lookup, but never locked: the directory is sometimes wrong and
            the clerk is looking at the patient's card. */}
        <Label htmlFor={`${fieldId}-district`} required>
          {labels.district}
        </Label>
        <Input
          id={`${fieldId}-district`}
          value={value.district}
          disabled={disabled}
          aria-required="true"
          {...scriptProps}
          onChange={(event) => {
            set('district', event.target.value);
          }}
        />
        {renderError('district')}
      </div>

      <div className={fieldClassName}>
        <Label htmlFor={`${fieldId}-state`} required>
          {labels.state}
        </Label>
        <Select
          value={value.stateCode}
          disabled={disabled}
          onValueChange={(next) => {
            set('stateCode', next);
          }}
        >
          <SelectTrigger id={`${fieldId}-state`} aria-required="true">
            <SelectValue placeholder={labels.statePlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {states.map((state) => (
              <SelectItem key={state.code} value={state.code}>
                {state.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {renderError('stateCode')}
      </div>
    </section>
  );
}
