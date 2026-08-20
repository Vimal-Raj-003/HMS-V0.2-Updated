# TR-002 — Orthopaedic Fracture Registry (AO/OTA classification, Gustilo-Anderson, bone map, X-ray timeline, treatment plan)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Trauma & Orthopaedics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Module ID       | TR-002                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Phase           | 6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Priority        | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Complexity      | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Depends on      | OP-002 (encounter/diagnosis/ICD-10 — registry entries hang off encounters), OP-009 (Ortho OPD console — primary OP writer/reader of the registry, bone-map UI host, follow-up protocols, healing assessments), TR-001 (secondary survey creates fracture entries), OP-006 (ER visit context), OP-008 & EN-008 (imaging orders, DICOM study UIDs, OHIF viewer for X-ray timeline & side-by-side compare), TR-003 (implants used for fixation), TR-004/IP-006 (surgical fixation events), TR-005 (cast/splint events on timeline), TR-010/OP-015 (rehab pathway), OP-017 (open-fracture wound care), IP-012 (SSI/osteomyelitis surveillance), TR-008 (MLC fractures), TR-011 (registry export), EN-027 (SNOMED body structures, ICD-10 S-codes), EN-039 (forms), NC-003 (MRD coding), EN-013 (site-marking labels) |
| Feature flag    | `module.fracture_registry.enabled` (sub: `fracture.ao_ota_full_2018`, `fracture.paediatric_classification`, `fracture.nonunion_watch`, `fracture.registry_export`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Primary roles   | Orthopaedic surgeon (Doctor 6/Surgeon 9), Resident (14), Emergency physician (8, initial entry), Radiologist (12, imaging findings)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Secondary roles | Plaster technician/OPD nurse (16, cast events), Physiotherapist (40, weight-bearing status), MRD coder (43), Quality (54, union/complication KPIs), Nurse — Ward (17), Billing (27, procedure mapping), Patient (portal view of own fracture card), Auditor (58)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Regulatory      | AO/OTA Fracture and Dislocation Classification Compendium 2018 (bone-segment-type-group-subgroup, universal modifiers), Gustilo-Anderson (open fractures I/II/IIIA/IIIB/IIIC), Tscherne (closed soft-tissue), Salter-Harris (physeal), Garden/Pauwels (NOF), Schatzker (tibial plateau), Neer, Weber/Lauge-Hansen, Young-Burgess/Tile (pelvis), Denis, Frankel/ASIA (spine), ICD-10 S02–S92/T02/T08/T10/T12 & M80/M84 (pathological/stress), SNOMED CT body structures & procedures, NABH COP (safe surgery: laterality/site marking, wrong-site prevention), AERB (repeat imaging justification), BOAST/NICE NG37-38 open fracture & complex fracture standards (adopted as guidance), Consumer Protection & MLC record retention (≥ 10 y; permanent for MLC), DPDP Rules 2025                                  |

## 1. Purpose

TR-002 is the hospital-wide, longitudinal **fracture registry**: every fracture (and dislocation) diagnosed in ER, OPD, IP or OT is recorded once as a structured entity — bone/segment/side on a clickable skeleton map, AO/OTA 2018 classification with severity grades (Gustilo-Anderson for open injuries), mechanism and MLC linkage — and then followed through its **X-ray timeline** (injury → post-reduction → post-op → serial healing films from EN-008), its **treatment plan** (conservative/closed reduction/ORIF/IM nail/external fixation/arthroplasty, weight-bearing regime, implants from TR-003, cast events from TR-005), complications (non-union, malunion, infection, implant failure) and outcome. OP-009 is the surgeon-facing console; TR-002 owns the data, classification engine, timeline aggregation and registry-grade reporting for a Level II/III trauma centre.

## 2. Users & Jobs-to-be-done

- **Orthopaedic surgeon** (desktop 3-pane in OPD; tablet on ward/ER): classify a fracture in ≤ 30 s from the bone map (bone → segment → type → group/subgroup pickers with diagrams), attach the injury film, set the treatment plan and weight-bearing status, review healing on serial X-rays side by side, close the episode at union.
- **ER physician / trauma team** (tablet): create a provisional fracture entry from TR-001 secondary survey (bone/side/open-closed/Gustilo) in one tap; ortho refines later.
- **Radiologist** (desktop): structured X-ray/CT report (OP-008) suggests fracture entities; confirms displacement/angulation measurements that flow to the registry.
- **Resident** (tablet): document reductions, post-reduction film check, neurovascular status; co-sign by consultant.
- **Plaster tech / ward nurse**: see planned immobilisation & weight-bearing on the fracture card; log cast events (TR-005).
- **Physiotherapist**: read weight-bearing/ROM restrictions and healing status before sessions (OP-015/TR-010).
- **MRD coder / Quality**: complete ICD-10 & AO codes, run non-union/infection/re-operation KPIs, export registry (TR-011/national ortho registries).
- **Patient** (portal PE-001): "my fracture card" — bone, treatment, next X-ray due, weight-bearing instructions, cast care.

## 3. Core Workflows

### 3.1 Create fracture entry (any care setting)

1. **Doctor** clicks a bone on the **skeleton map** (OP-009 component; also embedded in ER TR-001 secondary survey and IP-006 op note) or picks from ICD search → **System** opens _New Fracture_ sheet pre-filled with bone (SNOMED body structure), side (mandatory for paired bones), patient context (encounter, ER visit, admission), mechanism (from TR-001 if trauma episode exists) → doctor sets: **open/closed**, injury date/time (estimated), **AO/OTA**: bone (1 humerus, 2 radius/ulna, 3 femur, 4 tibia/fibula, 5 spine, 6 pelvis, 7 hand, 8 foot, 9 other incl. scapula/clavicle/patella) → segment (1 proximal, 2 diaphyseal, 3 distal, 4 malleolar for tibia) → type (A extra-articular/simple, B partial articular/wedge, C complete articular/multifragmentary) → group 1–3 → subgroup .1–.3 → universal modifiers/qualifiers (e.g. displacement, fragment) → code string e.g. `32-B2.1` or `2R3C3.2` (2018 radius/ulna notation) → **Gustilo-Anderson** grade if open (I, II, IIIA, IIIB, IIIC) + Tscherne if closed → **child** (< 16 y or open physis): Salter-Harris I–V + AO Paediatric (PCCF) code option → region-specific classification picker (Garden, Schatzker, Neer, Weber, Young-Burgess/Tile, Denis, Sanders, Lisfranc…) → associated injuries (neurovascular deficit, compartment syndrome risk, dislocation, skin threat) → **ICD-10** auto-suggested (S72.0 etc., with 7th-character style closed/open qualifier stored separately) → save → Event `ortho.fracture.created`.
2. Provisional entries (ER/radiologist) carry `classification_status=provisional`; ortho confirms/edits → new version (`classification_status=confirmed`), history retained.
3. Duplicate guard: same patient + bone + segment + side with open episode → prompt "existing fracture — add event instead?"
4. Exception: **pathological/stress/periprosthetic** fractures → aetiology enum (osteoporotic, tumour, periprosthetic with Vancouver/UCS class, stress) → osteoporosis pathway prompt (DEXA/FLS referral) for fragility fractures ≥ 50 y.

### 3.2 X-ray timeline & imaging comparison

1. **System** subscribes to `rad.study.completed` (OP-008/EN-008): studies whose body part/laterality match an open fracture (or ordered from the fracture card) auto-attach as **timeline events** (type: injury film, post-reduction, post-op, healing check at week 2/6/12/24, hardware review, CT, MRI) — doctor can re-label or attach manually.
2. Timeline card shows thumbnails (OHIF presigned), date, weeks since injury/surgery, and structured findings: alignment (angulation °, translation %, shortening mm, rotation), callus grade, union score (**RUST** for tibia/**RUSH** for hip, mRUST), implant status (intact/loosening/broken/backed-out/migration), joint congruity → stored in `fracture_imaging_findings` (co-owned with OP-009 healing assessments).
3. **Compare** button opens OHIF side-by-side (prior vs current) with synchronised zoom; measurements saved as annotations (EN-008) and copied to findings.
4. **Follow-up X-ray due** dates come from the treatment plan protocol (OP-009 protocol engine); overdue → recall list (PE-002).
5. AERB: repeat imaging of same site within 7 days requires justification text passed to OP-008 order.

### 3.3 Treatment plan & events

1. **Surgeon** sets **plan** on the fracture: intent (conservative / closed reduction & cast / percutaneous pinning / ORIF plate-screw / IM nail / external fixation (temporary damage-control or definitive) / arthroplasty (hemi/THR/TKR) / amputation / traction), urgency (emergency < 6 h, urgent < 24 h, early < 72 h, elective), planned implant family (TR-003 catalogue), planned date/OT request (TR-004/IP-006 booking pre-filled with side/site), **weight-bearing** (NWB/TTWB/PWB %/WBAT/FWB) with review date, ROM restrictions, immobilisation request (TR-005), DVT prophylaxis flag, tetanus/antibiotic status for open fracture (with time from injury), consent template (EN-028), estimate (RC-008) → Event `ortho.fracture.plan_set`.
2. **Events** append to the fracture: reduction performed (closed/open, anaesthesia, post-reduction NV status, film), surgery done (from `ot.case.completed`: procedure, implants used from TR-003 usage rows, fixation construct, bone graft, wound closure/VAC), cast/splint applied/changed/removed (TR-005), external fixator pin-site care, wound events (OP-017), physio milestone (TR-010), complication (§3.4), union declared, hardware removal, episode closed.
3. **Open fracture bundle** (BOAST-aligned checklist): IV antibiotics ≤ 1 h, tetanus, photograph & saline-soaked dressing (no repeated exposure), splint, debridement timing (≤ 24 h or ≤ 12 h high-energy), plastics referral for IIIB, definitive cover ≤ 72 h — each step timestamped; breaches to TR-011.
4. Damage-control orthopaedics: temporary ex-fix event flagged `damage_control=true`; conversion to definitive fixation tracked (target ≤ 2 weeks; pin-site infection risk).

### 3.4 Complications, non-union watch & outcome

1. Complication types: infection (superficial/deep SSI → IP-012 case), osteomyelitis, non-union (no radiographic progression at 6 months / 3 consecutive months), delayed union, malunion (angulation thresholds by bone), implant failure/breakage/loosening, loss of reduction, compartment syndrome, neurovascular injury, DVT/PE, fat embolism, AVN, heterotopic ossification, CRPS, re-fracture, amputation, death; each with onset date, severity (Clavien-Dindo optional), management, re-operation link.
2. **Non-union watch** (`fracture.nonunion_watch`): rule flags fractures without a healing film after 12 weeks or RUST < 9 at 6 months → worklist for surgeon; automatically opens complication when confirmed.
3. **Outcome/closure**: union (date, radiographic + clinical), time-to-union (weeks), final alignment, PROM at 6/12 months (OP-009 PROMs), return-to-work/sport (TR-010), status closed; **re-open** on re-fracture/hardware issue with reason.

### 3.5 Dislocations, pelvis/acetabulum, spine & multiple fractures

1. **Dislocation** (with or without fracture): joint (SNOMED), direction (anterior/posterior/inferior/…), reduction attempts (time, sedation, operator, success, post-reduction NV status, film) recorded as events; recurrent dislocation counter; hip dislocation → reduction ≤ 6 h target timer (AVN risk).
2. **Pelvic ring / acetabulum**: Young-Burgess/Tile & Letournel pickers, haemodynamic instability flag → TR-001 pelvic binder time, angio-embolisation event, external fixation; ISS region = extremities/pelvic girdle.
3. **Spine**: level (C1–S5), AO Spine (A0–C, N0–N4 neuro modifiers, M1–M2), TLICS/SLIC scores, ASIA grade from TR-001, collar/brace immobilisation (TR-005), stability decision, surgery event; neuro deterioration alerts to nursing (IP-003 hourly neuro-obs).
4. **Polyfracture (≥ 2 long bones)**: fractures grouped under the trauma episode; **surgical sequencing** proposal (life > limb, damage-control vs early total care based on physiology from TR-006 lactate/temperature/coagulopathy) sent to TR-007 priority queue; each fracture keeps its own timeline.

### 3.6 Paediatric fractures

- Age < 16 y or open physis: growth-plate (Salter-Harris) mandatory question; non-accidental injury (NAI) screening prompt (metaphyseal corner, posterior rib, multiple fractures of different ages, inconsistent history) → child-protection SOP + POCSO/JJ Act reporting via TR-008; remodelling potential note; growth-arrest follow-up reminders at 6/12 months (OP-033/OP-009 protocol); weight-based analgesia in plan; parental consent capture (EN-028).

### 3.7 Exceptions & edge cases

1. **Unknown/temporary patient** (ER tag): fracture created against tag; on OP-001 merge, all fracture rows re-point to UHID (event `patient.merged` consumed) — no data loss; if two UHIDs merged with overlapping open fractures of same bone/side, duplicates flagged for surgeon reconciliation (not auto-merged).
2. **Wrong classification/side entered**: correction creates a version; if OT booking/cast job already exists, cascade check lists dependants and requires each to be reconciled (laterality rule) before confirm.
3. **External images** (CD/film from referring hospital): imported to EN-008 (or photo of film to OP-022) → attach as `injury` label with source `external`, date as per film.
4. **Fracture diagnosed post-mortem/on tertiary survey**: created with `source=tertiary_survey|autopsy`, counted in missed-injury KPI (TR-006/TR-011).
5. **Conservative → operative switch** (loss of reduction): plan version 2 with reason; TR-005 cast job auto-flagged for removal; TR-004 request pre-filled.
6. **Transfer-out before treatment**: plan intent `referral_only`, close reason `transferred`, registry record retains injury data; IP-018 packet includes fracture summary.
7. **Patient refuses surgery**: intent conservative with `patient_refusal` flag, counselling note & consent refusal (EN-028); outcome tracked separately.
8. **Offline entry conflict** (ER tablet + OPD desktop editing same fracture): version vector; later save shown a merge banner; classification fields require explicit pick when both changed.

### 3.8 Registry export & governance

- Coder completes ICD-10, AO codes, procedure codes; registry record validated (mandatory fields per TR-011 dataset); export to national/state registries (CSV/FHIR Bundle) with pseudonymisation; MLC fractures visible only with `mlc_access`.
- Data quality dashboard: % confirmed within 24 h, % with AO subgroup, % with mechanism, % with outcome at closure; monthly sign-off by ortho HOD.

## 4. Data Model (schema `trauma`)

- **fractures**: id, hospital_id, branch_id, patient_id, encounter_id, er_visit_id?, admission_id?, trauma_episode_id? (TR-001), trauma_injury_id?, ortho_episode_id? (OP-009), bone_code (SNOMED), bone_display, ao_bone smallint, ao_segment smallint, ao_type char(1)?, ao_group smallint?, ao_subgroup smallint?, ao_qualifiers text[], ao_code text (rendered, e.g. `32-B2.1`), ao_version enum(2007/2018), side enum(left/right/bilateral/midline/na), is_open bool, gustilo enum(I/II/IIIA/IIIB/IIIC)?, tscherne enum(C0/C1/C2/C3)?, paediatric bool, salter_harris enum(I/II/III/IV/V)?, pccf_code?, regional_classification jsonb ({system, value}), aetiology enum(traumatic/pathological/osteoporotic/stress/periprosthetic/iatrogenic), periprosthetic_class?, dislocation bool, associated jsonb (nv_deficit, compartment_risk, skin_threat, vascular_injury), icd10 text, icd10_open_closed_qualifier, mechanism jsonb (copied from TR-001 or entered), injury_at, injury_at_estimated bool, diagnosed_at, diagnosed_by, classification_status enum(provisional/confirmed), confirmed_by, confirmed_at, is_mlc bool, mlc_id?, status enum(open/united/closed_other/reopened), union_at, time_to_union_weeks numeric(4,1), closed_reason enum(united/amputated/died/transferred/lost_to_follow_up/other), closed_at, version, notes. Unique partial (hospital_id, patient_id, bone_code, side, ao_segment) where status='open'.
- **fracture_versions**: fracture_id, version, snapshot jsonb, changed_by, changed_at, reason.
- **fracture_plans**: id, fracture_id, version, intent enum(conservative/closed_reduction_cast/percutaneous_pinning/orif/im_nail/external_fixation/arthroplasty/amputation/traction/observation), damage_control bool, urgency enum(emergency/urgent/early/elective), planned_implant_family_id? (TR-003), planned_procedure_code, ot_request_id? (TR-004/IP-006), planned_date, weight_bearing enum(nwb/ttwb/pwb/wbat/fwb), pwb_pct?, wb_review_date, rom_restrictions text, immobilisation_request_id? (TR-005), dvt_prophylaxis bool, antibiotic_given_at?, tetanus_given_at?, consent_doc_id?, estimate_id?, set_by, set_at, is_current.
- **fracture_events**: id, fracture_id, type enum(diagnosed/reduction/surgery/cast_applied/cast_changed/cast_removed/exfix_applied/exfix_removed/pin_site_care/wound_event/imaging/physio_milestone/complication/union/hardware_removal/reopened/closed/note), at, by, ref_type (ot_case/cast_event/study/complication/physio_session/wound), ref_id, details jsonb, charge_intent_id?.
- **fracture_xray_timeline**: id, fracture_id, study_uid (EN-008), study_id (OP-008), label enum(injury/post_reduction/post_op/healing_2w/healing_6w/healing_12w/healing_24w/hardware_review/ct/mri/other), taken_at, weeks_since_injury numeric(4,1), weeks_since_surgery?, auto_attached bool, attached_by, thumbnail_file_id, is_key_image.
- **fracture_imaging_findings**: id, fracture_id, timeline_id, assessed_by, assessed_at, angulation_deg numeric(4,1), translation_pct, shortening_mm, rotation_deg, callus_grade, rust_score smallint, rush_score smallint, mrust smallint, alignment_maintained bool, implant_status enum(na/intact/loosening/broken/backed_out/migrated), joint_congruity enum(na/congruent/step_off), union_status enum(not_united/progressing/united/nonunion/delayed), notes.
- **fracture_complications**: id, fracture_id, type enum(...as §3.4), onset_at, detected_by, severity, clavien_dindo?, management text, reoperation_ot_case_id?, ssi_case_id? (IP-012), resolved_at, notes.
- **open_fracture_bundle**: fracture_id, antibiotic_at, tetanus_at, photo_at, dressing_at, splint_at, debridement_at, plastics_referral_at, definitive_cover_at, breaches text[].
- **fracture_registry_records** (export-ready flat): fracture_id, dataset_version, payload jsonb, validated bool, exported_at, export_batch_id.
- Config: **ao_ota_catalogue** (bone/segment/type/group/subgroup with descriptions & diagram file ids, version), **regional_classifications** (system, values, applicable bones), **bone_map_regions** (svg id → SNOMED, side).
- Indexes: fractures (hospital_id, patient_id, status), (hospital_id, diagnosed_at desc), (ao_bone, ao_segment, ao_type), (is_open, gustilo), (is_mlc); fracture_xray_timeline (fracture_id, taken_at); fracture_events (fracture_id, at). RLS all; append-only versions; retention ≥ 10 y (permanent if MLC; implant-linked ≥ 15 y).

## 5. Business Rules & Validations

- Side mandatory for paired bones; bilateral creates two entries; laterality mismatch between fracture, imaging order, OT booking and cast job → hard-stop reconcile (wrong-site prevention).
- AO/OTA code validated against catalogue for the selected version; type A/B/C meaning differs by segment (diaphyseal: simple/wedge/multifragmentary; end segment: extra-/partial/complete articular) — UI shows the right labels; malleolar segment 44 only for tibia; 2018 radius/ulna and hand/foot notation supported when `fracture.ao_ota_full_2018`.
- Open fracture requires Gustilo grade at confirmation; Gustilo IIIB/IIIC prompt plastics/vascular referral (OP-021) and open-fracture bundle checklist; antibiotic time > 60 min from arrival → KPI breach.
- Every fracture ICD-10 diagnosis in OP-002/IP requires a registry entry (OP-009 rule; block vs warn configurable, default block in trauma-ortho centres); ER provisional entries acceptable to satisfy the rule.
- Provisional → confirmed only by orthopaedic surgeon/consultant; residents' confirmations need co-sign ≤ 24 h.
- Plan mandatory before OT booking from ortho pathway; weight-bearing mandatory when cast/surgery/physio referral exists; changes to weight-bearing notify physio (OP-015) and ward nursing (IP-003).
- Imaging auto-attach only when body part + laterality match and study date ≥ injury date − 1 day; ambiguous matches go to "unassigned studies" tray for the surgeon.
- Non-union: cannot be declared before 6 months unless surgeon overrides with reason (documented "established non-union" criteria); delayed union 3–6 months.
- Union declaration requires ≥ 1 healing film with union_status united (or clinical justification) → status united; closure with `lost_to_follow_up` only after PE-002 recall attempts ≥ 2 logged.
- Re-open allowed for re-fracture/hardware issue; creates `reopened` event and keeps original id.
- MLC fractures: visible clinical data restricted by ABAC `mlc_access`; export pseudonymised.
- Fragility fracture (≥ 50 y, low-energy, hip/wrist/spine/humerus) → osteoporosis pathway prompt (DEXA order set, FLS referral) — recorded response.
- Registry record validity: bone, side, AO code (≥ type level), open/closed, mechanism, injury date, treatment intent, definitive treatment date, outcome at closure — missing → not exportable.

## 6. API Surface (`/api/v1/ortho/fractures`)

| Method  | Path                                                                               | Purpose                                             | Permission               | Idem | Pag    |
| ------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------ | ---- | ------ |
| POST    | /                                                                                  | create fracture (provisional or confirmed)          | ortho.fracture.create    | Y    | –      |
| GET     | /{id}                                                                              | fracture with plan, timeline, events, complications | ortho.fracture.read      | –    | –      |
| GET     | /?patient=&status=&bone=&from=                                                     | list/search                                         | ortho.fracture.list      | –    | cursor |
| PATCH   | /{id}                                                                              | edit classification (new version, reason)           | ortho.fracture.update    | Y    | –      |
| POST    | /{id}/confirm                                                                      | provisional → confirmed                             | ortho.fracture.confirm   | Y    | –      |
| POST    | /{id}/plan                                                                         | set/replace current plan                            | ortho.plan.write         | Y    | –      |
| POST    | /{id}/events                                                                       | append event                                        | ortho.fracture.event     | Y    | –      |
| POST    | /{id}/timeline                                                                     | attach study (manual) / relabel                     | ortho.timeline.write     | Y    | –      |
| GET     | /{id}/timeline                                                                     | ordered timeline with thumbnails                    | ortho.fracture.read      | –    | –      |
| POST    | /{id}/findings                                                                     | imaging findings (RUST/RUSH, alignment)             | ortho.timeline.write     | Y    | –      |
| POST    | /{id}/complications, PATCH /{id}/complications/{cid}                               | complication mgmt                                   | ortho.complication.write | Y    | –      |
| POST    | /{id}/open-bundle                                                                  | update open-fracture bundle steps                   | ortho.fracture.event     | Y    | –      |
| POST    | /{id}/union, /{id}/close, /{id}/reopen                                             | outcome                                             | ortho.fracture.close     | Y    | –      |
| GET     | /unassigned-studies?patient=                                                       | studies awaiting linkage                            | ortho.timeline.write     | –    | cursor |
| GET     | /worklists/nonunion-watch, /worklists/open-bundle-breaches, /worklists/provisional | worklists                                           | ortho.fracture.list      | –    | cursor |
| GET     | /catalogue/ao-ota?bone=&segment=&version=                                          | classification picker data                          | ortho.fracture.read      | –    | –      |
| GET     | /patients/{patientId}/bone-map                                                     | marks for skeleton map (with OP-009)                | ortho.fracture.read      | –    | –      |
| POST    | /registry/export                                                                   | build export batch (TR-011 dataset)                 | ortho.registry.export    | Y    | –      |
| GET/PUT | /config/catalogue, /config/regional-classifications, /config/bone-map              | config                                              | ortho.configure          | Y    | –      |

## 7. Domain Events (outbox)

- `ortho.fracture.created|updated|confirmed` {fracture_id, patient_id, bone, side, ao_code, is_open, gustilo, icd10} → OP-002 diagnosis sync, OP-009 bone map, TR-007 board, TR-011, MRD (NC-003), patient timeline.
- `ortho.fracture.plan_set` {intent, urgency, weight_bearing, planned_date} → TR-004/IP-006 (OT request pre-fill), TR-005 (immobilisation job), OP-015/TR-010 (restrictions), IP-003 (nursing care plan), RC-008.
- `ortho.fracture.event_added` {type, ref} → timeline, PE-001 fracture card.
- `ortho.fracture.timeline_attached` {study_uid, label} → OP-009 healing worklist.
- `ortho.fracture.finding_recorded` {rust, union_status} → nonunion-watch rules.
- `ortho.fracture.complication_recorded` {type} → IP-012 (infection), NC-015 (incident if implant failure/wrong site), TR-011 M&M.
- `ortho.fracture.open_bundle_breached` {step, target, actual} → TR-011, NC-015.
- `ortho.fracture.united|closed|reopened` → PE-002 recall stop/start, TR-010, TR-011.
- Consumes: `trauma.injury.recorded` (TR-001), `rad.study.completed|reported` (OP-008), `ot.case.completed` (TR-004/IP-006 with implants), `cast.applied|changed|removed` (TR-005), `implant.used` (TR-003), `physio.milestone.reached` (TR-010), `wound.event` (OP-017), `infection.case.opened` (IP-012).

## 8. Screens (UI)

- **Skeleton bone map** (component; desktop/tablet): adult/paeds SVG front/back with hover labels; existing marks colour-coded (active red, healing amber, united green, implant grey); click → New Fracture sheet; `L/R` toggles side; keyboard search bone name.
- **New/Edit fracture sheet** (desktop/tablet): cascading AO pickers with diagram thumbnails, open/closed toggle with Gustilo chips, paediatric toggle, regional classification select, ICD-10 auto, mechanism (from TR-001), MLC badge; `Ctrl+S` save, `Ctrl+Enter` confirm.
- **Fracture card / detail** (desktop 3-pane; tablet 2-pane): header (bone/side/AO/open/Gustilo/status/weeks since injury), plan panel with weight-bearing badge, X-ray timeline strip (thumbnails, labels, weeks) with Compare button (OHIF side-by-side, synced), events feed, complications, open-fracture bundle checklist with timers, PROMs; real-time updates when OT/cast events arrive.
- **Healing assessment form** (desktop): measurements, RUST/RUSH pickers per cortex, implant status, union decision; `U` mark united.
- **Worklists** (desktop): provisional to confirm, unassigned studies, non-union watch, open-bundle breaches, overdue follow-up X-ray; filters, bulk assign.
- **Registry admin** (desktop): dataset completeness, validation errors, export batches; catalogue editor.
- **Patient fracture card** (PE-001 phone): plain-language summary, weight-bearing instructions, cast care, next X-ray date, exercise links (OP-038).
- Offline: ER/ward tablets can create provisional entries and events offline (queued); imaging comparison requires network.
- Print: fracture summary (A4) for referral/discharge, weight-bearing instruction sheet (bilingual), registry extract.

## 9. Integrations

- EN-008 Orthanc/OHIF: study metadata (body part, laterality, StudyInstanceUID), presigned thumbnails, side-by-side compare with annotation persistence (DICOM SR/GSPS or JSON annotations); OP-008 structured reports (fracture findings fields mapped to registry).
- TR-003 implant usage; TR-004/IP-006 op-note; TR-005 cast events; OP-015/TR-010; EN-027 SNOMED/ICD; EN-039 forms; RC-008 estimates; EN-028 consent; TR-011 export (CSV/FHIR Condition + Procedure + ImagingStudy); optional national registry connector via EN-017.
- Fallbacks: PACS down → manual attach later from unassigned tray; ICD service down → cached codes.

## 10. Reports & Analytics

- Fracture census by bone/segment/AO type, open vs closed, Gustilo mix, mechanism, age/sex, MLC share; time-to-surgery for hip fractures (≤ 48 h KPI), open-fracture antibiotic ≤ 1 h and debridement ≤ 24 h compliance; time-to-union by bone/treatment; non-union/delayed union rate; SSI rate per procedure (with IP-012); implant failure/re-operation rate; loss-to-follow-up %; fragility fracture pathway uptake; surgeon-level outcomes (restricted); paediatric physeal injuries.
- Read models: `analytics.mv_fracture_registry`, `analytics.mv_fracture_kpi_monthly`, `analytics.mv_open_fracture_bundle`, `analytics.mv_nonunion_watch`.

## 11. Notifications

- Surgeon: provisional entries awaiting confirmation (daily digest), unassigned studies, non-union watch, open-bundle timers (in-app + phone push).
- Physio/nursing: weight-bearing change; plaster room: immobilisation request.
- Patient/attendant (EN-009): follow-up X-ray due, cast care, red-flag instructions (compartment syndrome symptoms) in local language.
- Quality/MRD: registry validation failures, monthly KPI digest; MLC fractures to TR-008 (police status unaffected).

## 12. Permissions (RBAC keys)

`ortho.fracture.create|read|list|update|confirm|event|close`, `ortho.plan.write`, `ortho.timeline.write`, `ortho.complication.write`, `ortho.registry.export`, `ortho.configure`.
Defaults: Ortho surgeon/consultant: all except configure/export; Resident: create/update/event/plan (co-sign); EM physician: create (provisional), read, event; Radiologist: read, timeline.write (findings); Plaster tech/OPD nurse: read, event (cast types only); Physio: read; Ward nurse: read; MRD coder: read, update (codes), registry.export; Quality/MS: read/list, export; Admin: configure; Patient: own fracture card via PE-001; Auditor: read.

## 13. Non-functional

- Volumes: 150–250 new fractures/day (2000-bed trauma-ortho centre), 50k open fracture episodes, 500k timeline studies over 5 y; bone map for a patient with 30 marks renders < 100 ms.
- p95: create fracture < 200 ms, fracture detail with timeline < 250 ms (thumbnails lazy), catalogue picker < 50 ms (Redis-cached), study auto-attach within 30 s of `rad.study.completed`.
- Offline: provisional create/events queued; classification catalogue cached in PWA.
- Printing: A4 summaries; bilingual instruction sheets.
- Accessibility: pickers keyboard-navigable; map has list alternative; colour + icon status.
- Security: MLC ABAC; audit all confirm/close/version changes; registry export audited with row counts.

## 14. Acceptance Criteria

1. Given surgeon clicks left tibial shaft on the bone map, then New Fracture opens with bone=tibia, side=left, segment=2 preselected; choosing type B, group 2, subgroup 1 renders `42-B2.1`, ICD-10 S82.2 suggested; save emits `ortho.fracture.created`.
2. Given open fracture toggled, then save is blocked until Gustilo grade chosen; choosing IIIB creates open-fracture bundle checklist and prompts plastics referral.
3. Given ER doctor creates a provisional entry from TR-001 secondary survey, then the entry shows `provisional`, appears in the ortho worklist, and confirmation by resident creates a co-sign task; consultant confirm sets `confirmed` with new version.
4. Given an X-ray "Left tibia AP/Lat" completed 2 h after diagnosis, then it auto-attaches to the timeline labelled `injury` (or `post_reduction` if a reduction event exists), thumbnail visible within 30 s.
5. Given a study of the right tibia for a patient with only a left tibia fracture, then it lands in the unassigned tray, not on the timeline.
6. Given Compare on week 6 vs week 12 films, then OHIF opens side by side with synced zoom, and RUST scores saved (e.g. 7 → 10) update union_status to progressing→united candidates.
7. Given plan set to ORIF with NWB 6 weeks, then TR-004 OT request is pre-filled (procedure, side, implant family) and OP-015 sees NWB restriction; changing to PWB 50 % notifies physio and ward.
8. Given OT case completed with implants scanned (TR-003), then a `surgery` event with implant list appears on the fracture and post-op film label is offered for the next study.
9. Given no healing film for 13 weeks after ORIF, then the fracture appears on non-union watch; declaring non-union at 4 months requires override reason; at 7 months no reason needed.
10. Given hip fracture in a 72-year-old from a ground-level fall, then a fragility flag and osteoporosis pathway prompt appear; response (ordered/declined) is stored.
11. Given a right femur fracture record and an OT booking created for the left side, then booking is blocked with laterality mismatch until reconciled.
12. Given attempt to create a second open entry for the same bone/segment/side, then system prompts to add an event to the existing fracture instead.
13. Given union declared with a united film, then status = united, time_to_union computed in weeks, PE-002 recall stops, and TR-011 outcome updates.
14. Given a registry export for last quarter, then only validated records are included, MLC records are pseudonymised, and the batch is audited with counts.
15. Given a resident without `ortho.fracture.confirm`, then confirm returns 403 and the provisional state persists.
16. Given antibiotic time recorded 95 min after arrival for an open fracture, then `ortho.fracture.open_bundle_breached` is emitted and shown in the KPI report.
17. Given a posterior hip dislocation recorded at 14:00 with no reduction event by 19:30, then the reduction ≤ 6 h timer shows amber at 18:48 and red at 20:00 with a page to the on-call orthopaedic surgeon.
18. Given a 3-year-old with a spiral femur fracture and a history "fell from sofa", then the NAI screening prompt appears; marking "concern" opens the child-protection SOP task and TR-008 reporting workflow.
19. Given three long-bone fractures under one trauma episode, then TR-007 receives one sequencing proposal listing all three with the physiology flags from TR-006, and each fracture retains its own timeline and plan.
20. Given the fracture detail page for a patient with 40 timeline studies, then it renders in < 250 ms p95 with lazy thumbnails and no more than 3 API calls.
21. Given an ER-tag patient with a provisional fracture merged into an existing UHID, then the fracture re-points to the UHID, its events/timeline stay intact, and the audit shows the merge.
22. Given a plan switch from conservative to ORIF after loss of reduction, then plan v2 is stored with reason, the active TR-005 cast is flagged for removal, and a TR-004 request is pre-filled with side/site.
23. Given seed data loaded, then the AO/OTA catalogue contains all bones/segments/types with 2018 codes and the picker returns options for bone 4 segment 4 (malleolar) only for tibia/fibula.

## 15. Enhancements / Later phases

- From VIMS costed sheet: X-ray comparison & post-op follow-up (OP-009/here), rehab referral (TR-010), implant log (TR-003) — all Phase 6.
- (market) Competitor HMS have only free-text "orthopaedics" — TR-002 adds: AI fracture detection/classification suggestions from DICOM (AI-007, Phase 12); automatic RUST scoring; 3D CT reconstruction viewer for complex articular fractures (Phase 12+); national ortho/hip fracture registry connectors (e.g. Indian Hip Fracture Registry) via EN-017; PROM auto-collection via WhatsApp (EN-030); bone-health/FLS module; research cohort builder (EN-001); paediatric growth-plate follow-up reminders (OP-033).

## 16. Open Questions for the Hospital

1. AO/OTA version in use (2007 vs 2018 notation) and whether full subgroup coding is expected at diagnosis or only after imaging review.
2. Which regional classifications to enable (Garden, Schatzker, Neer, Weber, Tile, Sanders…) and paediatric PCCF?
3. Policy: block vs warn when a fracture diagnosis lacks a registry entry; who may confirm (consultant only?).
4. Open-fracture bundle targets (antibiotic ≤ 1 h, debridement ≤ 12/24 h) and plastics availability on site.
5. Healing scores preferred (RUST/mRUST/RUSH) and follow-up X-ray schedule per fracture type (feeds OP-009 protocols).
6. Non-union definitions and watch thresholds; hip fracture time-to-surgery KPI target (≤ 48 h?).
7. Fragility fracture/FLS pathway present? DEXA on site?
8. Registry participation (state trauma registry, ICMR NTR, hip fracture registry) and required dataset.
9. Patient-facing fracture card content and languages.
10. Retention & MLC access rules for fracture photos and films.
11. Should residents be allowed to confirm classifications for simple fractures (config) or always consultant?
12. Bilateral/polyfracture sequencing preferences to seed in TR-007 rules (femur first vs pelvis first, etc.)?
13. Which patient-reported outcome instruments per fracture type and at which timepoints (6 w/3 m/6 m/1 y)?
