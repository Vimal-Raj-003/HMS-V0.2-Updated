'use client';

import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@vims/ui';
import { useId } from 'react';
import { OctagonAlert, X } from '@/lib/icons';
import {
  DOSE_BASES,
  DURATION_UNITS,
  TIMINGS,
  type DoseBasis,
  type DurationUnit,
  type Timing,
} from '../api/types';
import {
  DOSE_BASIS_LABELS,
  DURATION_LABELS,
  FREQUENCIES,
  TIMING_LABELS,
  lineProblems,
  type RxLine,
} from '../lib/prescription';
import type { WeightRequired } from '../lib/problems';

/**
 * One prescription line — OP-002 §8's e-Rx grid row.
 *
 * ## The per-kilogram rule
 *
 * Switching a line to "per kilogram" asks the encounter whether a dosing weight
 * exists (`POST /encounters/{id}/dosing-weight/check`). If it does not, the API
 * refuses with a hard stop, and this row renders the refusal **as an
 * instruction**: *record a weight first*, with the clinical reason underneath
 * and the reference for the helpdesk. It does not render "422", it does not
 * render "Stopped for patient safety" over an empty box, and it emphatically
 * does not offer a weight field of its own — the weight is a fact about the
 * patient recorded on the encounter, not a number typed into a prescription to
 * make an error message go away.
 *
 * Where a weight does exist, the computed milligrams are shown with the
 * arithmetic visible (`docs/06` §10: "`DoseCalculator` shows the arithmetic",
 * against "a free-text mg field for a 12 kg child").
 */
export function DoseBuilder({
  line,
  onChange,
  onRemove,
  disabled,
  weightRequired,
  computedDose,
  checking,
}: {
  readonly line: RxLine;
  readonly onChange: (next: RxLine) => void;
  readonly onRemove: () => void;
  readonly disabled: boolean;
  /** Set when a per-kilogram dose was refused for want of a weight. */
  readonly weightRequired: WeightRequired | null;
  /** `mgPerKg × weight`, with the weight it used, when the encounter has one. */
  readonly computedDose: { readonly doseMg: number; readonly weightKg: number } | null;
  readonly checking: boolean;
}): React.JSX.Element {
  const doseId = useId();
  const unitId = useId();
  const basisId = useId();
  const frequencyId = useId();
  const timingId = useId();
  const durationId = useId();
  const durationUnitId = useId();
  const instructionsId = useId();
  const prnId = useId();

  const problems = lineProblems(line);

  return (
    <li
      className="flex flex-col gap-3 rounded-lg border border-default bg-layer-1 p-3"
      data-testid={`rx-line-${line.key}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-fg-default" data-testid="rx-line-name">
            {line.genericName === '' ? 'No drug chosen' : line.genericName}
          </span>
          {line.strengthText === null ? null : (
            <span className="text-2xs text-fg-muted">{line.strengthText}</span>
          )}
          {line.isHighAlert ? (
            <Badge tone="danger" size="sm">
              High alert
            </Badge>
          ) : null}
          {line.isLasa ? (
            <Badge tone="warning" size="sm">
              Look-alike
            </Badge>
          ) : null}
          {line.schedule === null ? null : (
            <Badge tone="neutral" size="sm">
              Schedule {line.schedule.toUpperCase()}
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          data-testid={`rx-remove-${line.key}`}
          disabled={disabled}
          onClick={onRemove}
        >
          <X className="size-4" aria-hidden="true" />
          Remove this line
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor={doseId}>Dose</Label>
          <Input
            id={doseId}
            data-testid={`rx-dose-${line.key}`}
            className="tabular-nums"
            inputMode="decimal"
            value={line.doseQty}
            disabled={disabled}
            autoComplete="off"
            onChange={(event) => {
              onChange({ ...line, doseQty: event.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={unitId}>Unit</Label>
          <Input
            id={unitId}
            data-testid={`rx-unit-${line.key}`}
            value={line.doseUnit}
            disabled={disabled}
            autoComplete="off"
            onChange={(event) => {
              onChange({ ...line, doseUnit: event.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={basisId}>How the dose is worked out</Label>
          <Select
            value={line.doseBasis}
            disabled={disabled}
            onValueChange={(value) => {
              onChange({ ...line, doseBasis: value as DoseBasis });
            }}
          >
            <SelectTrigger id={basisId} data-testid={`rx-basis-${line.key}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DOSE_BASES.map((basis) => (
                <SelectItem key={basis} value={basis}>
                  {DOSE_BASIS_LABELS[basis]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={frequencyId}>Frequency</Label>
          <Select
            {...(line.frequencyCode === '' ? {} : { value: line.frequencyCode })}
            disabled={disabled}
            onValueChange={(value) => {
              onChange({ ...line, frequencyCode: value });
            }}
          >
            <SelectTrigger id={frequencyId} data-testid={`rx-frequency-${line.key}`}>
              <SelectValue placeholder="How often" />
            </SelectTrigger>
            <SelectContent>
              {FREQUENCIES.map((frequency) => (
                <SelectItem key={frequency.code} value={frequency.code}>
                  {frequency.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={timingId}>Timing</Label>
          <Select
            {...(line.timing === '' ? {} : { value: line.timing })}
            disabled={disabled}
            onValueChange={(value) => {
              onChange({ ...line, timing: value as Timing });
            }}
          >
            <SelectTrigger id={timingId} data-testid={`rx-timing-${line.key}`}>
              <SelectValue placeholder="When to take it" />
            </SelectTrigger>
            <SelectContent>
              {TIMINGS.map((timing) => (
                <SelectItem key={timing} value={timing}>
                  {TIMING_LABELS[timing]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={durationId}>For</Label>
          <Input
            id={durationId}
            data-testid={`rx-duration-${line.key}`}
            className="tabular-nums"
            inputMode="numeric"
            value={line.durationValue}
            disabled={disabled}
            autoComplete="off"
            onChange={(event) => {
              onChange({ ...line, durationValue: event.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={durationUnitId}>Duration unit</Label>
          <Select
            value={line.durationUnit}
            disabled={disabled}
            onValueChange={(value) => {
              onChange({ ...line, durationUnit: value as DurationUnit });
            }}
          >
            <SelectTrigger id={durationUnitId} data-testid={`rx-duration-unit-${line.key}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DURATION_UNITS.map((unit) => (
                <SelectItem key={unit} value={unit}>
                  {DURATION_LABELS[unit]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={prnId}>Only when required</Label>
          <div className="flex h-10 items-center gap-2">
            <Switch
              id={prnId}
              data-testid={`rx-prn-${line.key}`}
              checked={line.isPrn}
              disabled={disabled}
              onCheckedChange={(checked) => {
                onChange({ ...line, isPrn: checked });
              }}
            />
            <span className="text-2xs text-fg-muted">PRN</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={instructionsId}>Instructions for the patient</Label>
        <Input
          id={instructionsId}
          data-testid={`rx-instructions-${line.key}`}
          value={line.instructionsText}
          disabled={disabled}
          autoComplete="off"
          onChange={(event) => {
            onChange({ ...line, instructionsText: event.target.value });
          }}
        />
      </div>

      {line.doseBasis === 'per_kg' ? (
        checking ? (
          <p className="text-2xs text-fg-muted" data-testid={`rx-weight-checking-${line.key}`}>
            Checking whether this patient has a recorded weight…
          </p>
        ) : weightRequired !== null ? (
          <div
            role="alert"
            data-testid={`rx-weight-required-${line.key}`}
            className="rounded-md border border-danger-border bg-danger-surface p-3"
          >
            <p className="flex items-center gap-2 text-sm font-medium text-danger-on-surface">
              <OctagonAlert className="size-4 shrink-0" aria-hidden="true" />
              {weightRequired.title}
            </p>
            <p className="mt-1 text-sm text-danger-on-surface">{weightRequired.instruction}</p>
            <p className="mt-1 text-2xs text-danger-on-surface">{weightRequired.clinicalImpact}</p>
            <p className="mt-2 font-mono text-2xs text-fg-muted">
              Reference: <span data-testid="weight-required-reference">{weightRequired.reference}</span>
            </p>
          </div>
        ) : computedDose !== null ? (
          <p className="text-2xs text-fg-muted" data-testid={`rx-dose-computed-${line.key}`}>
            {line.doseQty} {line.doseUnit}/kg × {computedDose.weightKg} kg ={' '}
            <span className="font-medium text-fg-default">
              {computedDose.doseMg} {line.doseUnit}
            </span>{' '}
            per dose, worked out from the weight recorded on this consultation.
          </p>
        ) : null
      ) : null}

      {problems.length === 0 ? null : (
        // The live region is the wrapper, not the list: `role="alert"` on a
        // `<ul>` replaces its list role, which orphans every `<li>` inside it
        // and is a WCAG failure axe catches.
        <div role="alert">
          <ul className="flex flex-col gap-1">
            {problems.map((problem) => (
              <li key={problem} className="text-2xs text-danger-on-surface">
                {problem}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}
