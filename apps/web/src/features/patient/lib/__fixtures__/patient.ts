import type { PatientBannerData, PatientDetail } from '../../api/types';

/**
 * A registered patient, as `GET /patients/{id}` returns one.
 *
 * Shared by the unit tests and the screen tests so that a field added to
 * `PatientDetail` breaks in one place rather than in nine, and so that every test
 * starts from the same *safe* default — in particular `allergy_statement:
 * 'not_recorded'`, which is what a freshly registered patient really has and the
 * state most likely to be rendered wrongly.
 */
export function bannerFixture(overrides: Partial<PatientBannerData> = {}): PatientBannerData {
  return {
    uhid: '0021-45871',
    full_name: 'SHARMA, Ramesh',
    gender: 'male',
    age_display: '45 y',
    blood_group: 'o_pos',
    photo_file_id: null,
    allergy_statement: 'not_recorded',
    allergy_asserted_at: null,
    allergy_unable_reason: null,
    allergies: [],
    alerts: [],
    is_vip: false,
    is_deceased: false,
    status: 'active',
    merged_into_id: null,
    ...overrides,
  };
}

export function patientFixture(overrides: Partial<PatientDetail> = {}): PatientDetail {
  const banner = bannerFixture(
    overrides.banner === undefined
      ? {
          ...(overrides.uhid === undefined ? {} : { uhid: overrides.uhid }),
          ...(overrides.full_name === undefined ? {} : { full_name: overrides.full_name }),
        }
      : overrides.banner,
  );

  return {
    id: '018f4b2c-6d3e-7a11-9f22-0c1d2e3f4a5b',
    uhid: '0021-45871',
    full_name: 'SHARMA, Ramesh',
    gender: 'male',
    dob: '1981-04-12T00:00:00.000Z',
    dob_is_estimated: false,
    age_years: 45,
    mobile: '+919845012345',
    category: 'general',
    status: 'active',
    merged_into_id: null,
    branch_id: 'branch-1',
    last_visit_at: null,
    registered_at: '2026-08-20T05:30:00.000Z',
    created_at: '2026-08-20T05:30:00.000Z',
    mpi_group_id: null,
    title_code: 'mr',
    first_name: 'Ramesh',
    middle_name: null,
    last_name: 'Sharma',
    local_name: null,
    age_months: null,
    age_days: null,
    blood_group: 'o_pos',
    marital_status: null,
    allergy_statement: 'not_recorded',
    allergy_asserted_by: null,
    allergy_asserted_at: null,
    allergy_unable_reason: null,
    mobile_verified_at: null,
    alt_phone: null,
    email: null,
    whatsapp_opt_in: false,
    preferred_language: 'en-IN',
    nationality_code: 'IND',
    religion_code: null,
    occupation_code: null,
    id_type_code: null,
    id_last4: null,
    aadhaar_last4: null,
    aadhaar_kyc_verified_at: null,
    abha_number: null,
    abha_address: null,
    abha_linked_at: null,
    photo_file_id: null,
    address_line1: null,
    address_line2: null,
    city: null,
    district: null,
    state: null,
    country_code: 'IN',
    pincode: null,
    payer_type: 'self',
    payer_ref: null,
    referral_source_code: null,
    referred_by_text: null,
    is_vip: false,
    is_staff: false,
    is_differently_abled: false,
    is_pregnant: false,
    is_deceased: false,
    deceased_at: null,
    source_channel: 'counter',
    created_override_reason: null,
    merged_at: null,
    version: 1,
    identifiers: [],
    contacts: [],
    banner,
    ...overrides,
  };
}
