import { emptyIndianAddress, type IndianAddress } from '@vims/ui';
import type { UpdatePatientInput } from '../api/client';
import type { Gender, PatientDetail } from '../api/types';
import { humaniseFieldName } from './format';

/**
 * A demographic amendment, as a diff.
 *
 * `PATCH /patients/{id}` writes `patient.demographic_history` from **what
 * changed** (OP-001 §14 AC-14: "stores before/after with reason and actor"), so
 * sending the whole record back would fill the history with rows in which nothing
 * changed and bury the one edit that did. Everything here exists to send only the
 * fields a human actually altered.
 *
 * Two conventions matter and are enforced by the types:
 *
 *  - a field emptied on the form becomes **`null`**, not `''`. The API's schema
 *    accepts `null` to clear a nullable column and rejects an empty string as an
 *    invalid value, so the two are not interchangeable;
 *  - `firstName` and `dob` are **not** nullable on the server, so an emptied
 *    first name is simply not sent — the record keeps the name it had rather than
 *    being cleared by a stray keystroke.
 */

export interface AmendFormState {
  readonly titleCode: string;
  readonly firstName: string;
  readonly middleName: string;
  readonly lastName: string;
  readonly gender: Gender;
  readonly dob: string;
  readonly bloodGroup: string;
  readonly maritalStatus: string;
  readonly mobile: string;
  readonly altPhone: string;
  readonly email: string;
  readonly whatsappOptIn: boolean;
  readonly preferredLanguage: string;
  readonly address: IndianAddress;
  readonly category: string;
  readonly payerType: string;
  readonly payerRef: string;
  readonly isVip: boolean;
  readonly isDifferentlyAbled: boolean;
  readonly isPregnant: boolean;
}

function text(value: string | null): string {
  return value ?? '';
}

export function amendFormFrom(patient: PatientDetail): AmendFormState {
  return {
    titleCode: text(patient.title_code),
    firstName: patient.first_name,
    middleName: text(patient.middle_name),
    lastName: text(patient.last_name),
    gender: (['male', 'female', 'other', 'unknown'] as const).includes(patient.gender as Gender)
      ? (patient.gender as Gender)
      : 'unknown',
    // `dob` crosses JSON as an ISO instant; the input wants a calendar date.
    dob: patient.dob === null ? '' : patient.dob.slice(0, 10),
    bloodGroup: patient.blood_group,
    maritalStatus: text(patient.marital_status),
    mobile: patient.mobile,
    altPhone: text(patient.alt_phone),
    email: text(patient.email),
    whatsappOptIn: patient.whatsapp_opt_in,
    preferredLanguage: patient.preferred_language,
    address: {
      ...emptyIndianAddress(patient.country_code),
      line1: text(patient.address_line1),
      line2: text(patient.address_line2),
      city: text(patient.city),
      district: text(patient.district),
      stateCode: text(patient.state),
      pincode: text(patient.pincode),
    },
    category: patient.category,
    payerType: patient.payer_type,
    payerRef: text(patient.payer_ref),
    isVip: patient.is_vip,
    isDifferentlyAbled: patient.is_differently_abled,
    isPregnant: patient.is_pregnant,
  };
}

/** Everything the amendment will send, minus `version`, `reason` and `channel`. */
export type AmendChanges = Omit<UpdatePatientInput, 'version' | 'reason' | 'channel'>;

export function amendChanges(patient: PatientDetail, draft: AmendFormState): AmendChanges {
  const changes: Record<string, unknown> = {};

  const nullable = (key: string, before: string | null, after: string): void => {
    const trimmedAfter = after.trim();
    const normalised = trimmedAfter === '' ? null : trimmedAfter;
    if (normalised !== (before === null || before === '' ? null : before)) changes[key] = normalised;
  };

  const required = (key: string, before: string, after: string): void => {
    const trimmedAfter = after.trim();
    if (trimmedAfter !== '' && trimmedAfter !== before) changes[key] = trimmedAfter;
  };

  nullable('titleCode', patient.title_code, draft.titleCode);
  required('firstName', patient.first_name, draft.firstName);
  nullable('middleName', patient.middle_name, draft.middleName);
  nullable('lastName', patient.last_name, draft.lastName);
  nullable('maritalStatus', patient.marital_status, draft.maritalStatus);
  nullable('altPhone', patient.alt_phone, draft.altPhone);
  nullable('email', patient.email, draft.email);
  nullable('payerRef', patient.payer_ref, draft.payerRef);

  required('mobile', patient.mobile, draft.mobile);
  required('bloodGroup', patient.blood_group, draft.bloodGroup);
  required('preferredLanguage', patient.preferred_language, draft.preferredLanguage);
  required('category', patient.category, draft.category);
  required('payerType', patient.payer_type, draft.payerType);
  required('dob', patient.dob === null ? '' : patient.dob.slice(0, 10), draft.dob);

  if (draft.gender !== patient.gender) changes['gender'] = draft.gender;
  if (draft.whatsappOptIn !== patient.whatsapp_opt_in) changes['whatsappOptIn'] = draft.whatsappOptIn;
  if (draft.isVip !== patient.is_vip) changes['isVip'] = draft.isVip;
  if (draft.isDifferentlyAbled !== patient.is_differently_abled) {
    changes['isDifferentlyAbled'] = draft.isDifferentlyAbled;
  }
  if (draft.isPregnant !== patient.is_pregnant) changes['isPregnant'] = draft.isPregnant;

  // The address goes as a whole object or not at all: `addressSchema.partial()`
  // merges what it is given, and sending only the changed line would leave the old
  // city attached to the new street.
  const addressChanged =
    draft.address.line1.trim() !== text(patient.address_line1) ||
    draft.address.line2.trim() !== text(patient.address_line2) ||
    draft.address.city.trim() !== text(patient.city) ||
    draft.address.district.trim() !== text(patient.district) ||
    draft.address.stateCode.trim() !== text(patient.state) ||
    draft.address.pincode.trim() !== text(patient.pincode);

  if (addressChanged) {
    changes['address'] = {
      countryCode: patient.country_code,
      line1: draft.address.line1.trim(),
      line2: draft.address.line2.trim(),
      city: draft.address.city.trim(),
      district: draft.address.district.trim(),
      state: draft.address.stateCode.trim(),
      pincode: draft.address.pincode.trim(),
    };
  }

  return changes;
}

/**
 * The fields being changed, named the way the person confirming reads them.
 *
 * Shown in the confirmation before the amendment is sent, because "you are about
 * to change the mobile number and the date of birth" is a different decision from
 * "you are about to change the address", and the reason that gets typed should be
 * about the right one.
 */
export function changedFieldLabels(changes: AmendChanges): readonly string[] {
  return Object.keys(changes).map((key) => humaniseFieldName(key));
}

export function hasChanges(changes: AmendChanges): boolean {
  return Object.keys(changes).length > 0;
}

/**
 * The four fields OP-001 §3.2.2 singles out — "changes to name/DOB/gender/mobile
 * need reason and are versioned".
 *
 * Every amendment needs a reason here, because `patient.record.update` is
 * `requiresReason` in the catalogue for all of them. These four get a louder
 * confirmation: they are the fields that decide whether two records are the same
 * person, and changing one silently is how a merge becomes impossible to unpick.
 */
const IDENTITY_FIELDS = new Set(['firstName', 'middleName', 'lastName', 'dob', 'gender', 'mobile']);

export function touchesIdentity(changes: AmendChanges): boolean {
  return Object.keys(changes).some((key) => IDENTITY_FIELDS.has(key));
}
