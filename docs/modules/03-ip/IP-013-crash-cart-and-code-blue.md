# IP-013 — Crash Cart & Code Blue (cart register, sealed checklists, expiry alerts, code activation & broadcast, code documentation with timestamps, usage log, replenishment, debrief & audit)

| Field | Value |
|---|---|
| Domain | IP / Inpatient |
| Module ID | IP-013 |
| Phase | 7 |
| Priority | P1 |
| Complexity | Low–Medium |
| Depends on | IP-001 (wards/beds/locations), IP-003 (nursing engine: NEWS2 escalation ≥ 7 optional rapid-response trigger, ward handover "crash cart OK", tasks), IP-004 (nurse mobile code activation), IP-009 (ICU code / post-ROSC transfer), OP-006 (ER resuscitation bay), IP-014 (cart drug replenishment, narcotic items on cart, expiry from batch master), NC-006 (item master, batches, FEFO, kits), OP-003 (pharmacy drug master), NC-020 (defibrillator/monitor asset, PM/calibration), EN-013 (cart/seal QR labels, item barcodes), EN-005 (label/checklist print), EN-037 (broadcast push, on-call routing), EN-018 (TV/PA banner), EN-009 (SMS fallback), NC-030 (code team roster), NC-015 (incident/CAPA, NABH indicators), IP-002 (death path), IP-017 (mortuary), IP-005 (code consumables charging policy), EN-024 (audit), EN-039 (form templates), IP-010 (doctor push) |
| Feature flag | `module.ip_crash_cart.enabled` (sub-flags: `code_blue.broadcast_pa`, `code_blue.rapid_response`, `crash_cart.rfid_seal`, `code_blue.charge_consumables`) |
| Primary roles | Nurse — Ward (17), Nurse — ICU (18), Nurse — ER (19), Nurse Supervisor / Matron (22), Pharmacist IP (31), Doctor — IP (7), Emergency Physician (8), Intensivist (11), Anaesthetist (10), Resident (14) |
| Secondary roles | Biomedical Engineer (48: defibrillator, suction, laryngoscope PM), Quality Manager (54), MS (4), Pharmacy In-charge (32), Ward Boy (23), Security (51: PA/lift priority), Auditor (58) |
| Regulatory | NABH 5th ed. COP.5 (uniform cardio-pulmonary resuscitation across the organisation: staff trained, equipment & drugs available, events documented & analysed), COP.5.d (post-event analysis / debrief), MOM.5 (emergency medications uniformly available, checked & replenished, expiry), FMS.6 (equipment maintenance/BME), HRM (BLS/ACLS competency), NDPS Act (narcotics on cart, if any), Drugs & Cosmetics Rules (expired stock segregation), BMW Rules 2016 (sharps/used consumables), Utstein-style resuscitation registry (for reporting), CDSCO UDI for defibrillator pads/devices |

## 1. Purpose
IP-013 guarantees resuscitation readiness and documents every resuscitation. It maintains a register of every crash cart / emergency trolley / emergency drug kit in the hospital with a standard, configurable per-drawer content list; enforces sealed daily/shift checklists with expiry visibility; runs Code Blue (and configurable Rapid Response / Code Pink / Code Stroke variants) activation with location-aware team broadcast; captures a time-stamped code record (CPR start, rhythm, shocks, drugs, airway, ROSC/outcome) with a one-tap recorder UI; auto-generates the cart usage log and pharmacy replenishment indent from items used; and closes the loop with debrief, incident link and NABH/Utstein indicators.

## 2. Users & Jobs-to-be-done
- **Ward / ICU / ER nurse** (tablet/phone at the cart; desktop): shift/daily seal check in ≤ 90 s (scan cart QR → confirm seal number intact → sign; or full open-check monthly), break seal on use, activate Code Blue with one tap (bed known from context), act as code recorder on tablet during resuscitation, request replenishment.
- **Code team** (doctor on call, anaesthetist, intensivist, ICU nurse, ward boy) (phone push + PA): receive broadcast with exact location and route, acknowledge "on the way", one arrives records role in code record.
- **Nurse supervisor / matron** (desktop/TV): live view of all carts (checked / due / seal broken / expiry ≤ 30 d), active codes, cart downtime, replenishment pending.
- **IP pharmacist** (desktop): approve auto-indent from usage, replace near-expiry items proactively (FEFO), re-seal cart with new seal number, print drawer content labels.
- **Biomedical engineer** (phone/desktop): defibrillator daily self-test result, battery, PM/calibration due; suction/laryngoscope/BVM checks (NC-020 asset link).
- **Doctor / team leader** (tablet/desktop): review, correct and sign the code record ≤ 24 h; debrief; complete outcome (ROSC, death, transferred to ICU).
- **Quality** (desktop): code review, response times, survival to discharge, checklist compliance, CAPA.

## 3. Core Workflows

### 3.1 Cart configuration & register
1. **Admin/pharmacy in-charge** defines **cart templates** (adult / paediatric / neonatal / OT / ER / dialysis-unit / mobile bag) with drawers (D1 airway, D2 breathing/circulation, D3 drugs, D4 IV/fluids, D5 misc, top: defibrillator, monitor, suction, O2, BVM, laryngoscope set, backboard) and per-drawer **content lines**: item (NC-006 item / OP-003 drug), standard qty, is_critical, unit, alternate item, expiry-tracked bool. Seeded default per AHA/NABH-common list (adrenaline 1 mg amp ×10, amiodarone, atropine, calcium gluconate, dextrose 25/50 %, sodium bicarbonate, naloxone, magnesium sulphate, lignocaine, adenosine, dopamine/noradrenaline, hydrocortisone, salbutamol, ET tubes sizes, LMA, guedel, BVM, suction catheters, IV cannulas, fluids, ECG electrodes, defib pads adult/paed, gloves, syringes…), editable per hospital.
2. **Cart instances** registered per location (ward/ICU/OT/ER/dialysis/OPD/radiology/canteen-adjacent public areas etc.): code `CC-W3-01`, template, location (ward/room), asset links (defibrillator asset id NC-020, monitor, suction), seal type (numbered plastic seal / RFID `crash_cart.rfid_seal`), owner ward in-charge, check schedule (every shift / daily / weekly full open-check), QR label printed (EN-013). Event `crashcart.registered`.
3. **Stocking**: pharmacist issues items to cart via IP-014 ward-stock issue with `destination=crash_cart:{id}`; each line records batch & expiry (NC-006 batch); cart content snapshot = current stock ledger of the cart location; earliest expiry per drawer computed. Cart is then **sealed**: seal number scanned/typed, sealed_by + witness (2 sign), `sealed_at` → status `ready`.

### 3.2 Scheduled seal check (shift/daily) and full open-check
1. Task generated per cart per schedule (IP-003 task engine `type=crash_cart_check`) → **Nurse** scans cart QR (tablet/phone) → screen shows expected seal number, last check, near-expiry warnings, defibrillator self-test due, O2 cylinder pressure field, suction test, laryngoscope light test → nurse confirms `seal_intact=true` (or breaks & reports), enters O2 pressure/defib test result/battery %, signs (PIN/biometric) → status `checked` with `checked_at`, `next_due`. Missed check by `due + grace(60 min)` → task overdue → in-charge & supervisor push (EN-037), cart status `check_overdue` on dashboard.
2. **Full open-check** (weekly/monthly configurable, and after every use / re-seal): drawer-by-drawer count against template with barcode scan; discrepancies (qty short, expiry ≤ 30 d, damaged) create replenishment lines; item expiries updated from scans; two-person sign; new seal number applied. Event `crashcart.checked` {cart_id, type, ok, discrepancies}.
3. **Expiry alerts**: nightly job computes items with expiry ≤ 90/60/30/7 d and expired → pharmacist worklist + cart shows amber/red; **expired critical item on a `ready` cart forces status `not_ready`** (configurable hard/soft) until replaced. Nightly job also flags defibrillator PM/calibration overdue (NC-020) → `not_ready` (soft).
4. Handover (IP-003 §3.8 ward handover) reads `crash_cart_ok` from the latest check of the ward's carts automatically.

### 3.3 Code Blue activation & broadcast
1. **Any staff** activates: (a) IP-004/IP-003 patient context "Code Blue" button (bed pre-filled), (b) cart QR scan → "Activate code", (c) desktop nursing station, (d) physical call point/IVR integration (EN-033/EN-042 optional), (e) ER/OT/ICU consoles. Chooses code type: `code_blue` (adult), `code_blue_paed`, `code_pink` (neonatal), `rapid_response` (pre-arrest, MET), `code_stroke`, `code_trauma` (TR-001), `code_yellow` (mass casualty → OP-006). Location: bed/room/area (auto from context; searchable; free-text for public areas), patient link optional (public area/visitor codes allowed → creates ER quick registration later).
2. **System** creates `code_events` row `status=activated` with `activated_at` (server time, ms) → Event `code.activated` → **broadcast** within 2 s: push (EN-037, critical channel bypassing DND) to code team from NC-030 roster for that zone/floor + on-call anaesthetist/intensivist/resident + nurse supervisor + security (lift priority) + ward boy; PA/TV banner text "CODE BLUE — Ward 3, Bed 12" (EN-018, `code_blue.broadcast_pa`); SMS fallback if push not acked within 60 s; escalation ladder (no doctor ack in 2 min → HOD/backup). Recipients tap **"Coming"** (acked_at recorded), **"Arrived"** (arrival_at; auto-set if their badge scans cart/patient wristband).
3. **Cancel/false alarm**: activator or team leader cancels with reason (`false_alarm`, `duplicate`, `patient_stable`) within the event; broadcast "Code cancelled" sent; event retained for audit.
4. If activated from a patient with `DNR/DNAR` order active (OP-002/IP-003 flag) → banner warns "DNAR order on file — confirm activation" (does not block; logs override).

### 3.4 Code recording (resuscitation flowsheet)
1. **Recorder nurse** opens the live code record on tablet (or desktop): big-button timeline — **CPR started/stopped**, **rhythm** (VF/pVT/PEA/asystole/ROSC/sinus), **shock** (J, pads), **drug** (adrenaline 1 mg IV/IO, amiodarone 300/150 mg, atropine, others from cart drug list; auto-repeat prompts every 3–5 min for adrenaline), **airway** (BVM/LMA/ETT size, time, confirmed by EtCO2), **IV/IO access**, **compressor swap** timer (2 min metronome), **pulse check**, **cause checklist (H's & T's)**, **labs sent (ABG/K/glucose)**, **fluids**, **notes**. Every tap = `code_event_entries` row {at (server), type, detail jsonb, entered_by}; timers visible: elapsed since activation, since last adrenaline, since last rhythm check, CPR fraction.
2. **Team roles** captured: leader (doctor), airway, compressor(s), drugs, recorder, runner; arrival times auto from acks.
3. Cart seal is broken at first drug/consumable use → `crashcart.seal_broken` {cart_id, code_id} → cart status `in_use` → after code, `not_ready` until re-stocked & re-sealed.
4. **Consumables/drugs used**: recorder picks from cart content list (qty) → creates `code_consumables_used` → after closure posts IP-014 ward-stock consumption on the cart location, generates **replenishment indent** automatically (IP-014 indent `type=crash_cart_replenish`, priority urgent) and, if `code_blue.charge_consumables`, charges to IP-005 (many hospitals bundle; default configurable). Narcotic items (if any) follow IP-014 NDPS register with witness.
5. **Outcome**: `rosc` (time), `died` (time, doctor certifying → IP-002 death path, IP-017 mortuary; MLC check TR-008), `transferred_icu` (IP-001 transfer request auto-drafted to ICU with reason "post-cardiac-arrest"), `stable_in_place`, `abandoned_dnar`. Doctor (team leader) reviews and **signs** the record ≤ 24 h (co-sign for residents); unsigned → reminder to leader, then HOD at 48 h. Record is append-only, versioned, hash-chained; late entries flagged; printed as **Code Blue form** (EN-039 template incl. Utstein fields: witnessed y/n, monitored y/n, first rhythm, time to first shock, time to first adrenaline, CPR duration, ROSC, survival to discharge (filled later by IP-002 outcome)).
6. Offline: recorder UI works offline (IndexedDB), timestamps from device clock with server-offset correction; syncs on reconnect; conflicts impossible (append-only with client ids).

### 3.5 Post-code: re-stock, re-seal, debrief, review
1. **Pharmacist** fulfils replenishment indent (IP-014) → items issued to cart with batches → nurse + pharmacist perform full open-check → new seal → `ready` (target ≤ 60 min after code; downtime KPI). Meanwhile dashboard shows nearest ready cart; a ward with zero ready carts triggers supervisor alert and temporary cart relocation (`crashcart.relocated` with from/to & by).
2. **Debrief** (`code_debriefs`): within 24 h, leader/in-charge record: what went well, issues (delay categories: activation, arrival, equipment, drugs, skills), equipment failure (creates NC-020 breakdown), stock-outs (creates NC-006 note), training needs (NC-027), incident link (NC-015 if adverse). Quality reviews monthly (mortality/CPR committee) with Utstein indicators.
3. Rapid Response (`code_blue.rapid_response`): same engine, lighter record (reason: NEWS2 ≥ 7 / staff worried / chest pain / seizure / desaturation, interventions, outcome: stayed/ICU/code); IP-003 `nursing.ews.escalated` band high can auto-suggest RRT activation.

### 3.6 Exceptions
- Cart QR unreadable → manual cart code entry (audited). Device offline during check → check queued; overdue rules apply on server time after sync.
- Duplicate activations for same location within 5 min merge into one event (second activator recorded).
- Public-area code with no patient → team leader can create ER quick registration (OP-006) from the code record; the code links after.
- Seal broken without code (e.g., accidental) → nurse records `seal_broken_reason=accidental/theft_suspected/other` → full open-check required → security notified if theft.

## 4. Data Model (schema `ip`)
- **ip.crash_cart_templates** (id, hospital_id, code, name, type enum(adult/paediatric/neonatal/ot/er/mobile_bag/custom), drawers jsonb [{drawer, label}], version, active).
- **ip.crash_cart_template_items** (template_id, drawer, item_id (inventory item / drug), std_qty, unit, is_critical bool, expiry_tracked bool, alt_item_id?, sort_order) — unique (template_id, drawer, item_id).
- **ip.crash_carts** (id, hospital_id, branch_id, code unique per branch, template_id, location_type enum(ward/icu/ot/er/opd/radiology/dialysis/public/other), ward_id?, room_id?, area_text?, inventory_location_id (NC-006 sub-store), defibrillator_asset_id?, monitor_asset_id?, suction_asset_id?, seal_type enum(numbered/rfid/none), current_seal_no, sealed_at, sealed_by, sealed_witness_id, status enum(ready/checked_due/check_overdue/in_use/not_ready/relocated/retired), check_schedule jsonb {shift_check: true, full_check_days: 30}, next_check_due_at, next_full_check_due_at, earliest_expiry_at, active) — index (hospital_id, branch_id, status), (next_check_due_at).
- **ip.crash_cart_checks** (id, cart_id, type enum(seal/full/post_use/adhoc), checked_at, checked_by, witness_id?, seal_no_seen, seal_intact bool, defib_selftest enum(pass/fail/na), defib_battery_pct?, o2_pressure_bar?, suction_ok bool?, laryngoscope_ok bool?, discrepancies jsonb [{item_id, expected, found, expiry, issue}], result enum(ok/discrepancy/not_ready), new_seal_no?, notes, offline_captured bool, sha256) — partition yearly; index (cart_id, checked_at desc).
- **ip.crash_cart_stock** view over NC-006 stock ledger for `inventory_location_id` (item, batch, expiry, qty) — no separate table; **ip.crash_cart_expiry_alerts** (cart_id, item_id, batch_id, expiry, days_left, level enum(90/60/30/7/expired), raised_at, resolved_at).
- **ip.crash_cart_movements** (cart_id, from_location, to_location, reason, moved_by, at, returned_at?).
- **ip.code_events** (id, hospital_id, branch_id, code_no (series `CODE/{FY}/{SEQ}`), type enum(code_blue/code_blue_paed/code_pink/rapid_response/code_stroke/code_trauma/other), patient_id?, admission_id?, location_type, ward_id?, bed_id?, area_text?, activated_at, activated_by, activation_source enum(app/desktop/cart_qr/call_point/ivr/tv), status enum(activated/in_progress/closed/cancelled), cancelled_reason?, cart_id?, first_responder_arrived_at, doctor_arrived_at, cpr_started_at, first_shock_at, first_adrenaline_at, airway_secured_at, rosc_at?, ended_at, outcome enum(rosc/died/transferred_icu/stable/abandoned_dnar/false_alarm), witnessed bool, monitored bool, first_rhythm enum, dnar_override bool, leader_id, recorder_id, signed_by, signed_at, version, sha256) — index (hospital_id, activated_at desc), (patient_id).
- **ip.code_event_entries** (id, code_id, at, seq, type enum(cpr_start/cpr_stop/rhythm/shock/drug/airway/access/pulse_check/lab/fluid/compressor_swap/note/role/arrival/outcome), detail jsonb, entered_by, device_time, offline_captured, late_entry bool) — append-only, index (code_id, seq).
- **ip.code_team_responses** (code_id, user_id, role_expected, notified_at, channel, acked_at?, arrived_at?, role_played?).
- **ip.code_consumables_used** (code_id, cart_id, item_id, batch_id?, qty, charged bool, indent_line_id?).
- **ip.code_debriefs** (code_id, held_at, led_by, attendees jsonb, went_well, issues jsonb [{category, detail}], equipment_failure_asset_id?, incident_id?, training_needs, actions jsonb, signed_at).
- Read models: `analytics.mv_crash_cart_readiness` (per cart: status, last check, expiry min, downtime), `analytics.mv_code_indicators_monthly` (codes, response times, ROSC %, survival to discharge %, checklist compliance %).

## 5. Business Rules & Validations
- A cart is `ready` only if: seal intact & recorded, last scheduled check within schedule, no expired critical item, defibrillator self-test pass within 24 h (if asset linked) and PM not overdue (soft), all critical template items present at std qty at last full check.
- Seal number must be unique per branch and cannot be reused; re-seal requires two signatures (nurse + pharmacist or two nurses per config).
- Seal check overdue after `due + 60 min`; full check overdue after `full_check_days + 2`; overdue carts escalate: in-charge (0 min) → supervisor (30 min) → nursing head (2 h).
- Expiry policy: items expiring ≤ 30 d must be replaced within 7 d; expired critical → cart `not_ready`; pharmacist may set `soft` policy for non-critical.
- Code event timestamps come from server clock; offline device entries carry `device_time` and are corrected by measured offset; entries never editable — corrections append `type=note` with `corrects_seq`.
- Broadcast within 2 s of activation; ack SLA 60 s → SMS fallback; doctor arrival target ≤ 3 min (configurable), recorded for KPI; escalation ladder from NC-030 on-call.
- Code record must be signed by team leader ≤ 24 h; discharge summary (IP-002) auto-includes "cardiac arrest event" line; death after code triggers IP-002 death workflow + mortality review task.
- Consumables charging follows `code_blue.charge_consumables` (default false = hospital cost centre `resuscitation`); narcotic/high-alert items used → IP-014 register with witness even during code (witness can be recorded post hoc ≤ 1 h).
- Cart downtime after use target ≤ 60 min; ward with no ready cart > 30 min → supervisor alert + auto-suggest nearest ready cart for relocation.
- Numbering: `CODE/{BR}/{FY}/{SEQ:5}`; carts `CC-{WARD}-{NN}`.
- Retention: code records permanent (clinical), checks 5 y, debriefs 5 y (NABH audit cycle 3 y minimum).

## 6. API Surface (`/api/v1/crash-carts`, `/api/v1/codes`)
| Method | Path | Purpose | Permission | Idem. |
|---|---|---|---|---|
| GET/POST/PATCH | `/crash-carts/templates` | manage templates & items | `crashcart.template.manage` | – |
| GET | `/crash-carts` (?branch, ward, status; cursor) | list carts + readiness | `crashcart.cart.read` | – |
| POST/PATCH | `/crash-carts` , `/crash-carts/{id}` | register/edit cart | `crashcart.cart.manage` | – |
| GET | `/crash-carts/{id}` | cart detail, stock, expiry, last checks | `crashcart.cart.read` | – |
| GET | `/crash-carts/by-qr/{code}` | resolve scanned QR | `crashcart.cart.read` | – |
| POST | `/crash-carts/{id}/checks` | submit seal/full/post-use check | `crashcart.check.create` | yes |
| POST | `/crash-carts/{id}/seal` | apply new seal (2-person) | `crashcart.seal.apply` | yes |
| POST | `/crash-carts/{id}/break-seal` | break seal (reason/code link) | `crashcart.seal.break` | yes |
| POST | `/crash-carts/{id}/relocate` | move cart | `crashcart.cart.manage` | yes |
| GET | `/crash-carts/expiry-alerts` | worklist for pharmacist | `crashcart.expiry.read` | – |
| POST | `/crash-carts/{id}/replenish` | create IP-014 indent from discrepancies/usage | `crashcart.replenish.create` | yes |
| POST | `/codes` | activate code | `code.activate` | yes (client uuid) |
| POST | `/codes/{id}/cancel` | cancel/false alarm | `code.activate` | yes |
| POST | `/codes/{id}/ack` , `/arrive` | team response | `code.respond` | yes |
| POST | `/codes/{id}/entries` (batch) | append recorder entries (offline sync) | `code.record.write` | yes (client ids) |
| PATCH | `/codes/{id}` | roles, outcome, consumables, cart link | `code.record.write` | – |
| POST | `/codes/{id}/sign` | leader sign | `code.record.sign` | yes |
| POST | `/codes/{id}/debrief` | debrief | `code.debrief.write` | – |
| GET | `/codes` (?from,to,type,ward,outcome; cursor) / `/codes/{id}` / `/codes/{id}/print` | list/detail/PDF | `code.record.read` | – |
| GET | `/codes/active` | live codes (dashboard/TV) | `code.record.read` | – |
| GET | `/crash-carts/reports/readiness` , `/codes/reports/indicators` | KPIs | `crashcart.report.read` | – |

## 7. Domain Events (outbox)
- `crashcart.registered|updated|relocated|retired` → dashboards, NC-020 asset link.
- `crashcart.checked` {cart_id, type, result, discrepancies} → readiness read model, IP-003 handover, NC-015.
- `crashcart.check.overdue` {cart_id, minutes} → EN-037 escalation ladder.
- `crashcart.expiry.alert` {cart_id, item, days_left, level} / `crashcart.not_ready` {reason} → IP-014 pharmacist worklist, supervisor.
- `crashcart.seal_broken` {cart_id, code_id?, reason} → supervisor, pharmacy, security (theft).
- `crashcart.replenishment.requested` {cart_id, lines} → IP-014 indent; `crashcart.ready` after re-seal.
- `code.activated` {code_id, type, location, patient?, cart?} → EN-037 critical broadcast, EN-018 PA/TV, EN-009 SMS fallback, NC-030 on-call resolution, IP-010, IP-004, security lift priority.
- `code.acknowledged|arrived` {code_id, user_id, at} → live view.
- `code.cancelled` {reason} → broadcast cancel.
- `code.entry.recorded` {code_id, type} → live timeline (Socket.IO room `code:{id}`).
- `code.closed` {outcome, rosc_at, duration, first_shock_delay, first_adrenaline_delay} → IP-002 (death/transfer), IP-001 (ICU transfer request), IP-005 (charges), IP-014 (consumption/indent), NC-015 (indicators, incident if adverse), OP-006 (public-area quick reg).
- `code.record.signed` / `code.record.unsigned_overdue` → HOD; `code.debrief.completed`.
- Consumed: `nursing.ews.escalated` (band high → suggest RRT), `inventory.batch.expiry_approaching` (NC-006), `asset.pm.overdue` / `asset.selftest.failed` (NC-020), `roster.published` (NC-030), `ip.discharge.completed` (survival-to-discharge fill).

## 8. Screens (UI)
- **Crash Cart Readiness Board** (desktop; EN-018 TV variant for nursing office): grid of carts by floor/ward with colour status (green ready / amber check due or expiry ≤ 30 d / red not ready, overdue, in use), filters, drill-down; live via Socket.IO; empty state "No carts registered — add from templates".
- **Cart Check (mobile/tablet, PWA, offline-capable)**: QR scan → header (cart code, location, seal expected) → checklist toggles (seal intact, defib self-test, battery, O2 bar, suction, laryngoscope), near-expiry list, discrepancy add (scan item barcode), sign (PIN/biometric), witness for full check; shortcut: volume-up double press = start scan (where supported).
- **Cart Detail** (desktop): drawers tab (template vs current stock, batch/expiry, colour), checks history, movements, seals, linked assets & PM dates, replenishment indents; print drawer labels/contents card (EN-005).
- **Code Activation** (phone/tablet/desktop; global hotkey `Ctrl+Shift+B` on clinical screens; also big red button in patient banner menu): confirm sheet with location/patient/type → activate; DNAR warning; cancel within event.
- **Code Recorder** (tablet landscape primary; desktop; phone fallback): left timers (elapsed, since adrenaline, since rhythm check, compressor swap countdown with vibration/beep), centre big buttons (CPR start/stop, Rhythm → sub-buttons, Shock (J), Adrenaline 1 mg, Amiodarone, Other drug…, Airway, IV/IO, Pulse check, ROSC), right timeline (append-only list); keyboard: `C` CPR toggle, `S` shock, `A` adrenaline, `R` rhythm, `P` pulse check, `N` note; works offline; end-of-code sheet (outcome, roles, consumables, cart) then sign.
- **Live Code View** (desktop/TV for supervisor/ICU): active codes, responders acked/arrived, elapsed, location map; audible chime.
- **Code Review & Sign** (desktop/tablet): timeline, Utstein summary auto-computed, edit-by-append, sign, print PDF; debrief form.
- **Pharmacist Replenishment Worklist** (desktop): indents from codes/checks, near-expiry swaps (FEFO suggestion), issue → re-seal handshake.
- **Reports** (desktop): readiness compliance, response times, outcomes.

## 9. Integrations
- NC-006/IP-014 stock ledger (cart = sub-store), batch expiry feed; OP-003 drug master; NC-020 asset PM/self-test (defibrillators with network self-test export optional via EN-042); EN-037 push (critical, DND bypass) + EN-009 SMS + EN-018 PA/TV; optional physical call points/IVR (EN-033/EN-042) posting `POST /codes` with device token; EN-013 QR/RFID seals; EN-005 label print; NC-030 roster/on-call; NC-015 incident/CAPA; IP-002/IP-017 death path; TR-008 MLC.
- Retries: broadcast fan-out via BullMQ with per-channel retry; DLQ alerts IT (EN-017).

## 10. Reports & Analytics
- Cart readiness % (checks done on time / due), carts not-ready hours, expiry replacements, seal breaks by reason, defibrillator test failures.
- Code indicators (monthly, NABH COP.5 / Utstein): number of codes by type/location, activation→first responder, →doctor arrival, →first shock (shockable), →first adrenaline, CPR duration, ROSC %, survival 24 h, survival to discharge %, codes per 1000 admissions, RRT calls, % records signed ≤ 24 h, % debriefed ≤ 24 h.
- MVs: `analytics.mv_crash_cart_readiness`, `analytics.mv_code_indicators_monthly`; NC-011 dashboards; NC-015 indicator feed.

## 11. Notifications
- Push (critical): "CODE BLUE — {ward} {bed} — tap when coming"; PA/TV banner; SMS fallback text without patient name; cancel notice.
- Push to in-charge/supervisor: check overdue, cart not-ready, seal broken, no ready cart in ward, unsigned code record 24 h.
- Pharmacist: replenishment indent urgent, expiry ≤ 30 d weekly digest.
- BME: defib self-test fail / PM overdue.

## 12. Permissions (RBAC keys)
`crashcart.template.manage` (32, 3), `crashcart.cart.manage` (22, 31, 32, 3), `crashcart.cart.read` (all clinical), `crashcart.check.create` (17, 18, 19, 20, 22, 31), `crashcart.seal.apply` (31, 32, 22 with witness), `crashcart.seal.break` (17–22), `crashcart.expiry.read` (31, 32, 22), `crashcart.replenish.create` (17–22, 31), `code.activate` (all staff roles incl. 23, 50, 51), `code.respond` (clinical roles), `code.record.write` (17–22, 7–11, 14), `code.record.sign` (7–11; 14 with co-sign), `code.record.read` (clinical, 54, 4, 58), `code.debrief.write` (7–11, 22, 54), `crashcart.report.read` (22, 32, 54, 4, 3, 58).

## 13. Non-functional
- Volumes (2000 beds): ~120 carts, ~360 checks/day, 20–60 codes/month; broadcast fan-out ≤ 2 s to ≤ 50 recipients; recorder tap → server ack p95 < 150 ms; offline recorder unlimited entries queued.
- Readiness board refresh via Socket.IO ≤ 3 s; MV refresh every 5 min.
- Tablet recorder: high-contrast, ≥ 56 px buttons, audible/vibration metronome 100–120/min optional, no PHI in push text (deep link), i18n incl. hi/ta/te labels; print A4 code form + drawer labels 50×25 mm.
- Accessibility: hotkeys documented; colour + icon status (not colour alone).

## 14. Acceptance Criteria
1. Given a cart with seal 004512 sealed yesterday, when the ward nurse scans the QR at shift start and confirms seal intact + defib test pass, then a `seal` check is stored with server timestamp, cart status is `ready`, and the ward handover shows crash cart OK.
2. Given no check by due + 60 min, when the job runs, then cart shows `check_overdue`, in-charge gets push, and supervisor at +30 min.
3. Given adrenaline batch expiring in 25 days on cart CC-W3-01, when nightly expiry job runs, then pharmacist worklist lists it at level 30 and cart is amber; when the batch expires and it is a critical item, then cart becomes `not_ready` and supervisor is notified.
4. Given a nurse taps Code Blue from bed W3-12 on IP-004, when activated, then within 2 s push reaches the on-call code team & supervisor, TV/PA banner shows the location, and unacked members receive SMS at 60 s.
5. Given the code recorder taps CPR start, rhythm VF, shock 200 J, adrenaline, then each entry is stored append-only with server time and the "since adrenaline" timer resets; timeline is visible to supervisor live view within 1 s.
6. Given the tablet loses Wi-Fi mid-code, when the recorder continues tapping and connectivity returns, then all entries sync in order with device times and offset correction, none lost or duplicated.
7. Given a code with outcome `died`, when closed, then IP-002 death workflow task and IP-017 mortuary link are created and a mortality review task is opened in NC-015.
8. Given consumables (2 adrenaline, 1 ETT 7.5, defib pads) recorded, when the code closes, then IP-014 receives an urgent replenishment indent for CC-W3-01, ward-stock consumption is posted, and charging follows the flag (default no patient charge).
9. Given the cart was used, when pharmacist issues replacements and both nurse & pharmacist sign the post-use full check with new seal, then cart returns to `ready`, and downtime minutes are recorded.
10. Given the leader has not signed within 24 h, then a reminder push is sent; at 48 h HOD is notified; unsigned records appear in quality report.
11. Given a patient with active DNAR order, when Code Blue is activated for that bed, then a warning is displayed and override is logged with the activator id.
12. Given a duplicate activation for the same bed within 5 min, then no second broadcast is sent and the second activator is appended to the existing event.
13. Given the Utstein report for a month, then time-to-first-shock is computed only for shockable first rhythms and survival-to-discharge is filled from IP-002 outcomes.
14. Given a user without `code.record.sign` (e.g., ward nurse), when calling POST /codes/{id}/sign, then 403 and audit entry.

## 15. Enhancements / Later phases
- RFID/weight-sensor smart carts (auto content verification), defibrillator network telemetry (Zoll/Philips) auto self-test capture (EN-042), video-recorded code review with consent, AI code-record dictation (AI-004), Code Stroke/Code STEMI pathways with door-to-needle timers (IP-020), simulation/mock code scheduling with scoring (NC-027), CPR feedback device integration, hospital-wide emergency codes (fire/red, security/grey) via same broadcast engine (NC-019) (market).

## 16. Open Questions for the Hospital
1. Cart types in use and the exact drawer content lists (adult/paed/neonatal/OT/ER)? Any narcotics kept on carts?
2. Check frequency: every shift, daily, or weekly? Full open-check monthly? Who signs (nurse+nurse or nurse+pharmacist)?
3. Seal type (numbered plastic seals, tamper tape, RFID)? Reuse policy?
4. Code team composition per zone/floor and time band; who is team leader; response-time targets (2/3/5 min)?
5. Broadcast channels: PA system available with API? TV banners? Physical call points/IVR? SMS fallback allowed?
6. Which codes to enable: Blue adult/paed, Pink, Rapid Response/MET, Stroke, Trauma, Mass casualty?
7. Are code consumables charged to the patient or absorbed (cost centre)? Any package rules?
8. Debrief mandatory within 24 h? Who runs the CPR/mortality committee and what indicators are reported to NABH?
9. Defibrillator models and whether self-tests can be exported; BME PM frequency?
10. Utstein registry participation or state reporting required?
