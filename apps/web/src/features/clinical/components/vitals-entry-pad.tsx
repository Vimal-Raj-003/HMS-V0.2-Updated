'use client';

import {
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
import {
  GLUCOSE_TYPE_LABELS,
  VITALS_FIELDS,
  type FieldVerdict,
  type NumericField,
  type VitalsFormState,
} from '../lib/vitals-form';
import { GLUCOSE_TYPES, type GlucoseType } from '../api/types';
import { FlagChip } from './flag-chip';

/**
 * The capture form — OP-007 §8, "large controls, tablet-friendly", ≤ 45 s per
 * patient.
 *
 * Three things it does that a generic form would not:
 *
 *  - **Every field is optional.** A department policy decides which are
 *    mandatory, and a nurse who could not take a temperature must still be able
 *    to save what they did take. A field left blank is *omitted* from the
 *    request, never sent as zero.
 *  - **The verdict sits beside the value, live**, and it is a chip with an icon
 *    and a word rather than a colour (`docs/06` §1.2.3). Where no band is
 *    configured — or where this session may not read the bands at all — the chip
 *    says "not scored" and does not guess.
 *  - **Touch targets are 48 px** (`h-12`) with the numeric keypad hinted per
 *    field, because this runs on a stand-mounted tablet with gloves on.
 *
 * The component holds no clinical knowledge: it renders the verdicts it is
 * handed. Every threshold behind those verdicts is the hospital's, read from
 * `clinical.vitals_reference_ranges`.
 */
export function VitalsEntryPad({
  state,
  verdicts,
  onChange,
  disabled = false,
  bandsAvailable,
}: {
  readonly state: VitalsFormState;
  readonly verdicts: readonly FieldVerdict[];
  readonly onChange: (next: VitalsFormState) => void;
  readonly disabled?: boolean;
  /** False when this session may not read the configured bands. Changes the words, never the numbers. */
  readonly bandsAvailable: boolean;
}): React.JSX.Element {
  const oxygenId = useId();
  const glucoseTypeId = useId();
  const notesId = useId();

  const set = (key: NumericField | 'notes', value: string): void => {
    onChange({ ...state, [key]: value });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="vitals-entry-pad">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {VITALS_FIELDS.map((field) => {
          const verdict = verdicts.find((candidate) => candidate.field.key === field.key);
          const invalid = verdict?.outOfRange !== null && verdict?.outOfRange !== undefined;
          const implausible = verdict?.implausible ?? null;
          const message = verdict?.outOfRange ?? implausible;

          return (
            <div key={field.key} className="flex flex-col gap-1">
              <Label htmlFor={`vitals-${field.key}`} className="text-sm">
                {field.label}{' '}
                <span className="text-fg-subtle" aria-hidden="true">
                  ({field.unit})
                </span>
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`vitals-${field.key}`}
                  data-testid={`vitals-${field.key}`}
                  className="h-12 flex-1 text-lg tabular-nums"
                  value={state[field.key]}
                  disabled={disabled}
                  type="number"
                  inputMode={field.inputMode}
                  step={field.step}
                  min={field.min}
                  max={field.max}
                  autoComplete="off"
                  aria-invalid={invalid || implausible !== null}
                  aria-describedby={message === null ? undefined : `vitals-${field.key}-msg`}
                  // The unit is in the visible label; screen readers get it here
                  // too, because a bare number read out of context is a number
                  // somebody has to guess the units of.
                  aria-label={`${field.label} in ${field.unit}`}
                  onChange={(event) => {
                    set(field.key, event.target.value);
                  }}
                />
                <FlagChip flag={verdict?.flag ?? null} />
              </div>
              {message === null ? null : (
                <p
                  id={`vitals-${field.key}-msg`}
                  role="alert"
                  className="text-2xs text-danger-on-surface"
                  data-testid={`vitals-${field.key}-msg`}
                >
                  {message}
                </p>
              )}
            </div>
          );
        })}

        <div className="flex flex-col gap-1">
          <Label htmlFor={glucoseTypeId} className="text-sm">
            Which glucose test
          </Label>
          <Select
            {...(state.glucoseType === '' ? {} : { value: state.glucoseType })}
            disabled={disabled}
            onValueChange={(value) => {
              onChange({ ...state, glucoseType: value as GlucoseType });
            }}
          >
            <SelectTrigger id={glucoseTypeId} data-testid="vitals-glucose-type" className="h-12">
              <SelectValue placeholder="Choose the test" />
            </SelectTrigger>
            <SelectContent>
              {GLUCOSE_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {GLUCOSE_TYPE_LABELS[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-2xs text-fg-muted">
            A glucose value is scored against a different band for each test, so the reading is refused
            without it.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={oxygenId} className="text-sm">
            On supplemental oxygen
          </Label>
          <div className="flex h-12 items-center gap-3">
            <Switch
              id={oxygenId}
              data-testid="vitals-on-oxygen"
              checked={state.onOxygen}
              disabled={disabled}
              onCheckedChange={(checked) => {
                onChange({ ...state, onOxygen: checked });
              }}
            />
            <span className="text-sm text-fg-muted">
              Changes the NEWS2 the server scores. Room air is the default.
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={notesId} className="text-sm">
          Nursing remarks
        </Label>
        <Input
          id={notesId}
          data-testid="vitals-notes"
          className="h-12"
          value={state.notes}
          disabled={disabled}
          autoComplete="off"
          onChange={(event) => {
            set('notes', event.target.value);
          }}
        />
      </div>

      {bandsAvailable ? null : (
        <p role="status" data-testid="bands-unavailable" className="text-2xs text-fg-muted">
          This login cannot read the hospital’s abnormal and critical bands, so nothing is coloured while you
          type. The server applies them when you save, and the saved reading below carries its verdict and any
          alert it raised.
        </p>
      )}
    </div>
  );
}
