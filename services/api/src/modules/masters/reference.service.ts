import { Inject, Injectable } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { prefixPredicate } from '../opd/patient/patient.search.service.js';
import { MastersQueryService, likeTerm } from './masters.query.js';
import type { ListAreasQuery, ListReferenceQuery, ReferenceKind } from './masters.schemas.js';

/**
 * The eight small demographic lookups the registration form is drawn from, plus
 * the PIN-code gazetteer.
 *
 * One route (`GET /masters/{kind}`) rather than eight controllers. The lists are
 * structurally the same — a code, a name, a sort order and a handful of flags —
 * and the only thing eight copies would reliably produce is seven places to
 * forget the effective-date predicate.
 *
 * The `kind` never reaches SQL as a string from the request: it is validated
 * against a Zod enum in the controller and then used as a key into the frozen
 * table below, so the `FROM` clause is always one of eight compile-time
 * constants.
 */

export interface ReferenceListItem {
  readonly id: string;
  readonly record_key: string;
  readonly code: string;
  readonly name: string;
  readonly sort_order: number;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  /** The fields specific to this kind — retention rule, inverse code, and so on. */
  readonly attributes: Record<string, unknown>;
}

export interface AreaListItem {
  readonly id: string;
  readonly record_key: string;
  readonly pincode: string;
  readonly area_name: string;
  readonly taluk: string | null;
  readonly city: string;
  readonly district: string;
  readonly state: string;
  readonly state_code: string;
  readonly country_code: string;
  readonly catchment_zone: string | null;
  readonly is_urban: boolean;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
}

interface ReferenceSpec {
  readonly resource: string;
  readonly table: string;
  /**
   * The columns beyond `code`/`name`/`sort_order`, collected into one JSON
   * object. Returning them as a nested `attributes` bag rather than eight
   * different top-level shapes is what lets a single client component render
   * every kind: the shared fields are always in the same place, and the
   * kind-specific ones are where a caller that knows the kind can find them.
   */
  readonly attributes: string;
}

const REFERENCE_SPECS: Readonly<Record<ReferenceKind, ReferenceSpec>> = {
  'id-types': {
    resource: 'mdm.id_types',
    table: 'mdm.mdm_id_types',
    // `retention` is the field that makes this master load-bearing rather than
    // decorative: it is how "an Aadhaar number is stored as a hash plus its last
    // four digits" becomes a property of the ID type that the registration
    // service reads, instead of a rule somebody has to remember.
    attributes: `jsonb_build_object(
      'category', m.category, 'countryCode', m.country_code, 'validationRegex', m.validation_regex,
      'retention', m.retention::text, 'isPhotoId', m.is_photo_id, 'countsAsIdentity', m.counts_as_identity)`,
  },
  'relationship-types': {
    resource: 'mdm.relationship_types',
    table: 'mdm.mdm_relationship_types',
    attributes: `jsonb_build_object(
      'inverseCode', m.inverse_code, 'genderHint', m.gender_hint,
      'guardianCapable', m.guardian_capable, 'nextOfKinCapable', m.next_of_kin_capable)`,
  },
  occupations: {
    resource: 'mdm.occupations',
    table: 'mdm.mdm_occupations',
    attributes: `jsonb_build_object('ncoCode', m.nco_code, 'hazardClass', m.hazard_class)`,
  },
  religions: {
    resource: 'mdm.religions',
    table: 'mdm.mdm_religions',
    attributes: `jsonb_build_object('dietaryDefaults', m.dietary_defaults)`,
  },
  titles: {
    resource: 'mdm.titles',
    table: 'mdm.mdm_titles',
    attributes: `jsonb_build_object('genderHint', m.gender_hint, 'impliesMinor', m.implies_minor)`,
  },
  languages: {
    resource: 'mdm.languages',
    table: 'mdm.mdm_languages',
    attributes: `jsonb_build_object(
      'nativeName', m.native_name, 'script', m.script, 'isRtl', m.is_rtl, 'ttsVoice', m.tts_voice,
      'usedForPatientComms', m.used_for_patient_comms, 'usedForDisplays', m.used_for_displays)`,
  },
  nationalities: {
    resource: 'mdm.nationalities',
    table: 'mdm.mdm_nationalities',
    attributes: `jsonb_build_object(
      'alpha2', m.alpha2, 'callingCode', m.calling_code, 'requiresPassport', m.requires_passport)`,
  },
  'referral-sources': {
    resource: 'mdm.referral_sources',
    table: 'mdm.mdm_referral_sources',
    attributes: `jsonb_build_object('kind', m.kind, 'requiresReferrer', m.requires_referrer)`,
  },
};

@Injectable()
export class ReferenceService {
  constructor(@Inject(MastersQueryService) private readonly query: MastersQueryService) {}

  async listReference(kind: ReferenceKind, q: ListReferenceQuery): Promise<Page<ReferenceListItem>> {
    const spec = REFERENCE_SPECS[kind];
    return this.query.list<ReferenceListItem>(
      {
        resource: spec.resource,
        from: `${spec.table} m`,
        alias: 'm',
        columns: `m.id, m.record_key, m.code, m.name, m.sort_order, m.effective_from, m.effective_to,
                  ${spec.attributes} AS attributes`,
        // Sorted by name, not by `sort_order`. The cursor is a single text key
        // (`CursorService.keysetPage`), and an integer rendered as text sorts
        // "10" before "9" — a keyset built on it would silently skip rows at
        // every page boundary. `sort_order` is returned on every row, and these
        // lists are short enough that a picker holds the whole thing and sorts
        // it for display.
        label: 'm.name',
        effectiveDated: true,
      },
      q,
      (bind) => (q.q === undefined ? [] : [`m.name ILIKE '%' || ${bind(likeTerm(q.q))} || '%'`]),
    );
  }

  /**
   * `GET /areas?pin=` — the registration form's address auto-fill.
   *
   * `AddressForm` in `packages/ui` sends the PIN as the receptionist types it,
   * so the match is a prefix and not an equality: `idx_mdm_areas_pincode_prefix`
   * is a `varchar_pattern_ops` index on `(hospital_id, pincode)` built for
   * exactly this, and it is partial on `status = 'active'` — which is why the
   * default, no-`asOf` path restricts to `active` rather than scanning
   * superseded rows it will never return.
   *
   * A PIN maps to several post-office areas, and the district and state are the
   * same for all of them; the form fills district/state from the first row and
   * offers the areas as a choice.
   */
  async listAreas(q: ListAreasQuery): Promise<Page<AreaListItem>> {
    return this.query.list<AreaListItem>(
      {
        resource: 'mdm.areas',
        from: 'mdm.mdm_areas m',
        alias: 'm',
        columns: `m.id, m.record_key, m.pincode, m.area_name, m.taluk, m.city, m.district,
                  m.state, m.state_code, m.country_code, m.catchment_zone, m.is_urban,
                  m.effective_from, m.effective_to`,
        label: 'm.area_name',
        effectiveDated: true,
      },
      q,
      (bind) => {
        const where: string[] = [];
        // A bare `LIKE` cannot reach `idx_mdm_areas_pincode_prefix` under RLS:
        // `~~` is not LEAKPROOF, so the planner will not promote it to an index
        // condition ahead of the tenant policy, whatever the index's column
        // order (D-37). Measured at India Post's ~155,000 rows, the `LIKE` form
        // filters 51,664 rows per worker at 20.4 ms; the leakproof range form
        // reaches the index at 0.08 ms. The term is digits-only by schema, so it
        // carries no LIKE metacharacter.
        if (q.pin !== undefined) where.push(prefixPredicate('m.pincode', q.pin, bind));
        if (q.district !== undefined) where.push(`m.district = ${bind(q.district)}`);
        if (q.q !== undefined) where.push(`m.area_name ILIKE '%' || ${bind(likeTerm(q.q))} || '%'`);
        return where;
      },
    );
  }
}
