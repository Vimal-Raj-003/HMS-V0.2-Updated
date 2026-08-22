import { emptyIndianAddress, type AllergyStatement, type IndianAddress } from '@vims/ui';
import type { Gender } from '../api/types';
import type { RegisterPatientInput } from '../api/client';
import { isRegistrationStatement, toRegisterAllergyInput } from './allergy';

/**
 * The registration desk's form state and the pure functions that validate it and
 * turn it into a request.
 *
 * They live here, outside the component, for the reason `CLAUDE.md` §5 gives:
 * business rules do not live in React components. It also means the ≤ 90-second
 * budget can be reasoned about — every rule below is one a clerk hits at speed,
 * and each is asserted in `registration-form.spec.ts`.
 *
 * The rules mirror `services/api`'s `registerPatientSchema` so the desk is told
 * *before* the round trip. They are deliberately **not** stricter than the
 * server's: a field the server accepts and this refuses is a patient who cannot
 * be registered, which is the worse failure of the two.
 *
 * **There is no Aadhaar field.** The API accepts none in any form, `docs/OP-001`
 * §5 forbids storing the number, and adding an input for it here would be an
 * invitation to collect something nothing can lawfully receive.
 */

export type AgeBasis = 'dob' | 'age';

export interface RegistrationFormState {
  readonly titleCode: string;
  readonly firstName: string;
  readonly middleName: string;
  readonly lastName: string;
  readonly gender: Gender;
  readonly ageBasis: AgeBasis;
  readonly dob: string;
  readonly ageYears: string;
  readonly ageMonths: string;
  readonly ageDays: string;
  readonly bloodGroup: string;
  readonly mobile: string;
  readonly altPhone: string;
  readonly email: string;
  readonly whatsappOptIn: boolean;
  readonly preferredLanguage: string;
  readonly idTypeCode: string;
  readonly idLast4: string;
  readonly abhaNumber: string;
  readonly abhaAddress: string;
  readonly address: IndianAddress;
  readonly category: string;
  readonly payerType: string;
  readonly payerRef: string;
  readonly referralSourceCode: string;
  readonly isVip: boolean;
  readonly isDifferentlyAbled: boolean;
  readonly isPregnant: boolean;
  readonly allergy: AllergyStatement;
  readonly emergencyName: string;
  readonly emergencyRelation: string;
  readonly emergencyPhone: string;
  /**
   * OP-001 §14 AC-12 / DPDP Rules 2025: a minor needs a responsible adult on the
   * record. The API refuses the save without one, so the desk marks the emergency
   * contact as the guardian rather than typing the same person twice.
   */
  readonly emergencyIsGuardian: boolean;
}

export function emptyRegistrationForm(): RegistrationFormState {
  return {
    titleCode: '',
    firstName: '',
    middleName: '',
    lastName: '',
    gender: 'unknown',
    ageBasis: 'dob',
    dob: '',
    ageYears: '',
    ageMonths: '',
    ageDays: '',
    bloodGroup: 'unknown',
    mobile: '',
    altPhone: '',
    email: '',
    whatsappOptIn: false,
    preferredLanguage: 'en-IN',
    idTypeCode: '',
    idLast4: '',
    abhaNumber: '',
    abhaAddress: '',
    address: emptyIndianAddress('IN'),
    category: 'general',
    payerType: 'self',
    payerRef: '',
    referralSourceCode: '',
    isVip: false,
    isDifferentlyAbled: false,
    isPregnant: false,
    allergy: { kind: 'not-recorded' },
    emergencyName: '',
    emergencyRelation: '',
    emergencyPhone: '',
    emergencyIsGuardian: false,
  };
}

/** Field-path → message, in the same shape a problem document's `errors[]` uses. */
export type FormErrors = Readonly<Record<string, string>>;

const PAYER_REF_REQUIRED = new Set(['insurance', 'corporate', 'scheme']);

/**
 * Everything the desk can be told without asking the server.
 *
 * Age in whole years is computed from the date of birth for the minor rule only;
 * the authoritative age still comes back from the API, which computes it from the
 * stored `dob` in the hospital's zone.
 */
export function validateRegistration(form: RegistrationFormState, now: Date = new Date()): FormErrors {
  const errors: Record<string, string> = {};

  if (form.firstName.trim() === '') {
    errors['firstName'] = 'A name is the one thing the record cannot be created without.';
  }

  const digits = form.mobile.replace(/\D/g, '');
  if (digits.length < 6) {
    errors['mobile'] =
      'That is not a usable phone number. Include the area or country code — it is how the patient is contacted about results.';
  }

  if (form.ageBasis === 'dob') {
    if (form.dob.trim() === '') {
      errors['dob'] = 'Give a date of birth, or switch to age if the patient does not know it.';
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(form.dob)) {
      errors['dob'] = 'Use the date picker, or type the date as YYYY-MM-DD.';
    } else {
      const born = new Date(`${form.dob}T00:00:00Z`);
      if (Number.isNaN(born.getTime())) {
        errors['dob'] = 'That is not a real date.';
      } else if (born.getTime() > now.getTime()) {
        errors['dob'] = 'A date of birth cannot be in the future.';
      }
    }
  } else if (form.ageYears.trim() === '' && form.ageMonths.trim() === '' && form.ageDays.trim() === '') {
    errors['ageYears'] = 'Give an age in years, months or days.';
  }

  if (form.email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
    errors['email'] = 'Check the email address — it is where the appointment confirmation goes.';
  }

  if (form.idLast4.trim() !== '' && !/^\d{4}$/.test(form.idLast4.trim())) {
    errors['idLast4'] = 'Enter the last four digits only. The full number is never stored.';
  }

  if (PAYER_REF_REQUIRED.has(form.payerType) && form.payerRef.trim() === '') {
    errors['payerRef'] =
      'A corporate, insurance or scheme patient needs the employee number, policy number or card number. Without it the bill cannot be raised.';
  }

  // `known` is a state the *server* owns: `patient.trg_allergies_sync_statement`
  // promotes the statement when an allergy row exists, and `registerPatientSchema`
  // refuses `known` from a client. Recording the entries themselves is EN-029,
  // which is not this phase — so the save is blocked with an explanation rather
  // than sending a statement that would be rejected, or worse, silently dropping
  // allergies somebody typed at the counter.
  if (form.allergy.kind === 'known') {
    errors['allergy'] =
      'Allergy entries are recorded on the clinical record, which registration cannot write yet. Remove them here and record “could not establish” or “no known allergies”; the vitals room or the clinician records the entry itself.';
  }

  if (form.allergy.kind === 'unable-to-assess' && form.allergy.reason.trim().length < 8) {
    errors['allergy'] =
      'Say why the allergy history could not be established — an unexplained “unable to assess” tells the next clinician nothing.';
  }

  const age = ageInYears(form, now);
  if (age !== null && age < 18 && !(form.emergencyIsGuardian && form.emergencyName.trim() !== '')) {
    errors['emergencyName'] =
      'A patient under 18 needs a guardian on the record. Enter the guardian and tick “this contact is the guardian”.';
  }

  if (form.emergencyName.trim() !== '' && form.emergencyPhone.replace(/\D/g, '').length < 6) {
    errors['emergencyPhone'] = 'A contact nobody can ring is not a contact.';
  }

  return errors;
}

/** Whole years, from whichever basis the clerk used. `null` when unknowable. */
export function ageInYears(form: RegistrationFormState, now: Date = new Date()): number | null {
  if (form.ageBasis === 'age') {
    const years = Number.parseInt(form.ageYears, 10);
    if (!Number.isNaN(years)) return years;
    const months = Number.parseInt(form.ageMonths, 10);
    if (!Number.isNaN(months)) return Math.floor(months / 12);
    const days = Number.parseInt(form.ageDays, 10);
    if (!Number.isNaN(days)) return Math.floor(days / 365);
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.dob)) return null;
  const born = new Date(`${form.dob}T00:00:00Z`);
  if (Number.isNaN(born.getTime())) return null;
  let years = now.getUTCFullYear() - born.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - born.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < born.getUTCDate())) years -= 1;
  return years;
}

function trimmed(value: string): string | undefined {
  const text = value.trim();
  return text === '' ? undefined : text;
}

function positiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed < 0 ? undefined : parsed;
}

/**
 * The age half of the request: either a date of birth, or up to three age
 * components — never both, because `resolveBirth` on the server prefers the date
 * and would silently ignore an age that disagreed with it.
 */
function ageFields(
  form: RegistrationFormState,
): Pick<RegisterPatientInput, 'dob' | 'ageYears' | 'ageMonths' | 'ageDays'> {
  if (form.ageBasis === 'dob') {
    const dob = trimmed(form.dob);
    return dob === undefined ? {} : { dob };
  }
  const years = positiveInt(form.ageYears);
  const months = positiveInt(form.ageMonths);
  const days = positiveInt(form.ageDays);
  return {
    ...(years === undefined ? {} : { ageYears: years }),
    ...(months === undefined ? {} : { ageMonths: months }),
    ...(days === undefined ? {} : { ageDays: days }),
  };
}

/**
 * The wire form of the completed desk form.
 *
 * Empty strings become *absent* fields rather than empty ones: the API's schema
 * trims and length-checks what it is given, and an empty `email` would be
 * rejected as an invalid address rather than treated as "not supplied".
 */
export function toRegisterRequest(
  form: RegistrationFormState,
  extra: {
    readonly branchId?: string;
    readonly overrideDuplicate?: {
      readonly acknowledgedPatientIds: readonly string[];
      readonly reason: string;
    };
  } = {},
): RegisterPatientInput {
  const address = form.address;
  const hasAddress =
    [address.line1, address.line2, address.city, address.district, address.pincode].some(
      (part) => part.trim() !== '',
    ) || address.stateCode.trim() !== '';

  const contacts =
    form.emergencyName.trim() === ''
      ? []
      : [
          {
            kind: form.emergencyIsGuardian ? ('guardian' as const) : ('emergency' as const),
            name: form.emergencyName.trim(),
            phone: form.emergencyPhone.trim(),
            isGuardian: form.emergencyIsGuardian,
            isPrimary: true,
            ...(trimmed(form.emergencyRelation) === undefined
              ? {}
              : { relationshipCode: form.emergencyRelation.trim() }),
          },
        ];

  return {
    firstName: form.firstName.trim(),
    gender: form.gender,
    mobile: form.mobile.trim(),
    sourceChannel: 'counter',
    category: form.category,
    payerType: form.payerType,
    bloodGroup: form.bloodGroup,
    preferredLanguage: form.preferredLanguage,
    whatsappOptIn: form.whatsappOptIn,
    isVip: form.isVip,
    isDifferentlyAbled: form.isDifferentlyAbled,
    isPregnant: form.isPregnant,
    contacts,
    ...(extra.branchId === undefined ? {} : { branchId: extra.branchId }),
    ...(trimmed(form.titleCode) === undefined ? {} : { titleCode: form.titleCode.trim() }),
    ...(trimmed(form.middleName) === undefined ? {} : { middleName: form.middleName.trim() }),
    ...(trimmed(form.lastName) === undefined ? {} : { lastName: form.lastName.trim() }),
    ...ageFields(form),
    ...(trimmed(form.altPhone) === undefined ? {} : { altPhone: form.altPhone.trim() }),
    ...(trimmed(form.email) === undefined ? {} : { email: form.email.trim() }),
    ...(trimmed(form.idTypeCode) === undefined ? {} : { idTypeCode: form.idTypeCode.trim() }),
    ...(trimmed(form.idLast4) === undefined ? {} : { idLast4: form.idLast4.trim() }),
    ...(trimmed(form.abhaNumber) === undefined ? {} : { abhaNumber: form.abhaNumber.trim() }),
    ...(trimmed(form.abhaAddress) === undefined ? {} : { abhaAddress: form.abhaAddress.trim() }),
    ...(trimmed(form.payerRef) === undefined ? {} : { payerRef: form.payerRef.trim() }),
    ...(trimmed(form.referralSourceCode) === undefined
      ? {}
      : { referralSourceCode: form.referralSourceCode.trim() }),
    ...(hasAddress
      ? {
          address: {
            countryCode: 'IN',
            ...(trimmed(address.line1) === undefined ? {} : { line1: address.line1.trim() }),
            ...(trimmed(address.line2) === undefined ? {} : { line2: address.line2.trim() }),
            ...(trimmed(address.city) === undefined ? {} : { city: address.city.trim() }),
            ...(trimmed(address.district) === undefined ? {} : { district: address.district.trim() }),
            ...(trimmed(address.stateCode) === undefined ? {} : { state: address.stateCode.trim() }),
            ...(trimmed(address.pincode) === undefined ? {} : { pincode: address.pincode.trim() }),
          },
        }
      : {}),
    // `known` is unreachable from this form by construction, but the guard is
    // here rather than a cast: if somebody widens the editor's statement later,
    // this refuses to send a state the server would reject instead of compiling.
    ...(isRegistrationStatement(form.allergy) ? { allergy: toRegisterAllergyInput(form.allergy) } : {}),
    ...(extra.overrideDuplicate === undefined ? {} : { overrideDuplicate: extra.overrideDuplicate }),
  };
}
