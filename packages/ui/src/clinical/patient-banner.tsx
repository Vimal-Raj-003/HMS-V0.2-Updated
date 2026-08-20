'use client';

import {
  AlertTriangle,
  Ban,
  Biohazard,
  CircleAlert,
  HeartPulse,
  Scale,
  ShieldAlert,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/button.js';

/**
 * `PatientBanner` — docs/06 §4.2, "the most safety-critical component", and
 * `CLAUDE.md` §5 ("patient banner with photo, UHID, age/sex, allergies (red), alerts,
 * isolation, MLC").
 *
 * Rules encoded in the types rather than in prose:
 *   - the allergy area can never be empty: `AllergyStatus` is a discriminated union, so
 *     "not recorded" and "none known (verified …)" are distinct, representable states
 *     and there is no way to render nothing (§4.2, §10);
 *   - masked mode requires an `onBreakGlass` handler — the prop is required on that
 *     variant, so a masked banner without an audited escape hatch will not compile;
 *   - every visible string arrives through `labels`, so the component holds no English.
 */

export type PatientSex = 'male' | 'female' | 'other' | 'unknown';

export interface AllergyRecord {
  readonly substance: string;
  /** Already-localised reaction text, e.g. "anaphylaxis". */
  readonly reaction: string;
  readonly severity: 'mild' | 'moderate' | 'severe';
  /** Who recorded it and when — shown on hover/focus (§4.2). */
  readonly recordedBy?: string;
  readonly recordedAt?: string;
}

export type AllergyStatus =
  /** §4.2 — renders the amber "Allergies not recorded" chip. Never silence. */
  | { readonly kind: 'not-recorded' }
  /**
   * Asked, but not establishable (unconscious patient, no informant). A distinct state
   * from both "not recorded" and "none known": the clinician DID ask. `reason` is
   * already localised and is mandatory, so this can never degrade into a blank chip.
   * See `allergy-editor.tsx` for the full statement type this projects from.
   */
  | { readonly kind: 'unable-to-assess'; readonly reason: string }
  /** §4.2 — the explicit positive state, with its verification date. */
  | { readonly kind: 'none-known'; readonly verifiedOn: string }
  | { readonly kind: 'known'; readonly allergies: readonly AllergyRecord[] };

export type PatientAlertKind = 'vip' | 'fall-risk' | 'dnr' | 'infection' | 'deteriorating' | 'npo' | 'other';

export interface PatientAlert {
  readonly kind: PatientAlertKind;
  /** Already-localised label. */
  readonly label: string;
  readonly recordedBy?: string;
}

export interface PatientIdentity {
  readonly uhid: string;
  /** Family name, emphasised in the banner (§4.2). */
  readonly familyName: string;
  readonly givenName: string;
  /** Pre-formatted age ("45 y", "8 m", "12 d") — age arithmetic is a service concern. */
  readonly age: string;
  readonly sex: PatientSex;
  readonly photoUrl?: string;
  /** OP visit / IP number / ER number of the active episode. */
  readonly episodeId?: string;
  readonly ward?: string;
  readonly bed?: string;
  readonly lengthOfStay?: string;
  readonly attendingConsultant?: string;
  readonly department?: string;
  readonly payer?: string;
  readonly creditStatus?: string;
  readonly bloodGroup?: string;
  readonly weightKg?: number;
  readonly allergies: AllergyStatus;
  readonly alerts?: readonly PatientAlert[];
  readonly isolation?: { readonly type: string };
  readonly mlc?: { readonly number: string };
}

export interface PatientBannerLabels {
  /** `role="region"` name — §4.2 "Patient identity and alerts". */
  readonly region: string;
  readonly allergyPrefix: string;
  readonly allergiesNotRecorded: string;
  /** §4.2 — "asked, could not establish". Distinct wording from "not recorded". */
  readonly allergiesUnableToAssess: (reason: string) => string;
  readonly noKnownAllergies: (verifiedOn: string) => string;
  readonly moreAllergies: (count: number) => string;
  readonly isolationPrefix: string;
  readonly mlcPrefix: string;
  readonly bloodGroupPrefix: string;
  readonly weightPrefix: string;
  readonly weightMissing: string;
  readonly uhidPrefix: string;
  readonly episodePrefix: string;
  readonly lengthOfStayPrefix: string;
  readonly payerPrefix: string;
  readonly breakGlass: string;
  readonly maskedNotice: string;
  readonly sex: Readonly<Record<PatientSex, string>>;
}

export type PatientBannerMode = 'full' | 'compact' | 'masked' | 'print';

interface BaseProps {
  readonly patient: PatientIdentity;
  readonly labels: PatientBannerLabels;
  /** Tabs / actions rendered under the identity block (§4.2). */
  readonly children?: ReactNode;
  readonly className?: string;
  readonly onFlagSelect?: (flag: string) => void;
}

export type PatientBannerProps =
  | (BaseProps & { readonly mode?: 'full' | 'compact' | 'print'; readonly onBreakGlass?: never })
  /** §4.2 — masked mode is only valid with an audited break-glass path. */
  | (BaseProps & { readonly mode: 'masked'; readonly onBreakGlass: () => void });

const ALERT_ICONS: Readonly<Record<PatientAlertKind, LucideIcon>> = {
  vip: ShieldAlert,
  'fall-risk': TriangleAlert,
  dnr: Ban,
  infection: Biohazard,
  deteriorating: HeartPulse,
  npo: CircleAlert,
  other: CircleAlert,
};

const ALERT_TONES: Readonly<Record<PatientAlertKind, string>> = {
  vip: 'border-violet-border text-violet-fg',
  'fall-risk': 'border-warning-border text-warning-fg',
  dnr: 'border-default text-fg-default',
  infection: 'border-success-border text-success-fg',
  deteriorating: 'border-danger-border text-danger-fg',
  npo: 'border-warning-border text-warning-fg',
  other: 'border-default text-fg-default',
};

const chipClassName = cn(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
  'text-2xs font-medium whitespace-nowrap',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
  '[&_svg]:size-3 [&_svg]:shrink-0',
);

/** Deterministic, information-free avatar tint — never keyed to sex or religion (§4.2). */
function avatarTint(uhid: string): string {
  let hash = 0;
  for (const char of uhid) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
  return hash % 2 === 0 ? 'bg-sunken' : 'bg-layer-3';
}

function initials(familyName: string, givenName: string): string {
  return `${familyName.slice(0, 1)}${givenName.slice(0, 1)}`.toUpperCase();
}

function AllergyFlag({
  status,
  labels,
  onFlagSelect,
}: {
  readonly status: AllergyStatus;
  readonly labels: PatientBannerLabels;
  readonly onFlagSelect?: (flag: string) => void;
}): React.JSX.Element {
  if (status.kind === 'not-recorded') {
    return (
      <span
        data-flag="allergy-not-recorded"
        className={cn(chipClassName, 'border-warning-border bg-warning-surface text-warning-on-surface')}
      >
        <AlertTriangle aria-hidden="true" />
        {labels.allergiesNotRecorded}
      </span>
    );
  }

  if (status.kind === 'unable-to-assess') {
    return (
      <span
        data-flag="allergy-unable-to-assess"
        className={cn(
          chipClassName,
          'border-violet-border bg-violet-surface text-violet-on-surface font-semibold',
        )}
      >
        <AlertTriangle aria-hidden="true" />
        {labels.allergiesUnableToAssess(status.reason)}
      </span>
    );
  }

  if (status.kind === 'none-known') {
    return (
      <span
        data-flag="allergy-none-known"
        className={cn(chipClassName, 'border-success-border bg-success-surface text-success-on-surface')}
      >
        {labels.noKnownAllergies(status.verifiedOn)}
      </span>
    );
  }

  const [first, ...rest] = status.allergies;
  const summary =
    first === undefined
      ? labels.allergiesNotRecorded
      : `${labels.allergyPrefix} ${first.substance} (${first.reaction})`;

  return (
    <button
      type="button"
      data-flag="allergy"
      title={
        first?.recordedBy === undefined ? undefined : `${first.recordedBy} ${first.recordedAt ?? ''}`.trim()
      }
      onClick={() => {
        onFlagSelect?.('allergy');
      }}
      className={cn(
        chipClassName,
        'border-danger-border bg-danger-surface text-danger-on-surface font-semibold',
      )}
    >
      <Ban aria-hidden="true" />
      {summary}
      {rest.length > 0 ? <span>{labels.moreAllergies(rest.length)}</span> : null}
    </button>
  );
}

export function PatientBanner(props: PatientBannerProps): React.JSX.Element {
  const { patient, labels, children, className, onFlagSelect } = props;
  const mode = props.mode ?? 'full';
  const masked = mode === 'masked';
  const compact = mode === 'compact';

  const displayName = masked
    ? `${initials(patient.familyName, patient.givenName)} · ${patient.uhid.slice(-4)}`
    : `${patient.familyName.toUpperCase()}, ${patient.givenName}`;

  return (
    <section
      data-slot="patient-banner"
      data-mode={mode}
      role="region"
      aria-label={labels.region}
      className={cn(
        'sticky top-0 z-sticky flex w-full flex-col gap-1 border-b border-default bg-layer-1',
        compact ? 'px-3 py-1' : 'px-4 py-2',
        mode === 'print' ? 'static border-b-2' : '',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        {mode === 'print' ? null : (
          <div
            aria-hidden="true"
            className={cn(
              'flex shrink-0 items-center justify-center rounded-md font-display font-semibold text-fg-default',
              compact ? 'size-8 text-sm' : 'size-14 text-xl',
              avatarTint(patient.uhid),
            )}
            style={
              patient.photoUrl !== undefined && !masked
                ? { backgroundImage: `url(${patient.photoUrl})`, backgroundSize: 'cover' }
                : undefined
            }
          >
            {patient.photoUrl === undefined || masked
              ? initials(patient.familyName, patient.givenName)
              : null}
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className={cn('font-semibold text-fg-default', compact ? 'text-md' : 'text-xl')}>
              {displayName}
            </h2>
            <span className="text-md text-fg-default">
              {patient.age} / {labels.sex[patient.sex]}
            </span>
            <span className="font-mono text-sm text-fg-muted">
              {labels.uhidPrefix} {patient.uhid}
            </span>
            {patient.episodeId === undefined ? null : (
              <span className="font-mono text-sm text-fg-muted">
                {labels.episodePrefix} {patient.episodeId}
              </span>
            )}
          </div>

          {/* §4.2 — allergies are always first in the flag row. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <AllergyFlag
              status={patient.allergies}
              labels={labels}
              {...(onFlagSelect === undefined ? {} : { onFlagSelect })}
            />

            {patient.isolation === undefined ? null : (
              <button
                type="button"
                data-flag="isolation"
                onClick={() => {
                  onFlagSelect?.('isolation');
                }}
                className={cn(chipClassName, 'border-violet-border bg-violet-surface text-violet-on-surface')}
              >
                <Biohazard aria-hidden="true" />
                {labels.isolationPrefix} {patient.isolation.type}
              </button>
            )}

            {patient.mlc === undefined ? null : (
              <button
                type="button"
                data-flag="mlc"
                onClick={() => {
                  onFlagSelect?.('mlc');
                }}
                className={cn(chipClassName, 'border-violet-border bg-violet-surface text-violet-on-surface')}
              >
                <Scale aria-hidden="true" />
                {labels.mlcPrefix} {patient.mlc.number}
              </button>
            )}

            {(patient.alerts ?? []).map((alert) => {
              const Icon = ALERT_ICONS[alert.kind];
              return (
                <button
                  key={`${alert.kind}-${alert.label}`}
                  type="button"
                  data-flag={`alert-${alert.kind}`}
                  onClick={() => {
                    onFlagSelect?.(alert.kind);
                  }}
                  className={cn(chipClassName, 'bg-layer-1', ALERT_TONES[alert.kind])}
                >
                  <Icon aria-hidden="true" />
                  {alert.label}
                </button>
              );
            })}

            {patient.bloodGroup === undefined ? null : (
              <span className={cn(chipClassName, 'border-default text-fg-default')}>
                {labels.bloodGroupPrefix} {patient.bloodGroup}
              </span>
            )}

            {/* §5.2 #18 — a missing paediatric weight is a blocking empty state, not a default. */}
            <span
              data-flag="weight"
              className={cn(
                chipClassName,
                patient.weightKg === undefined
                  ? 'border-warning-border bg-warning-surface text-warning-on-surface'
                  : 'border-default text-fg-default',
              )}
            >
              {patient.weightKg === undefined
                ? labels.weightMissing
                : `${labels.weightPrefix} ${String(patient.weightKg)}`}
            </span>
          </div>

          {compact ? null : (
            <p className="flex flex-wrap items-center gap-x-3 text-sm text-fg-muted">
              {patient.ward === undefined ? null : <span>{patient.ward}</span>}
              {patient.bed === undefined ? null : <span>{patient.bed}</span>}
              {patient.lengthOfStay === undefined ? null : (
                <span>
                  {labels.lengthOfStayPrefix} {patient.lengthOfStay}
                </span>
              )}
              {patient.attendingConsultant === undefined ? null : (
                <span>
                  {patient.attendingConsultant}
                  {patient.department === undefined ? '' : ` (${patient.department})`}
                </span>
              )}
              {patient.payer === undefined ? null : (
                <span>
                  {labels.payerPrefix} {patient.payer}
                  {patient.creditStatus === undefined ? '' : ` · ${patient.creditStatus}`}
                </span>
              )}
            </p>
          )}
        </div>

        {masked ? (
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span className="text-2xs text-fg-muted">{labels.maskedNotice}</span>
            <Button variant="danger" size="sm" onClick={props.onBreakGlass}>
              {labels.breakGlass}
            </Button>
          </div>
        ) : null}
      </div>

      {children}
    </section>
  );
}
