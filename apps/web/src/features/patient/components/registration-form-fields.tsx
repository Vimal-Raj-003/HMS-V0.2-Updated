'use client';

import {
  AddressForm,
  AllergyEditor,
  Badge,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vims/ui';
import { useId } from 'react';
import type { Gender } from '../api/types';
import {
  ADDRESS_LABELS,
  ALLERGY_LABELS,
  BLOOD_GROUPS,
  CATEGORIES,
  GENDERS,
  INDIAN_STATES,
  LANGUAGES,
  PAYER_TYPES,
  UNABLE_TO_ASSESS_REASONS,
} from '../lib/reference';
import type { FormErrors, RegistrationFormState } from '../lib/registration-form';

/**
 * The registration form's fields.
 *
 * Split out of `registration-desk.tsx` so the screen file is about *flow* — search,
 * hard stop, save, print — and this one is about *fields*. They are the two things
 * that change for different reasons.
 *
 * Every control here is a native input or a Radix primitive, which is what makes
 * `phase-01` §1.8's "fully operable without a mouse" true rather than aspirational:
 * `Select` is Radix's listbox (type-ahead, arrow keys, Home/End), `Checkbox` is a
 * real checkbox, and there is no custom widget with a `div` for a control anywhere
 * in the tab order.
 *
 * Field order is the order a receptionist asks the questions in — mobile first,
 * because that is what the duplicate search keys on and what the patient says
 * without being asked twice.
 */

export interface FieldsProps {
  readonly form: RegistrationFormState;
  readonly errors: FormErrors;
  readonly onChange: (patch: Partial<RegistrationFormState>) => void;
  readonly disabled: boolean;
  /** Focused by F2 and on mount: the field the ≤ 90-second budget starts at. */
  readonly firstFieldRef: React.RefObject<HTMLInputElement | null>;
  readonly asserter: { readonly name: string; readonly on: string };
  readonly newEntryId: () => string;
}

function Field({
  id,
  label,
  error,
  hint,
  required,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly error?: string | undefined;
  readonly hint?: string;
  readonly required?: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} required={required === true}>
        {label}
      </Label>
      {children}
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-xs text-fg-muted">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger-fg">
          {error}
        </p>
      )}
    </div>
  );
}

export function RegistrationFormFields({
  form,
  errors,
  onChange,
  disabled,
  firstFieldRef,
  asserter,
  newEntryId,
}: FieldsProps): React.JSX.Element {
  const id = useId();
  const field = (name: string): string => `${id}-${name}`;
  const describedBy = (name: string, hint = false): string | undefined => {
    const parts: string[] = [];
    if (hint) parts.push(`${field(name)}-hint`);
    if (errors[name] !== undefined) parts.push(`${field(name)}-error`);
    return parts.length === 0 ? undefined : parts.join(' ');
  };

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby={field('contact-heading')} className="flex flex-col gap-3">
        <h3 id={field('contact-heading')} className="text-md font-semibold text-fg-default">
          How we reach them
        </h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field
            id={field('mobile')}
            label="Mobile"
            required
            error={errors['mobile']}
            hint="Checked against the index as you save. A family may share one number."
          >
            <Input
              id={field('mobile')}
              ref={firstFieldRef}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              dir="ltr"
              disabled={disabled}
              value={form.mobile}
              aria-required="true"
              aria-invalid={errors['mobile'] === undefined ? undefined : true}
              aria-describedby={describedBy('mobile', true)}
              data-testid="reg-mobile"
              onChange={(event) => {
                onChange({ mobile: event.target.value });
              }}
            />
          </Field>

          <Field id={field('altPhone')} label="Alternate phone">
            <Input
              id={field('altPhone')}
              type="tel"
              inputMode="tel"
              dir="ltr"
              disabled={disabled}
              value={form.altPhone}
              onChange={(event) => {
                onChange({ altPhone: event.target.value });
              }}
            />
          </Field>

          <Field id={field('email')} label="Email" error={errors['email']}>
            <Input
              id={field('email')}
              type="email"
              autoComplete="email"
              dir="ltr"
              disabled={disabled}
              value={form.email}
              aria-invalid={errors['email'] === undefined ? undefined : true}
              aria-describedby={describedBy('email')}
              onChange={(event) => {
                onChange({ email: event.target.value });
              }}
            />
          </Field>

          <Field
            id={field('preferredLanguage')}
            label="Preferred language"
            hint="The language the privacy notice, receipts and messages are produced in."
          >
            <Select
              value={form.preferredLanguage}
              disabled={disabled}
              onValueChange={(value) => {
                onChange({ preferredLanguage: value });
              }}
            >
              <SelectTrigger
                id={field('preferredLanguage')}
                aria-describedby={describedBy('preferredLanguage', true)}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((language) => (
                  <SelectItem key={language.code} value={language.code}>
                    {language.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id={field('whatsapp')}
            checked={form.whatsappOptIn}
            disabled={disabled}
            onCheckedChange={(checked) => {
              onChange({ whatsappOptIn: checked === true });
            }}
          />
          <Label htmlFor={field('whatsapp')} className="font-normal">
            The patient agrees to receive WhatsApp messages about their care
          </Label>
        </div>
      </section>

      <section aria-labelledby={field('identity-heading')} className="flex flex-col gap-3">
        <h3 id={field('identity-heading')} className="text-md font-semibold text-fg-default">
          Who they are
        </h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <Field id={field('titleCode')} label="Title">
            <Input
              id={field('titleCode')}
              disabled={disabled}
              value={form.titleCode}
              autoComplete="honorific-prefix"
              onChange={(event) => {
                onChange({ titleCode: event.target.value });
              }}
            />
          </Field>
          <Field id={field('firstName')} label="First name" required error={errors['firstName']}>
            <Input
              id={field('firstName')}
              disabled={disabled}
              value={form.firstName}
              autoComplete="given-name"
              aria-required="true"
              aria-invalid={errors['firstName'] === undefined ? undefined : true}
              aria-describedby={describedBy('firstName')}
              data-testid="reg-first-name"
              onChange={(event) => {
                onChange({ firstName: event.target.value });
              }}
            />
          </Field>
          <Field id={field('middleName')} label="Middle name">
            <Input
              id={field('middleName')}
              disabled={disabled}
              value={form.middleName}
              autoComplete="additional-name"
              onChange={(event) => {
                onChange({ middleName: event.target.value });
              }}
            />
          </Field>
          <Field id={field('lastName')} label="Last name">
            <Input
              id={field('lastName')}
              disabled={disabled}
              value={form.lastName}
              autoComplete="family-name"
              data-testid="reg-last-name"
              onChange={(event) => {
                onChange({ lastName: event.target.value });
              }}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field id={field('gender')} label="Sex" required>
            <Select
              value={form.gender}
              disabled={disabled}
              onValueChange={(value) => {
                onChange({ gender: value as Gender });
              }}
            >
              <SelectTrigger id={field('gender')} aria-required="true" data-testid="reg-gender">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GENDERS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field
            id={field('ageBasis')}
            label="Age is known as"
            hint="An age-only registration is stored with an estimated date of birth and is marked as such everywhere."
          >
            <Select
              value={form.ageBasis}
              disabled={disabled}
              onValueChange={(value) => {
                onChange({ ageBasis: value === 'age' ? 'age' : 'dob' });
              }}
            >
              <SelectTrigger id={field('ageBasis')} aria-describedby={describedBy('ageBasis', true)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dob">A date of birth</SelectItem>
                <SelectItem value="age">An age only</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field id={field('bloodGroup')} label="Blood group">
            <Select
              value={form.bloodGroup}
              disabled={disabled}
              onValueChange={(value) => {
                onChange({ bloodGroup: value });
              }}
            >
              <SelectTrigger id={field('bloodGroup')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BLOOD_GROUPS.map((group) => (
                  <SelectItem key={group.code} value={group.code}>
                    {group.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        {form.ageBasis === 'dob' ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field id={field('dob')} label="Date of birth" required error={errors['dob']}>
              <Input
                id={field('dob')}
                type="date"
                disabled={disabled}
                value={form.dob}
                autoComplete="bday"
                aria-required="true"
                aria-invalid={errors['dob'] === undefined ? undefined : true}
                aria-describedby={describedBy('dob')}
                data-testid="reg-dob"
                onChange={(event) => {
                  onChange({ dob: event.target.value });
                }}
              />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field id={field('ageYears')} label="Years" error={errors['ageYears']}>
              <Input
                id={field('ageYears')}
                inputMode="numeric"
                disabled={disabled}
                value={form.ageYears}
                aria-invalid={errors['ageYears'] === undefined ? undefined : true}
                aria-describedby={describedBy('ageYears')}
                data-testid="reg-age-years"
                onChange={(event) => {
                  onChange({ ageYears: event.target.value.replace(/\D/g, '') });
                }}
              />
            </Field>
            <Field id={field('ageMonths')} label="Months">
              <Input
                id={field('ageMonths')}
                inputMode="numeric"
                disabled={disabled}
                value={form.ageMonths}
                onChange={(event) => {
                  onChange({ ageMonths: event.target.value.replace(/\D/g, '') });
                }}
              />
            </Field>
            <Field id={field('ageDays')} label="Days">
              <Input
                id={field('ageDays')}
                inputMode="numeric"
                disabled={disabled}
                value={form.ageDays}
                onChange={(event) => {
                  onChange({ ageDays: event.target.value.replace(/\D/g, '') });
                }}
              />
            </Field>
          </div>
        )}
      </section>

      <section aria-labelledby={field('address-heading')} className="flex flex-col gap-3">
        <h3 id={field('address-heading')} className="text-md font-semibold text-fg-default">
          Where they live
        </h3>
        <AddressForm
          value={form.address}
          disabled={disabled}
          labels={ADDRESS_LABELS}
          states={INDIAN_STATES}
          onChange={(address) => {
            onChange({ address });
          }}
        />
        <p className="text-xs text-fg-muted">
          The PIN-code directory (EN-036&rsquo;s India Post dataset) is not loaded yet, so the district and
          state are typed rather than filled in.
        </p>
      </section>

      <section aria-labelledby={field('emergency-heading')} className="flex flex-col gap-3">
        <h3 id={field('emergency-heading')} className="text-md font-semibold text-fg-default">
          Who to contact
        </h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field id={field('emergencyName')} label="Name" error={errors['emergencyName']}>
            <Input
              id={field('emergencyName')}
              disabled={disabled}
              value={form.emergencyName}
              aria-invalid={errors['emergencyName'] === undefined ? undefined : true}
              aria-describedby={describedBy('emergencyName')}
              data-testid="reg-emergency-name"
              onChange={(event) => {
                onChange({ emergencyName: event.target.value });
              }}
            />
          </Field>
          <Field id={field('emergencyRelation')} label="Relationship">
            <Input
              id={field('emergencyRelation')}
              disabled={disabled}
              value={form.emergencyRelation}
              placeholder="e.g. mother, spouse, neighbour"
              onChange={(event) => {
                onChange({ emergencyRelation: event.target.value });
              }}
            />
          </Field>
          <Field id={field('emergencyPhone')} label="Phone" error={errors['emergencyPhone']}>
            <Input
              id={field('emergencyPhone')}
              type="tel"
              dir="ltr"
              disabled={disabled}
              value={form.emergencyPhone}
              aria-invalid={errors['emergencyPhone'] === undefined ? undefined : true}
              aria-describedby={describedBy('emergencyPhone')}
              onChange={(event) => {
                onChange({ emergencyPhone: event.target.value });
              }}
            />
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id={field('guardian')}
            checked={form.emergencyIsGuardian}
            disabled={disabled}
            data-testid="reg-is-guardian"
            onCheckedChange={(checked) => {
              onChange({ emergencyIsGuardian: checked === true });
            }}
          />
          <Label htmlFor={field('guardian')} className="font-normal">
            This contact is the patient&rsquo;s guardian
          </Label>
          <Badge tone="info" size="sm">
            Required under 18
          </Badge>
        </div>
      </section>

      <section aria-labelledby={field('allergy-heading')} className="flex flex-col gap-2">
        <h3 id={field('allergy-heading')} className="text-md font-semibold text-fg-default">
          Allergies
        </h3>
        <AllergyEditor
          statement={form.allergy}
          labels={ALLERGY_LABELS}
          asserter={asserter}
          unableToAssessReasons={UNABLE_TO_ASSESS_REASONS}
          newEntryId={newEntryId}
          onChange={(allergy) => {
            onChange({ allergy });
          }}
        />
        {errors['allergy'] === undefined ? null : (
          <p role="alert" className="text-xs text-danger-fg" data-testid="reg-allergy-error">
            {errors['allergy']}
          </p>
        )}
      </section>

      <section aria-labelledby={field('admin-heading')} className="flex flex-col gap-3">
        <h3 id={field('admin-heading')} className="text-md font-semibold text-fg-default">
          Who pays, and how they found us
        </h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field id={field('category')} label="Patient category">
            <Select
              value={form.category}
              disabled={disabled}
              onValueChange={(value) => {
                onChange({ category: value });
              }}
            >
              <SelectTrigger id={field('category')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((category) => (
                  <SelectItem key={category.code} value={category.code}>
                    {category.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field id={field('payerType')} label="Who pays">
            <Select
              value={form.payerType}
              disabled={disabled}
              onValueChange={(value) => {
                onChange({ payerType: value });
              }}
            >
              <SelectTrigger id={field('payerType')} data-testid="reg-payer-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYER_TYPES.map((payer) => (
                  <SelectItem key={payer.code} value={payer.code}>
                    {payer.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field id={field('payerRef')} label="Employee, policy or card number" error={errors['payerRef']}>
            <Input
              id={field('payerRef')}
              disabled={disabled}
              value={form.payerRef}
              aria-invalid={errors['payerRef'] === undefined ? undefined : true}
              aria-describedby={describedBy('payerRef')}
              data-testid="reg-payer-ref"
              onChange={(event) => {
                onChange({ payerRef: event.target.value });
              }}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field
            id={field('idTypeCode')}
            label="Photo ID type"
            hint="Passport, voter ID, driving licence or PAN. Aadhaar is not accepted here."
          >
            <Input
              id={field('idTypeCode')}
              disabled={disabled}
              value={form.idTypeCode}
              aria-describedby={describedBy('idTypeCode', true)}
              onChange={(event) => {
                onChange({ idTypeCode: event.target.value });
              }}
            />
          </Field>
          <Field
            id={field('idLast4')}
            label="Last four digits of that ID"
            error={errors['idLast4']}
            hint="Only the last four are stored, ever."
          >
            <Input
              id={field('idLast4')}
              inputMode="numeric"
              maxLength={4}
              disabled={disabled}
              value={form.idLast4}
              aria-invalid={errors['idLast4'] === undefined ? undefined : true}
              aria-describedby={describedBy('idLast4', true)}
              onChange={(event) => {
                onChange({ idLast4: event.target.value.replace(/\D/g, '').slice(0, 4) });
              }}
            />
          </Field>
          <Field id={field('referralSourceCode')} label="How they found us">
            <Input
              id={field('referralSourceCode')}
              disabled={disabled}
              value={form.referralSourceCode}
              placeholder="e.g. self, camp, referring doctor"
              onChange={(event) => {
                onChange({ referralSourceCode: event.target.value });
              }}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field
            id={field('abhaNumber')}
            label="ABHA number"
            hint="Optional and never a condition of treatment. Leave blank if the patient does not have one."
          >
            <Input
              id={field('abhaNumber')}
              disabled={disabled}
              dir="ltr"
              value={form.abhaNumber}
              aria-describedby={describedBy('abhaNumber', true)}
              onChange={(event) => {
                onChange({ abhaNumber: event.target.value });
              }}
            />
          </Field>
          <Field id={field('abhaAddress')} label="ABHA address">
            <Input
              id={field('abhaAddress')}
              disabled={disabled}
              dir="ltr"
              value={form.abhaAddress}
              placeholder="name@abdm"
              onChange={(event) => {
                onChange({ abhaAddress: event.target.value });
              }}
            />
          </Field>
        </div>

        <fieldset className="flex flex-wrap gap-x-6 gap-y-2">
          <legend className="text-sm text-fg-muted">Flags that change how they are queued</legend>
          <span className="flex items-center gap-2">
            <Checkbox
              id={field('isDifferentlyAbled')}
              checked={form.isDifferentlyAbled}
              disabled={disabled}
              onCheckedChange={(checked) => {
                onChange({ isDifferentlyAbled: checked === true });
              }}
            />
            <Label htmlFor={field('isDifferentlyAbled')} className="font-normal">
              Differently abled
            </Label>
          </span>
          <span className="flex items-center gap-2">
            <Checkbox
              id={field('isPregnant')}
              checked={form.isPregnant}
              disabled={disabled}
              onCheckedChange={(checked) => {
                onChange({ isPregnant: checked === true });
              }}
            />
            <Label htmlFor={field('isPregnant')} className="font-normal">
              Pregnant
            </Label>
          </span>
          <span className="flex items-center gap-2">
            <Checkbox
              id={field('isVip')}
              checked={form.isVip}
              disabled={disabled}
              onCheckedChange={(checked) => {
                onChange({ isVip: checked === true });
              }}
            />
            <Label htmlFor={field('isVip')} className="font-normal">
              VIP — record access is more closely audited
            </Label>
          </span>
        </fieldset>
      </section>
    </div>
  );
}
