# OP-011 — Dietician & Nutrition (Assessment, Diet plans, IP diet coordination, Follow-up, Progress charts)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | OPD Clinical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Module ID       | OP-011                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Phase           | 8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Complexity      | Low–Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Depends on      | OP-002 (referrals from doctors), OP-001 (dietician appointments/queue), OP-007 (height/weight/BMI vitals), OP-004 (lab values HbA1c/lipids/RFT/albumin), NC-033 (dietary kitchen/canteen: diet orders → meal dispatch), IP-003 (IP diet orders, nursing feedback, NRS-2002/MUST screening at admission), IP-009 (ICU enteral/parenteral nutrition), OP-012 (renal diet for dialysis), OP-014 (health check-up dietician consult), OP-031 (onco nutrition), OP-033 (paeds growth), EN-039 (assessment forms), EN-009 (SMS/WhatsApp), PE-001/PE-002 (portal, follow-up reminders), OP-005 (consult/plan billing), NC-006 (supplement inventory), EN-027 (food composition master IFCT 2017), OP-021 (referral tracking) |
| Feature flag    | `module.dietician.enabled` (sub: `diet.kitchen_link`, `diet.supplement_inventory`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Primary roles   | Dietician (39)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Secondary roles | Doctor (refers, views plan), Nurse — Ward (IP diet order execution), Kitchen/Canteen staff (53), Receptionist (24), Patient (portal: plan, food diary), Billing (27), Quality (54: nutrition screening compliance NABH)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Regulatory      | NABH 5th ed. COP.7 (nutritional screening within 24 h of admission, therapeutic diet by dietician, documented), FSSAI (kitchen/food safety, allergen labelling), ICMR-NIN RDA 2020 & IFCT 2017 food composition database, WHO Asian BMI cut-offs, ESPEN/ASPEN guidance for enteral/parenteral, DPDP (dietary/religious preference is sensitive data — purpose-limited)                                                                                                                                                                                                                                                                                                                                                |

## 1. Purpose

OP-011 gives dieticians a queue of referred and walk-in patients, structured nutritional assessment (anthropometry, body composition, 24-h recall, allergies, gap analysis versus RDA), a template-driven diet-plan builder (meal-wise food items with quantities, calories and macros computed from the IFCT food master, adapted for allergies, religious/regional cuisine), pushes IP therapeutic diets to the kitchen (NC-033) with dispatch tracking and patient feedback, and tracks progress (weight/BMI/lab trends) with scheduled follow-ups and reminders.

## 2. Users & Jobs-to-be-done

- **Dietician** (desktop/tablet; 25–40 OP consults + 60–150 IP diet reviews/day per dietician): see queue (referrals + appointments + IP screening positives), assess in ≤ 10 min, build/adjust plan from template in ≤ 5 min, print/send plan, order IP diet to kitchen, follow-up.
- **Doctor**: refer with reason (diabetes/CKD/obesity/malnutrition/post-surgery/pregnancy/paeds), read plan summary in timeline.
- **Ward nurse**: sees active diet order on bed card; records intake %/feedback; NRS-2002/MUST screening triggers dietician referral.
- **Kitchen**: receives diet orders per meal with counts and allergen flags (NC-033).
- **Patient**: portal/app view of plan, food diary, weight log, reminders.

## 3. Core Workflows

### 3.1 Patient assignment

1. Doctor (OP-002/IP) refers → `referral.created` (OP-021 engine, target=dietician, reason, urgency) → dietician queue + notification. Walk-in: receptionist books dietician appointment (OP-001) → standard token/queue (EN-006, department Dietetics). IP: NRS-2002/MUST screening score ≥ 3 (IP-003 admission assessment) auto-creates referral; ICU auto-referral for ventilated/NPO > 48 h (config).
2. Queue card shows source, reason, diagnosis, latest BMI, allergies, diet-relevant labs.

### 3.2 Nutritional assessment

1. Form (EN-039 seeded "Adult nutrition assessment", "Paediatric", "Antenatal", "Renal", "Oncology", "Bariatric"): height/weight (from OP-007 or entered; IP: bed weight), BMI auto (WHO Asian cut-offs), ideal body weight, waist/hip, MUAC/triceps skinfold (optional), body composition (BIA device via EN-042 or manual: fat %, muscle mass), weight history (% loss in 3/6 months → malnutrition flag), medical history/diagnoses (from chart), medications affecting nutrition, food allergies/intolerances (writes to patient allergy list with type=food), dietary preferences (veg/non-veg/eggetarian/vegan/Jain/halal/regional cuisine, religious fasting), appetite, GI symptoms, dentition/swallow (link OP-035 speech for dysphagia — IDDSI level), activity level, **24-hour diet recall** (meal-wise items → auto energy/macro from food master) & food frequency, biochemical (HbA1c, FBS, lipids, creatinine/eGFR, K, albumin, Hb, vit D, B12 pulled from OP-004), functional (handgrip optional).
2. System computes: BMR (Mifflin-St Jeor; Schofield for paeds), TDEE by activity factor, requirements (kcal/kg, protein g/kg per condition e.g. CKD non-dialysis 0.6–0.8, dialysis 1.0–1.2, critical care 1.2–2.0), micronutrient targets (ICMR-NIN RDA 2020 by age/sex/pregnancy) → **gap analysis** table (intake vs requirement, % met, red/amber) → nutritional diagnosis (PES statement, optional) → malnutrition classification (GLIM/SGA).
3. Save → versioned document; Event `diet.assessment.recorded`.

### 3.3 Diet plan creation

1. Choose template (library: Diabetic 1200/1500/1800 kcal, Cardiac/low-salt, Renal (pre-dialysis/HD/PD, K/PO4/fluid limits), Post-surgery (clear → full liquid → soft → normal progression), Paediatric (by age), Geriatric, Weight management, High-protein, Low-residue, Gluten-free, GDM/antenatal, Hepatic, Bariatric, Oncology, Enteral formula regimens) filtered by conditions & preferences → plan pre-filled meal-wise (Early morning/Breakfast/Mid-morning/Lunch/Evening snack/Dinner/Bedtime) with food items (IFCT master + hospital recipes with portion sizes in household measures: katori/cup/piece/tbsp) → quantity → kcal, protein/carb/fat/fibre, Na/K/PO4/fluid auto-totalled vs targets; exchange lists supported.
2. Customisation: swap items respecting allergen/preference (allergen cross-contamination alert when item or recipe contains flagged allergen incl. "may contain"), regional cuisine variants (South/North/East/West Indian, continental), fasting days, cost per day (therapeutic diet cost tracking), supplements (ONS/enteral formula) with dose → NC-006 supplement inventory issue if in-house.
3. Special considerations & instructions (free text + multilingual patient education leaflets PE-003) → sign → **Diet plan PDF** (patient language, pictorial portion guide) → print/WhatsApp/portal; Event `diet.plan.created`.

### 3.4 IP diet coordination

1. Dietician (or doctor via IP order set) sets **IP diet order**: diet type code (NPO, clear liquid, full liquid, soft, normal, diabetic, renal, cardiac, low-salt, high-protein, bland, tube feed formula & rate, texture IDDSI 0–7, thickened fluids), allergen flags, meal-time preferences, start/stop, calorie level → NC-033 kitchen receives per-meal production list & tray tickets (bed, name, UHID, diet code, allergens) → dispatch tracking (prepared → dispatched → delivered → tray collected) → nurse/patient records intake % (0/25/50/75/100) & feedback rating → dietician sees low intake alerts (< 50 % for 2 meals) → reassess.
2. Diet changes (NPO for surgery/procedure, resume post-op) from IP-006/OP-010 events auto-adjust; discharge → discharge diet plan attached to IP-002 summary.

### 3.5 Tracking & follow-up

1. Progress: weight/BMI trend (OP-007 + patient self-log via PE-001), lab trends (HbA1c, lipids, eGFR, albumin), adherence self-report, food diary review; visual graphs; goal tracking (target weight, HbA1c).
2. Follow-up scheduling (2–4 weeks default per template) → OP-001 appointment + reminders (SMS/WhatsApp D-1) via PE-002; missed → recall list.
3. Outputs: assessment report, plan PDF, progress chart, kitchen dispatch order, monthly nutrition KPIs.

### 3.6 Exceptions

- Allergen conflict → hard warning; override with reason. Kitchen unable to supply item → substitution suggestions. Offline: assessment forms cache on tablet; plan builder needs food master cached (≈ 5k items) — supported.

## 4. Data Model (schema `specialty`)

- **food_items** (mdm): id, hospital_id (null = global IFCT seed), code, name, local_names jsonb, group, per_100g jsonb (kcal, protein, carb, fat, fibre, na, k, po4, ca, fe, sugar), allergens text[], veg_class enum(veg/egg/non_veg/vegan), portion_units jsonb ([{unit:'katori', grams}]), cost_per_100g, is_active. Trigram index on name.
- **recipes**: id, hospital_id, name, ingredients jsonb, per_serving jsonb, allergens (derived), cuisine, texture_iddsi, cost.
- **diet_templates**: id, hospital_id, name, condition_tags text[], kcal_level, meals jsonb ([{meal, items:[{food_id, qty, unit}]}]), targets jsonb, followup_weeks, is_active, version.
- **nutrition_assessments**: id, hospital_id, branch_id, patient_id, encounter_id?, admission_id?, referral_id?, dietician_id, form_response_id, anthropometry jsonb, weight_loss_pct_3m/6m, bmi, bmr, tdee, requirements jsonb, recall_24h jsonb, intake_totals jsonb, gap_analysis jsonb, malnutrition_class enum(none/moderate/severe), sga enum(A/B/C)?, nrs2002 int?, pes_statement, preferences jsonb, food_allergies text[], signed_at, version. Index (hospital_id, patient_id, created_at desc).
- **diet_plans**: id, hospital_id, patient_id, assessment_id, template_id?, name, kcal_target, macro_targets jsonb, meals jsonb, totals jsonb, restrictions jsonb (na/k/po4/fluid), supplements jsonb, instructions, cost_per_day, valid_from/to, status enum(draft/active/superseded/closed), document_id, signed_by, version.
- **ip_diet_orders**: id, hospital_id, branch_id, admission_id, patient_id, diet_code (lookup `diet_codes`), texture_iddsi, fluid_iddsi, allergens text[], kcal_level, tube_feed jsonb, start_at, end_at, ordered_by, status enum(active/held/stopped), reason; index (hospital_id, branch_id, status).
- **meal_dispatches** (NC-033 owns; referenced): order_id, meal, date, status, delivered_at, intake_pct, feedback_rating, comments.
- **nutrition_followups**: id, patient_id, plan_id, due_at, appointment_id?, status; **patient_food_diary** (PE-001 writes): patient_id, at, items jsonb, photo_key?; **weight_logs** via clinical.vitals context `home`.
- **supplement_issues** (if `diet.supplement_inventory`): id, patient_id, item_id (NC-006), qty, batch, issued_by, bill_item_id?.

## 5. Business Rules & Validations

- BMI from measured values only; adult categories WHO Asian (< 18.5 under, 18.5–22.9 normal, 23–24.9 overweight, ≥ 25 obese); paeds via WHO/IAP z-scores (OP-033).
- Requirement calculators: Mifflin-St Jeor (adult), Schofield/WHO (paeds), Harris-Benedict optional; stress/activity factors configurable; protein g/kg by condition table (editable).
- Plan totals within ±10 % of kcal target and macro ranges else warning; renal plans enforce K/PO4/Na/fluid caps; diabetic plans enforce carbohydrate distribution; allergen present → block until swapped or reason.
- Food allergies recorded here write to the patient allergy master (type food) → visible in banner; religious/dietary preference stored as sensitive (purpose-limited, not exported to marketing).
- IP diet order: exactly one active diet order per admission (NPO overrides); changes cut-off times before kitchen production (config: e.g. lunch changes by 10:30) else next meal; NABH screening: every admission screened within 24 h — dashboard shows compliance.
- Assessment/plan documents versioned & signed; plans expire (valid_to) → follow-up recall.
- Billing: dietician consult & plan charge via OP-005 (IP: per-day dietary charge optional).

## 6. API Surface (`/api/v1/diet`)

| Method | Path                                              | Purpose                                 | Permission                                     | Idem | Pag    |
| ------ | ------------------------------------------------- | --------------------------------------- | ---------------------------------------------- | ---- | ------ |
| GET    | /queue?dietician=&source=                         | referrals + appointments + IP screening | diet.queue.read                                | –    | cursor |
| POST   | /assessments                                      | create assessment                       | diet.assessment.create                         | Y    | –      |
| GET    | /patients/{id}/assessments                        | history                                 | diet.assessment.read                           | –    | cursor |
| POST   | /plans                                            | create plan (from template)             | diet.plan.create                               | Y    | –      |
| PATCH  | /plans/{id}                                       | edit draft / close                      | diet.plan.update                               | Y    | –      |
| POST   | /plans/{id}/sign                                  | sign → PDF                              | diet.plan.sign                                 | Y    | –      |
| GET    | /plans/{id}/pdf                                   | render                                  | diet.plan.read                                 | –    | –      |
| POST   | /ip-diet-orders, PATCH /ip-diet-orders/{id}       | IP diet order                           | diet.ip_order.create/update                    | Y    | –      |
| GET    | /ip-diet-orders?ward=&date=                       | ward diet list                          | diet.ip_order.read                             | –    | cursor |
| POST   | /ip-diet-orders/{id}/intake                       | intake %/feedback (nurse/patient)       | diet.intake.record                             | Y    | –      |
| GET    | /food-items?q= , /recipes, /templates (+POST/PUT) | masters                                 | diet.configure (write) / diet.plan.read (read) | Y    | cursor |
| POST   | /calc/requirements                                | BMR/TDEE/requirements                   | diet.assessment.create                         | –    | –      |
| GET    | /patients/{id}/progress                           | weight/BMI/labs series                  | diet.assessment.read                           | –    | –      |
| POST   | /followups                                        | schedule                                | diet.followup.create                           | Y    | –      |
| GET    | /stats/dashboard                                  | KPIs                                    | diet.report.read                               | –    | –      |

## 7. Domain Events (outbox)

- `diet.referral.received` (from `referral.created`), `diet.assessment.recorded` {patient_id, bmi, malnutrition_class} → timeline, NABH screening KPI; `diet.plan.created|signed|closed` → PE-001, OP-005; `diet.ip_order.created|changed|stopped` → NC-033 kitchen, IP-003 bed card; `diet.intake.low` {admission_id, meals} → dietician alert; `diet.followup.due|missed` → PE-002.
- Consumes: `referral.created`, `visit.checked_in`, `vitals.recorded`, `lab.result.final`, `ip.admitted|discharged`, `ot.case.scheduled` (NPO), `procedure.scheduled` (fasting), `meal.delivered` (NC-033), `patient.allergy.recorded`.

## 8. Screens (UI)

1. **Dietician queue** (desktop/tablet): tabs OP referrals / appointments / IP reviews / follow-ups; `Space` call next; real-time.
2. **Assessment workspace** (desktop 3-pane / tablet 2-pane): banner with BMI/allergies; form sections; 24-h recall grid with food search (`/` focus, `Enter` add, `Tab` qty) and live totals; gap analysis panel; `Ctrl+S` save, `Ctrl+Enter` sign.
3. **Diet plan builder**: template picker → meal grid, drag items between meals, live kcal/macro bars vs target (green/amber/red), allergen chips, cost/day, portion pictures; print preview; `Ctrl+D` duplicate meal, `Ctrl+P` PDF.
4. **IP diet board** (desktop, ward/dietician; TV optional in kitchen): beds × meals with diet codes, allergens, NPO flags, dispatch status, intake %; filters ward; real-time.
5. **Progress view**: charts weight/BMI/HbA1c/lipids/eGFR with plan markers; food diary photos.
6. **Masters**: food items/recipes/templates editor with IFCT import (CSV).
7. **Patient portal/app** (PE-001/OP-020): my diet plan, meal reminders, food diary, weight log.

## 9. Integrations

- NC-033 kitchen (internal events; optional printer for tray tickets EN-005), BIA body composition (EN-042 serial/BLE e.g. Tanita/InBody CSV), IFCT 2017 seed import, EN-009 WhatsApp for plan PDF/reminders, PE-001 portal, OP-004 labs, OP-007 vitals.

## 10. Reports & Analytics

- Nutrition screening compliance (NABH), referrals TAT, assessments/plans per dietician, malnutrition prevalence by ward, IP diet order counts by type/day (kitchen planning), intake < 50 % list, therapeutic diet cost per patient-day, weight/HbA1c outcome by programme, follow-up adherence, supplement consumption. Read model `analytics.diet_daily`.

## 11. Notifications

- Patient: plan PDF (WhatsApp), meal/water reminders (opt-in), follow-up D-1, weight log nudge weekly.
- Dietician: new referral, low intake alert, plan expiring, missed follow-up.
- Kitchen: diet order change after cut-off (urgent), allergen alert on new orders.

## 12. Permissions (RBAC keys)

`diet.queue.read`, `diet.assessment.create|read`, `diet.plan.create|update|sign|read`, `diet.ip_order.create|update|read`, `diet.intake.record`, `diet.followup.create`, `diet.configure`, `diet.report.read`, `diet.export`. Defaults: Dietician — all clinical; Doctor — ip_order.create/read, plan.read; Ward nurse — ip_order.read, intake.record; Kitchen — ip_order.read (via NC-033); Patient — own plan read (portal scope).

## 13. Non-functional

- 2000-bed: 300 OP diet consults/day, 1500 active IP diet orders, 4500 tray dispatches/day; food search p95 < 100 ms (trigram + Redis); plan PDF < 3 s.
- Offline: assessment & plan builder work with cached food master; sync with idempotency; kitchen list refresh ≤ 30 s.
- Print: A4 plan (pictorial), tray tickets (thermal 80 mm), ward diet list.
- i18n: food names in local languages; plan PDF in patient language; RTL-ready.

## 14. Acceptance Criteria

1. Given a referral from OP-002 with reason "T2DM, BMI 31", when created, then it appears in the dietician queue within 2 s with BMI, HbA1c and allergies pre-loaded.
2. Given a 24-h recall of listed foods, when saved, then kcal/protein/carb/fat totals are computed from the food master and the gap analysis shows % of requirement per nutrient.
3. Given a patient with peanut allergy, when a plan item containing peanut (or "may contain") is added, then a red allergen alert blocks save until swapped or an override reason is entered.
4. Given a renal HD template, when totals exceed K 2000 mg/day, then the K bar turns red and sign is blocked (config hard) until adjusted.
5. Given an IP diet order changed to NPO at 22:00 for morning surgery, then the kitchen production list for breakfast excludes the patient and the bed card shows NPO within 5 s.
6. Given intake recorded < 50 % for two consecutive meals, then the dietician gets an alert and the patient appears in "low intake" list.
7. Given a signed plan, when the dietician edits it, then a new version is created; the patient's portal shows the latest version and old PDF remains retrievable.
8. Given an admission without a nutrition screening after 24 h, then it appears on the NABH compliance dashboard as non-compliant.
9. Given a follow-up due date passes with no visit, then the patient enters the recall list and a WhatsApp reminder is sent once (DLT template).
10. Given a nurse without `diet.plan.sign`, when calling POST /plans/{id}/sign, then 403 and audit entry.
11. Given a food item name typed in Hindi/regional transliteration, when searched, then trigram search returns the item within 100 ms.

## 15. Enhancements / Later phases

- Sheet row 7 enhancements: AI-based meal recommendation per condition (Phase 12 AI-002), patient food preference learning (Phase 12), therapeutic diet cost tracking (Phase 8 core above), meal delivery rating by patient (Phase 8 with NC-033), allergen cross-contamination alert (Phase 8 core), nutritional supplement inventory (Phase 8 flag `diet.supplement_inventory` via NC-006).
- Costed proposal line 1566 (assessment, BMI, plans, templates, IP coordination, follow-up, progress charts) — core.
- (market) SMART HMIS/PCS dietary module basics covered; photo-based food logging with AI recognition (AI-003) later; wearable step/glucose sync (EN-042/OP-020) later; group diet counselling & bariatric programme (PE-005).

## 16. Open Questions for the Hospital

1. Do you run an in-house kitchen with tray-line (NC-033) or outsourced catering? Order cut-off times per meal?
2. Which diet codes/templates do you use today (list with kcal levels)? Regional cuisines to seed?
3. Is dietician consult chargeable in OP/IP? Per-day dietary charge?
4. Nutrition screening tool at admission (NRS-2002, MUST, SGA, STRONGkids for paeds)?
5. Do you stock ONS/enteral formulas in pharmacy or dietary store (supplement inventory)?
6. BIA/body-composition devices to integrate? Portion picture library available?
