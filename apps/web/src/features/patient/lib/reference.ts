import type { AddressCodedOption, AddressFormLabels, AllergyEditorLabels, CodedOption } from '@vims/ui';
import type { Gender } from '../api/types';

/**
 * The fixed vocabularies the registration form offers, and the labels the shared
 * clinical components need.
 *
 * Two different kinds of thing live here and the distinction matters:
 *
 *  - **API enums** (gender, blood group, category, payer type) are not
 *    configuration. They are the accepted values of `registerPatientSchema`, and
 *    a hospital cannot add to them without a migration. Listing them is the only
 *    way a `<Select>` can offer them at all.
 *  - **Reference data** (the Indian states) is public, statutory and identical for
 *    every deployment. EN-027's master-data service will own the codes that *are*
 *    hospital-specific — title, religion, occupation, relationship, referral
 *    source, ID type — and those are deliberately **free-text inputs** on the
 *    form rather than invented dropdowns. `CLAUDE.md` §0: do not invent data. A
 *    seeded list of religions nobody approved would be worse than a text box.
 */

export const GENDERS: readonly { readonly value: Gender; readonly label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'other', label: 'Other' },
  { value: 'unknown', label: 'Not stated' },
];

export const BLOOD_GROUPS: readonly CodedOption[] = [
  { code: 'unknown', label: 'Not known' },
  { code: 'o_pos', label: 'O+' },
  { code: 'o_neg', label: 'O−' },
  { code: 'a_pos', label: 'A+' },
  { code: 'a_neg', label: 'A−' },
  { code: 'b_pos', label: 'B+' },
  { code: 'b_neg', label: 'B−' },
  { code: 'ab_pos', label: 'AB+' },
  { code: 'ab_neg', label: 'AB−' },
  { code: 'bombay', label: 'Bombay (hh)' },
];

export const CATEGORIES: readonly CodedOption[] = [
  { code: 'general', label: 'General' },
  { code: 'senior_citizen', label: 'Senior citizen' },
  { code: 'infant', label: 'Infant' },
  { code: 'staff', label: 'Staff' },
  { code: 'staff_dependant', label: 'Staff dependant' },
  { code: 'corporate', label: 'Corporate' },
  { code: 'insurance', label: 'Insurance' },
  { code: 'scheme', label: 'Government scheme' },
  { code: 'charity', label: 'Charity' },
  { code: 'vip', label: 'VIP' },
  { code: 'international', label: 'International' },
];

export const PAYER_TYPES: readonly CodedOption[] = [
  { code: 'self', label: 'Self-paying' },
  { code: 'insurance', label: 'Insurance' },
  { code: 'corporate', label: 'Corporate' },
  { code: 'scheme', label: 'Government scheme' },
  { code: 'staff', label: 'Staff' },
  { code: 'charity', label: 'Charity' },
];

/**
 * The locales `CLAUDE.md` §4 names: `en-IN` always, then the eleven others. A
 * hospital enables a subset through EN-027; until that read exists, offering all
 * of them is better than offering one, because the printed DPDP notice is
 * generated from this field.
 */
export const LANGUAGES: readonly CodedOption[] = [
  { code: 'en-IN', label: 'English' },
  { code: 'hi', label: 'हिन्दी — Hindi' },
  { code: 'ta', label: 'தமிழ் — Tamil' },
  { code: 'te', label: 'తెలుగు — Telugu' },
  { code: 'ml', label: 'മലയാളം — Malayalam' },
  { code: 'kn', label: 'ಕನ್ನಡ — Kannada' },
  { code: 'mr', label: 'मराठी — Marathi' },
  { code: 'bn', label: 'বাংলা — Bengali' },
  { code: 'gu', label: 'ગુજરાતી — Gujarati' },
  { code: 'or', label: 'ଓଡ଼ିଆ — Odia' },
  { code: 'pa', label: 'ਪੰਜਾਬੀ — Punjabi' },
  { code: 'ar', label: 'العربية — Arabic' },
];

/**
 * ISO 3166-2:IN. Statutory reference data, the same in every deployment.
 *
 * **Aadhaar is not among the identity documents this desk accepts**, and there is
 * no state-issued-ID dropdown here for the same reason: OP-001 §5 stores only a
 * type code and the last four digits, the type codes come from EN-027's ID-type
 * master, and inventing that list would create an Aadhaar option by accident.
 */
export const INDIAN_STATES: readonly AddressCodedOption[] = [
  { code: 'AN', label: 'Andaman & Nicobar Islands' },
  { code: 'AP', label: 'Andhra Pradesh' },
  { code: 'AR', label: 'Arunachal Pradesh' },
  { code: 'AS', label: 'Assam' },
  { code: 'BR', label: 'Bihar' },
  { code: 'CH', label: 'Chandigarh' },
  { code: 'CT', label: 'Chhattisgarh' },
  { code: 'DH', label: 'Dadra & Nagar Haveli and Daman & Diu' },
  { code: 'DL', label: 'Delhi' },
  { code: 'GA', label: 'Goa' },
  { code: 'GJ', label: 'Gujarat' },
  { code: 'HR', label: 'Haryana' },
  { code: 'HP', label: 'Himachal Pradesh' },
  { code: 'JK', label: 'Jammu & Kashmir' },
  { code: 'JH', label: 'Jharkhand' },
  { code: 'KA', label: 'Karnataka' },
  { code: 'KL', label: 'Kerala' },
  { code: 'LA', label: 'Ladakh' },
  { code: 'LD', label: 'Lakshadweep' },
  { code: 'MP', label: 'Madhya Pradesh' },
  { code: 'MH', label: 'Maharashtra' },
  { code: 'MN', label: 'Manipur' },
  { code: 'ML', label: 'Meghalaya' },
  { code: 'MZ', label: 'Mizoram' },
  { code: 'NL', label: 'Nagaland' },
  { code: 'OR', label: 'Odisha' },
  { code: 'PY', label: 'Puducherry' },
  { code: 'PB', label: 'Punjab' },
  { code: 'RJ', label: 'Rajasthan' },
  { code: 'SK', label: 'Sikkim' },
  { code: 'TN', label: 'Tamil Nadu' },
  { code: 'TG', label: 'Telangana' },
  { code: 'TR', label: 'Tripura' },
  { code: 'UP', label: 'Uttar Pradesh' },
  { code: 'UT', label: 'Uttarakhand' },
  { code: 'WB', label: 'West Bengal' },
];

/**
 * The reasons an allergy history cannot be established.
 *
 * Coded rather than free text because `docs/06` §6.9 level 4 asks for "coded list
 * + free text", and because these four are what actually happens at a counter.
 */
export const UNABLE_TO_ASSESS_REASONS: readonly CodedOption[] = [
  { code: 'unconscious', label: 'Patient unable to answer (unconscious or confused)' },
  { code: 'no-informant', label: 'No attendant or informant present' },
  { code: 'language', label: 'No shared language and no interpreter available' },
  { code: 'paediatric', label: 'Child too young to answer and guardian does not know' },
];

export const ADDRESS_LABELS: AddressFormLabels = {
  region: 'Address',
  line1: 'House / flat and street',
  line2: 'Area or locality',
  landmark: 'Landmark',
  pincode: 'PIN code',
  pincodeHint: 'Six digits. Fills the district and state where the PIN directory is available.',
  pincodeInvalid: 'An Indian PIN code is six digits and does not start with zero.',
  area: 'Post office area',
  city: 'City or town',
  district: 'District',
  state: 'State',
  statePlaceholder: 'Choose a state',
  country: 'Country',
  lookingUp: 'Looking up the PIN code…',
  lookupNotFound: 'That PIN code is not in the directory. Type the district and state.',
  lookupUnavailable: 'The PIN directory is not answering. Type the district and state — nothing is lost.',
  lookupManualHint: 'You can always type the address by hand.',
  chooseArea: 'Several post offices share this PIN. Choose one.',
  retryLookup: 'Look up again',
  optional: '(optional)',
};

export const ALLERGY_LABELS: AllergyEditorLabels = {
  region: 'Allergies',
  statusHeading: 'Allergy status',
  notRecorded: 'Allergies not recorded — nobody has asked yet',
  notRecordedAction: 'Ask the patient before they see a clinician.',
  unableToAssess: (reason) => `Allergies could not be established — ${reason}`,
  noneKnown: (by, on) => `No known allergies (stated to ${by} on ${on})`,
  declareNoneKnown: 'Patient states no known allergies',
  declareUnableToAssess: 'Could not establish',
  unableToAssessReasonLabel: 'Why the allergy history could not be established',
  unableToAssessReasonPlaceholder: 'Choose a reason',
  addAllergy: 'Add an allergy',
  allergenLabel: 'Allergen',
  allergenPlaceholder: 'e.g. Penicillin',
  categoryLabel: 'Category',
  category: {
    drug: 'Drug',
    'drug-class': 'Drug class',
    food: 'Food',
    environment: 'Environment',
    'contrast-media': 'Contrast media',
    latex: 'Latex',
    other: 'Other',
  },
  reactionLabel: 'Reaction',
  reactionPlaceholder: 'e.g. anaphylaxis, rash',
  reactionNotDocumented: 'Reaction not documented',
  severityLabel: 'Severity',
  severity: { mild: 'Mild', moderate: 'Moderate', severe: 'Severe', unknown: 'Not established' },
  criticalityLabel: 'Criticality',
  criticality: { low: 'Low', high: 'High', 'unable-to-assess': 'Unable to assess' },
  verificationUnverified: 'Reported, not yet confirmed by a clinician',
  verificationConfirmed: (by, on) => `Confirmed by ${by} on ${on}`,
  verificationRefuted: (by, on) => `Refuted by ${by} on ${on}`,
  confirm: 'Confirm',
  refute: 'Refute',
  remove: 'Remove',
  save: 'Save',
  cancel: 'Cancel',
  listLabel: 'Recorded allergies',
  recordedByPrefix: 'Recorded by',
};
