'use client';

import { Fingerprint, PenLine, ShieldCheck, Users } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { Badge } from '../primitives/badge.js';
import { Button } from '../primitives/button.js';
import { Checkbox } from '../primitives/checkbox.js';
import { Input } from '../primitives/input.js';
import { Label } from '../primitives/label.js';
import { RadioGroup, RadioGroupItem } from '../primitives/radio-group.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../primitives/select.js';
import { SignaturePad, type SignaturePadLabels } from './signature-pad.js';

/**
 * `ConsentCapture` — EN-028 consent with the DPDP Act 2023 / DPDP Rules 2025 notice
 * (docs/prompts/phase-01 §1.2, §1.7; docs/06 §5.2 #19 `ConsentSigner`).
 *
 * What the DPDP notice regime actually demands, and how the types enforce it:
 *
 *  - **A versioned notice, in the data principal's language.** `ConsentNotice.version`
 *    and `.locale` are required fields, and both are copied into the artefact — a
 *    consent you cannot tie back to the exact words shown is not evidence.
 *  - **Itemised, purpose-specific consent.** Purposes are a list, each granted or
 *    declined individually, and the artefact records *both* lists. "Everything was
 *    ticked" and "the optional ones were declined" are different facts.
 *  - **A clear affirmative action.** Nothing is pre-ticked (there is no `defaultGranted`
 *    prop, deliberately), and the submit button stays disabled until every mandatory
 *    purpose is granted, the notice has been read to the end, and an attestation exists.
 *  - **`noticeRead: true` is a literal type.** An artefact that says the notice was not
 *    read cannot be constructed, so the gate cannot be bypassed by a caller assembling
 *    the object by hand.
 *  - **Withdrawal is always visible** (DPDP §6(6)) — `onWithdraw` renders a permanent
 *    link, not a buried setting.
 *
 * A guardian consent carries the guardian's name and relation in the type, so a minor's
 * consent can never be stored as if the patient signed it themselves.
 */

export interface ConsentPurpose {
  readonly code: string;
  /** Already-localised, specific ("Share reports with your referring doctor"). */
  readonly label: string;
  /** Care cannot proceed without it; optional purposes must be genuinely optional. */
  readonly mandatory: boolean;
}

export interface ConsentNotice {
  readonly templateId: string;
  /** Mandatory. The artefact is meaningless without the exact version shown. */
  readonly version: string;
  /** BCP-47 tag of the language the body below is written in. */
  readonly locale: string;
  readonly title: string;
  /** The full notice text, already localised and already sanitised. */
  readonly body: string;
  /** `dd-MM-yyyy`, already formatted (docs/06 §1.2.10). */
  readonly publishedOn: string;
}

export type ConsentAttestationMethod = 'drawn-signature' | 'thumb-impression' | 'otp' | 'witnessed';

export type ConsentAttestation =
  | { readonly kind: 'drawn-signature'; readonly dataUrl: string }
  | { readonly kind: 'thumb-impression'; readonly dataUrl: string }
  /** OTP to the registered mobile — the keyboard-only, no-pointer path. */
  | { readonly kind: 'otp'; readonly reference: string }
  | { readonly kind: 'witnessed'; readonly witnessName: string; readonly witnessRelation: string };

export type ConsentSubject =
  | { readonly kind: 'self' }
  | { readonly kind: 'guardian'; readonly name: string; readonly relation: string };

export interface ConsentArtefact {
  readonly templateId: string;
  readonly version: string;
  readonly locale: string;
  readonly purposesGranted: readonly string[];
  readonly purposesDeclined: readonly string[];
  readonly subject: ConsentSubject;
  readonly attestation: ConsentAttestation;
  /** Literal `true`: an artefact recording an unread notice is unrepresentable. */
  readonly noticeRead: true;
}

export interface ConsentCaptureLabels {
  readonly region: string;
  readonly versionPrefix: string;
  readonly publishedPrefix: string;
  readonly languageLabel: string;
  readonly noticeRegion: string;
  readonly scrollToEnd: string;
  readonly noticeRead: string;
  readonly purposesHeading: string;
  readonly mandatoryMarker: string;
  readonly optionalMarker: string;
  readonly subjectHeading: string;
  readonly subjectSelf: string;
  readonly subjectGuardian: string;
  readonly guardianName: string;
  readonly guardianRelation: string;
  readonly attestationHeading: string;
  readonly method: Readonly<Record<ConsentAttestationMethod, string>>;
  readonly otpReference: string;
  readonly otpHint: string;
  readonly witnessName: string;
  readonly witnessRelation: string;
  readonly grant: string;
  readonly withdraw: string;
  readonly withdrawHint: string;
  readonly blockedReason: string;
  readonly signature: SignaturePadLabels;
  readonly thumb: SignaturePadLabels;
}

export interface ConsentCaptureProps {
  readonly notice: ConsentNotice;
  readonly purposes: readonly ConsentPurpose[];
  readonly labels: ConsentCaptureLabels;
  /** Attestation methods this hospital/branch permits, in the order shown. */
  readonly methods: readonly [ConsentAttestationMethod, ...ConsentAttestationMethod[]];
  readonly onGrant: (artefact: ConsentArtefact) => void;
  /** DPDP §6(6) — withdrawal must be as easy as giving consent. */
  readonly onWithdraw?: () => void;
  /** Locales this notice is published in; switching re-fetches via `onLocaleChange`. */
  readonly availableLocales?: readonly { readonly code: string; readonly label: string }[];
  readonly onLocaleChange?: (locale: string) => void;
  readonly allowGuardian?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
}

const METHOD_ICON: Readonly<Record<ConsentAttestationMethod, React.JSX.Element>> = {
  'drawn-signature': <PenLine aria-hidden="true" className="size-3" />,
  'thumb-impression': <Fingerprint aria-hidden="true" className="size-3" />,
  otp: <ShieldCheck aria-hidden="true" className="size-3" />,
  witnessed: <Users aria-hidden="true" className="size-3" />,
};

/** `true` once the notice has been scrolled to the end — or never needed scrolling. */
function useReadToEnd(): {
  readonly read: boolean;
  readonly attach: (node: HTMLDivElement | null) => void;
  readonly onScroll: () => void;
} {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const [read, setRead] = useState(false);

  const evaluate = useCallback((): void => {
    const node = nodeRef.current;
    if (node === null) return;
    // If the notice fits without scrolling there is nothing to scroll to, and demanding
    // a scroll that cannot happen would be a dead end (docs/06 §6.7).
    const scrollable = node.scrollHeight - node.clientHeight > 1;
    setRead(!scrollable || node.scrollTop + node.clientHeight >= node.scrollHeight - 2);
  }, []);

  const attach = useCallback(
    (node: HTMLDivElement | null): void => {
      nodeRef.current = node;
      evaluate();
    },
    [evaluate],
  );

  useEffect(evaluate, [evaluate]);

  return { read, attach, onScroll: evaluate };
}

export function ConsentCapture({
  notice,
  purposes,
  labels,
  methods,
  onGrant,
  onWithdraw,
  availableLocales,
  onLocaleChange,
  allowGuardian = false,
  disabled = false,
  className,
}: ConsentCaptureProps): React.JSX.Element {
  const fieldId = useId();
  const { read, attach, onScroll } = useReadToEnd();

  // Nothing starts ticked. docs/06 §6.4 and DPDP: consent is an affirmative action.
  const [granted, setGranted] = useState<ReadonlySet<string>>(new Set());
  const [subjectKind, setSubjectKind] = useState<'self' | 'guardian'>('self');
  const [guardianName, setGuardianName] = useState('');
  const [guardianRelation, setGuardianRelation] = useState('');
  const [method, setMethod] = useState<ConsentAttestationMethod>(methods[0]);
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [thumbDataUrl, setThumbDataUrl] = useState<string | null>(null);
  const [otpReference, setOtpReference] = useState('');
  const [witnessName, setWitnessName] = useState('');
  const [witnessRelation, setWitnessRelation] = useState('');

  const attestation = ((): ConsentAttestation | null => {
    switch (method) {
      case 'drawn-signature':
        return signatureDataUrl === null ? null : { kind: 'drawn-signature', dataUrl: signatureDataUrl };
      case 'thumb-impression':
        return thumbDataUrl === null ? null : { kind: 'thumb-impression', dataUrl: thumbDataUrl };
      case 'otp':
        return otpReference.trim() === '' ? null : { kind: 'otp', reference: otpReference.trim() };
      case 'witnessed':
        return witnessName.trim() === '' || witnessRelation.trim() === ''
          ? null
          : {
              kind: 'witnessed',
              witnessName: witnessName.trim(),
              witnessRelation: witnessRelation.trim(),
            };
    }
  })();

  const subject: ConsentSubject | null =
    subjectKind === 'self'
      ? { kind: 'self' }
      : guardianName.trim() === '' || guardianRelation.trim() === ''
        ? null
        : { kind: 'guardian', name: guardianName.trim(), relation: guardianRelation.trim() };

  const mandatoryMissing = purposes.filter((purpose) => purpose.mandatory && !granted.has(purpose.code));
  const canGrant =
    !disabled && read && mandatoryMissing.length === 0 && attestation !== null && subject !== null;

  const toggle = (code: string, next: boolean): void => {
    const updated = new Set(granted);
    if (next) updated.add(code);
    else updated.delete(code);
    setGranted(updated);
  };

  return (
    <section
      data-slot="consent-capture"
      role="group"
      aria-label={labels.region}
      className={cn('flex flex-col gap-4', className)}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-xl font-semibold text-fg-default">{notice.title}</h3>
        <Badge tone="accent" data-consent-version={notice.version}>
          {labels.versionPrefix} {notice.version}
        </Badge>
        <span className="text-xs text-fg-muted">
          {labels.publishedPrefix} {notice.publishedOn}
        </span>
        {availableLocales === undefined || onLocaleChange === undefined ? null : (
          <div className="ms-auto flex items-center gap-2">
            <Label htmlFor={`${fieldId}-locale`} className="text-xs">
              {labels.languageLabel}
            </Label>
            <Select value={notice.locale} onValueChange={onLocaleChange} disabled={disabled}>
              <SelectTrigger id={`${fieldId}-locale`} className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableLocales.map((locale) => (
                  <SelectItem key={locale.code} value={locale.code}>
                    {locale.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </header>

      {/* The notice is a labelled, focusable scroll region so a keyboard user can page
          through it (SC 2.1.1) and so the read gate is reachable without a mouse. */}
      <div
        ref={attach}
        onScroll={onScroll}
        tabIndex={0}
        role="region"
        aria-label={labels.noticeRegion}
        lang={notice.locale}
        data-notice-read={read ? 'true' : 'false'}
        className={cn(
          'max-h-64 overflow-y-auto whitespace-pre-line rounded-md border border-default',
          'bg-layer-1 p-3 text-md text-fg-default',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        )}
      >
        {notice.body}
      </div>
      {read ? null : <p className="text-xs text-warning-fg">{labels.scrollToEnd}</p>}

      <fieldset className="flex flex-col gap-2">
        <legend className="text-md font-medium text-fg-default">{labels.purposesHeading}</legend>
        {purposes.map((purpose) => (
          <label
            key={purpose.code}
            data-purpose={purpose.code}
            // 44 px minimum row so a tick is reachable with a gloved hand (§6.3).
            className="flex min-h-11 items-center gap-2 text-md text-fg-default"
          >
            <Checkbox
              checked={granted.has(purpose.code)}
              disabled={disabled}
              aria-required={purpose.mandatory}
              onCheckedChange={(next) => {
                toggle(purpose.code, next === true);
              }}
            />
            <span>{purpose.label}</span>
            <span className="text-2xs text-fg-muted">
              {purpose.mandatory ? labels.mandatoryMarker : labels.optionalMarker}
            </span>
          </label>
        ))}
      </fieldset>

      {allowGuardian ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-md font-medium text-fg-default">{labels.subjectHeading}</legend>
          <RadioGroup
            value={subjectKind}
            disabled={disabled}
            onValueChange={(next) => {
              setSubjectKind(next === 'guardian' ? 'guardian' : 'self');
            }}
          >
            <label className="flex min-h-11 items-center gap-2 text-md">
              <RadioGroupItem value="self" /> {labels.subjectSelf}
            </label>
            <label className="flex min-h-11 items-center gap-2 text-md">
              <RadioGroupItem value="guardian" /> {labels.subjectGuardian}
            </label>
          </RadioGroup>
          {subjectKind === 'guardian' ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${fieldId}-guardian-name`} required>
                  {labels.guardianName}
                </Label>
                <Input
                  id={`${fieldId}-guardian-name`}
                  value={guardianName}
                  disabled={disabled}
                  aria-required="true"
                  onChange={(event) => {
                    setGuardianName(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${fieldId}-guardian-relation`} required>
                  {labels.guardianRelation}
                </Label>
                <Input
                  id={`${fieldId}-guardian-relation`}
                  value={guardianRelation}
                  disabled={disabled}
                  aria-required="true"
                  onChange={(event) => {
                    setGuardianRelation(event.target.value);
                  }}
                />
              </div>
            </div>
          ) : null}
        </fieldset>
      ) : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="text-md font-medium text-fg-default">{labels.attestationHeading}</legend>
        <div className="flex flex-wrap gap-2">
          {methods.map((candidate) => (
            <Button
              key={candidate}
              variant={method === candidate ? 'primary' : 'secondary'}
              size="sm"
              disabled={disabled}
              aria-pressed={method === candidate}
              data-method={candidate}
              onClick={() => {
                setMethod(candidate);
              }}
            >
              {METHOD_ICON[candidate]}
              {labels.method[candidate]}
            </Button>
          ))}
        </div>

        {method === 'drawn-signature' ? (
          <SignaturePad labels={labels.signature} disabled={disabled} onChange={setSignatureDataUrl} />
        ) : null}
        {method === 'thumb-impression' ? (
          <SignaturePad labels={labels.thumb} disabled={disabled} onChange={setThumbDataUrl} />
        ) : null}
        {method === 'otp' ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${fieldId}-otp`} required>
              {labels.otpReference}
            </Label>
            <Input
              id={`${fieldId}-otp`}
              value={otpReference}
              disabled={disabled}
              autoComplete="one-time-code"
              inputMode="numeric"
              dir="ltr"
              aria-required="true"
              aria-describedby={`${fieldId}-otp-hint`}
              className="font-mono"
              onChange={(event) => {
                setOtpReference(event.target.value);
              }}
            />
            <p id={`${fieldId}-otp-hint`} className="text-xs text-fg-muted">
              {labels.otpHint}
            </p>
          </div>
        ) : null}
        {method === 'witnessed' ? (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${fieldId}-witness-name`} required>
                {labels.witnessName}
              </Label>
              <Input
                id={`${fieldId}-witness-name`}
                value={witnessName}
                disabled={disabled}
                aria-required="true"
                onChange={(event) => {
                  setWitnessName(event.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${fieldId}-witness-relation`} required>
                {labels.witnessRelation}
              </Label>
              <Input
                id={`${fieldId}-witness-relation`}
                value={witnessRelation}
                disabled={disabled}
                aria-required="true"
                onChange={(event) => {
                  setWitnessRelation(event.target.value);
                }}
              />
            </div>
          </div>
        ) : null}
      </fieldset>

      <div className="flex flex-wrap items-center justify-between gap-2">
        {onWithdraw === undefined ? (
          <span />
        ) : (
          // DPDP §6(6) — withdrawal is as prominent as granting, and always present.
          <div className="flex flex-col">
            <Button variant="link" size="sm" disabled={disabled} onClick={onWithdraw}>
              {labels.withdraw}
            </Button>
            <span className="text-2xs text-fg-muted">{labels.withdrawHint}</span>
          </div>
        )}
        <div className="flex flex-col items-end gap-1">
          <Button
            variant="primary"
            data-action="grant"
            disabled={!canGrant}
            onClick={() => {
              if (!canGrant || attestation === null || subject === null) return;
              onGrant({
                templateId: notice.templateId,
                version: notice.version,
                locale: notice.locale,
                purposesGranted: purposes
                  .filter((purpose) => granted.has(purpose.code))
                  .map((purpose) => purpose.code),
                purposesDeclined: purposes
                  .filter((purpose) => !granted.has(purpose.code))
                  .map((purpose) => purpose.code),
                subject,
                attestation,
                noticeRead: true,
              });
            }}
          >
            {labels.grant}
          </Button>
          {canGrant ? null : (
            <p className="text-2xs text-fg-muted" data-blocked-reason="">
              {labels.blockedReason}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
