# NC-021 — Vendor Management (Vendor Register & Onboarding, GST/PAN/MSME Compliance, Rate Contracts, Performance Scorecard, Blacklist, Vendor Portal)

| Field | Value |
|---|---|
| Domain | Non-Clinical / ERP |
| Module ID | NC-021 |
| Phase | 4 (register + rate contracts with NC-005) / 9 (scorecards, portal, blacklist workflow) |
| Priority | P1 |
| Complexity | Medium |
| Depends on | NC-005 (indent/RFQ/PO/GRN — vendor selection, comparative statement, rate contracts execution, 3-way match; NC-021 owns the vendor master and rate-contract header), NC-006 (item ↔ vendor mapping, batch quality/expiry rejections), NC-007 (consignment vendors), NC-009 (AP ledger, payments, TDS 194C/194J/194Q, GST ITC/GSTR-2B reconciliation, MSME payment ageing), NC-002/NC-020 (AMC/CMC & service vendors, SLA data), NC-031 (contract repository & renewals — vendor agreements), NC-017/NC-018/NC-019/NC-033/NC-016 (service contractors: laundry, housekeeping, security, canteen, BMW CBWTF), NC-023 (statutory licences of vendors: drug licence, BMW authorisation, PSARA, FSSAI), NC-015 (quality: supplier audits, non-conformance/CAPA), NC-004 (vendor documents), EN-007 (vendor portal accounts, invite, 2FA), EN-038 (approvals: onboarding, blacklist), EN-032/EN-009 (notifications), EN-017 (GSTN/e-invoice/e-way bill APIs via GSP), EN-016 (e-sign of agreements), NC-011, EN-024, EN-041 (group-level shared vendor master) |
| Feature flag | `module.vendor.enabled` (sub: `vendor.portal`, `vendor.scorecard`, `vendor.gstn_verify`, `vendor.audits`) |
| Primary roles | Purchase Officer / Purchase Manager, Vendor Manager, Stores In-charge |
| Secondary roles | Accounts (46; bank/tax details, payments), Pharmacy In-charge (32; drug vendors), Biomedical (48; service vendors), Quality (54; supplier audits), Legal/Compliance (NC-023 owner), Hospital Admin (2; blacklist approvals), Vendor users (63; portal), Auditor (58) |
| Regulatory | GST (GSTIN validation, GSTR-2A/2B ITC matching, e-invoice IRN for B2B, RCM for unregistered vendors, place of supply), Income-tax (PAN mandatory, TDS 194C/194J/194Q/194H, 206AB higher rate for non-filers, Form 26Q; Section 40A(3) cash limits), MSMED Act 2006 §15/§16 (payment within 45 days to registered MSMEs; interest; MSME Form 1 half-yearly; Udyam registration), Companies Act (related-party vendors disclosure), Drugs & Cosmetics Act (drug licence Form 20B/21B for pharma suppliers; CDSCO import licence), Medical Devices Rules 2017 (device manufacturers/importers licence, ISO 13485), BMW Rules 2016 (CBWTF authorisation), FSSAI (food vendors), PSARA (security agency), Legal Metrology (weighing/measuring suppliers), Labour laws for contractors (Contract Labour Act licence, PF/ESI codes), Prevention of Corruption/CVC guidelines (public hospitals: blacklisting procedure & natural justice), NABH (purchase of quality goods — approved vendor list, supplier evaluation) |

## 1. Purpose
NC-021 is the single **vendor master and supplier-relationship** module for all purchase and service partners: onboarding with KYC and statutory documents (GSTIN, PAN, MSME/Udyam, bank, licences), category & item mapping, **rate contracts** (validity, prices, MOQ, lead time, escalation clauses), **performance scorecard** (on-time delivery, quality rejection, price competitiveness, service SLA, invoice accuracy) computed from NC-005/NC-006/NC-002/NC-020 events, **compliance monitoring** (expiring licences, GST filing status, MSME 45-day payments), **watch-list/blacklist** workflow with natural-justice steps, and a **vendor portal** (POs, ASN, invoices upload, payment status, consignment, service calls, tenders/RFQ replies). It feeds NC-005 (approved vendor list), NC-009 (AP master, TDS/GST attributes) and NC-031 (agreements).

## 2. Users & Jobs-to-be-done
- **Purchase officer** (desktop): search/approve vendors by category, maintain rate contracts, invite vendors to RFQ, review scorecards before award, manage vendor documents & expiries.
- **Vendor manager**: onboarding approvals, KYC verification (GSTIN/PAN via API), MSME flags, risk/blacklist proposals, annual evaluations, supplier audits with Quality.
- **Accounts**: verify bank details (penny-drop optional), TDS section & rate, GST registration type, MSME payment ageing, hold payments for blacklisted vendors.
- **Stores/Pharmacy/BME**: log delivery/quality/service issues (auto from GRN rejections/service calls), see vendor ratings while raising indents.
- **Vendor** (portal, phone/desktop): view/acknowledge POs, upload ASN/e-invoice, track GRN & payments, respond to RFQs, update documents, raise disputes, view scorecard, consignment stock/usage (NC-007), service call updates (NC-020).
- **Admin/Auditor**: approved vendor list, blacklist register, related-party disclosures.

## 3. Core Workflows
### 3.1 Vendor onboarding & KYC
1. **Purchase** (or vendor self-registration via portal link) creates vendor: legal name, trade name, type enum(manufacturer/distributor/dealer/importer/service_provider/contractor/consultant/individual), categories (drugs, consumables, implants (NC-007), reagents, equipment, IT, F&B, housekeeping, security, AMC/CMC, professional services…), constitution enum(proprietorship/partnership/LLP/pvt_ltd/public_ltd/trust/individual/govt), addresses (registered/branch with state code → IGST/CGST), contacts (sales/accounts/escalation), GSTIN(s) per state, PAN, TAN?, MSME/Udyam no. & class (micro/small/medium), bank (account, IFSC, cancelled cheque), TDS section default (194C/194J/194Q/194H/none) & lower-deduction certificate (197) with validity, GST registration type enum(regular/composition/unregistered/SEZ/overseas), e-invoice applicability, licences (drug licence 20B/21B, CDSCO device licence, ISO 13485, BMW authorisation, FSSAI, PSARA, contract labour licence, PF/ESI codes) with numbers/expiry & files, related-party declaration, code of conduct/anti-bribery acceptance (e-sign EN-016), credit terms (days), payment mode → **System** validates GSTIN format & state, PAN pattern & linkage (name match via GSTN public API through EN-017 `vendor.gstn_verify`), duplicates (PAN/GSTIN/bank/phone) → **approval** (EN-038: purchase manager + accounts; drug vendors also pharmacy in-charge; medical devices BME) → status `approved` → vendor code (`VEND` series) → portal invite (EN-007) → NC-009 AP ledger created → Event `vendor.approved`.
2. Periodic **re-verification**: yearly KYC refresh, licence expiries (30/60/90 d alerts; expired → `hold` for new POs in that category), GST filing status check (GSTR-1/3B via GSP; non-filer → ITC risk flag; 206AB check), MSME status update.

### 3.2 Item/category mapping & approved vendor list (AVL)
- Map vendor ↔ items/categories with attributes (preferred rank, lead time days, MOQ, pack size, last price, brand); **AVL** per category (NABH); NC-005 RFQ/PO can only pick approved & not-on-hold vendors for the category (override with reason).

### 3.3 Rate contracts
1. **Purchase** creates rate contract (from RFQ award in NC-005 or negotiated): vendor, items with rate, UOM, tax, validity from–to, MOQ, delivery lead time, price-escalation clause, free goods/scheme, penalty for delay, warranty/expiry norms (e.g. min 75 % shelf life at delivery), documents (e-signed) → approvals → active → NC-005 auto-applies rates on PO; expiry alerts (60/30 d) → renewal/re-tender; **rate history** & variance vs market/last purchase; multi-vendor split rules (e.g. 60/40) → Event `vendor.rate_contract.activated|expiring`.

### 3.4 Performance scorecard (`vendor.scorecard`)
1. **System** computes monthly/quarterly score (weights configurable) from events: on-time delivery % (GRN date vs PO promised), fill rate (qty received/ordered), quality rejection % (GRN rejections, batch recalls, near-expiry supplies), price competitiveness (vs comparative/last), invoice accuracy (3-way match mismatches, e-invoice errors), service SLA (NC-002/NC-020 response/resolution, uptime), responsiveness (RFQ reply time, portal ack), compliance (documents current, MSME/GST filing), complaints (NC-015 non-conformances) → grade A/B/C/D → shared with vendor on portal → below threshold → improvement notice → repeated → watch-list → Event `vendor.score.published`.
2. **Supplier audits** (`vendor.audits`): schedule (critical categories: implants, drugs, reagents, food, sterilisation), checklist (NC-015 templates), findings/CAPA, certificate uploads.

### 3.5 Watch-list, hold & blacklist
1. Triggers: score D two consecutive periods, critical quality failure (recall, spurious/NSQ drug alert from CDSCO), fraud/ethics violation, licence expiry, legal case (NC-023), non-response → **Vendor manager** proposes action: `watch_list` (monitor), `hold` (no new PO; existing continue), `blacklist` (all branches; period or permanent) with evidence → **Show-cause notice** to vendor (portal/email; response window e.g. 15 days — natural justice, CVC style for public hospitals) → committee decision (EN-038) → status update; NC-005 blocks POs, NC-009 flags payments (release only for delivered goods per policy), NC-007 consignment recall; group-wide propagation (EN-041) → appeal & revocation flow → Event `vendor.blacklisted|hold|revoked`.

### 3.6 Vendor portal (`vendor.portal`)
- Login (invite, 2FA); dashboard: open POs (acknowledge/decline with reason, promised date), ASN/dispatch details (LR no., e-way bill no., batch/expiry list → speeds GRN), invoice upload (e-invoice JSON/PDF with IRN; auto-match to PO/GRN), payment status & remittance advice, TDS certificate download (Form 16A from NC-009), RFQ invitations & quotes (sealed until opening), rate-contract view, consignment stock/usage statements (NC-007), service calls & PM visits (NC-020/NC-002), documents renewal upload, disputes/queries ticket, scorecard, notices (show-cause), profile changes (bank change requires maker-checker + call-back verification by accounts).

### 3.7 Payments & compliance interplay (NC-009)
- MSME vendors: due date = invoice date + agreed (≤ 45 days); ageing & interest exposure report; MSME Form 1 data; TDS section/rate auto-applied; 206AB flag; GSTR-2B mismatch → vendor notified via portal to amend; RCM for unregistered.

### 3.8 Vendor status machine, risk & category specifics
- Statuses: `draft → pending_approval → approved ↔ hold` (auto by expiry/manual) `→ watch_list → blacklisted (period) → approved (revoked)`; `→ inactive` (no transactions 24 months or exit); re-activation of inactive requires KYC refresh.
- **Risk rating** (auto + manual): single-source critical items, financial health (optional credit-bureau/GST turnover slabs), geographic concentration, compliance gaps, past disputes → low/medium/high → high-risk vendors get quarterly review & alternate-source task to purchase.
- **Category-specific onboarding packs**: Pharma (drug licence 20B/21B, WHO-GMP of manufacturers, cold-chain capability, batch/expiry norms, recall SOP), Implants/devices (CDSCO licence/registration, ISO 13485, UDI, consignment T&C, warranty/recall — NC-007/TR-003), Reagents (NABL-acceptable CoA/traceability, cold chain), Equipment/AMC (service engineer certifications, response SLA, spares availability, uptime guarantee), Services/manpower (Contract Labour licence, PF/ESI codes, wage compliance, PSARA/FSSAI), IT/SaaS (data processing agreement — DPDP, security certifications ISO 27001, uptime SLA), Construction (contractor licences, insurance/WC policy, safety plan).
- **Onboarding by invite**: purchase sends secure link → vendor self-fills wizard on portal → maker-checker inside hospital; document expiries auto-parsed from certificates later (AI-003).
- **Vendor communications log**: emails/WhatsApp/portal messages linked to vendor (purchase-relevant only; DLT templates via EN-009), meeting notes, price negotiations history.
- **Group model (EN-041)**: master owned at group; branch-specific enablement, credit terms & scorecards per branch; blacklist group-wide by default with branch exceptions requiring group approval.
- **Consignment vendors** (NC-007): additional fields (consignment agreement, reconciliation cycle, stock ageing tolerance), scorecard adds reconciliation accuracy & expiry returns.

## 4. Data Model (schema `inventory`/`finance`, prefix `vnd_`)
- **vnd_vendors**: id, hospital_id (or group_id for shared master EN-041), vendor_code, legal_name, trade_name, type enum, constitution enum, categories text[]/uuid[], pan (encrypted+masked), pan_verified_at, tan?, msme_no?, msme_class enum(micro/small/medium/none), msme_valid_until, gst_type enum, einvoice_applicable bool, contacts jsonb, addresses jsonb, banks jsonb [{account (masked), ifsc, name, verified_at, is_primary}], tds_section enum(194C/194J/194Q/194H/194I/none), tds_rate_override numeric?, ldc jsonb {cert_no, rate, valid_until}, credit_days, payment_mode, related_party bool, related_party_details, code_of_conduct_signed_at, risk_rating enum(low/medium/high), status enum(draft/pending_approval/approved/hold/watch_list/blacklisted/inactive), status_reason, blacklisted_until?, portal_enabled bool, portal_user_ids uuid[], ap_ledger_id (NC-009), rating_grade char(1)?, last_score numeric?, kyc_refreshed_at, version. UNIQUE (hospital_id, vendor_code), (hospital_id, pan) (unless individual duplicates allowed w/ reason); INDEX (hospital_id, status), (trade_name gin_trgm), (categories gin).
- **vnd_gstins**: vendor_id, gstin, state_code, legal_name_gstn, status enum(active/cancelled/suspended), verified_at, filing_status jsonb {gstr1_last, gstr3b_last, checked_at}, is_primary. UNIQUE (gstin).
- **vnd_documents**: vendor_id, doc_type enum(drug_licence_20b/21b/cdsco_mfg/cdsco_import/iso13485/iso9001/bmw_auth/fssai/psara/contract_labour/pf_code/esi_code/msme_cert/gst_cert/pan_card/cancelled_cheque/agreement/insurance/other), number, issuer, valid_from, valid_until, file_id (NC-004), verified_by, status enum(valid/expiring/expired/rejected).
- **vnd_item_map**: vendor_id, item_id/category_id, preferred_rank, lead_time_days, moq, pack_size, brand, last_price, last_po_date, active. UNIQUE (vendor_id, item_id).
- **vnd_rate_contracts**: id, hospital_id, branch_id?, contract_no, vendor_id, title, source enum(rfq/negotiated/govt_rate/group), valid_from, valid_to, split_share_pct?, terms jsonb (delivery_days, penalty, min_shelf_life_pct, escalation, warranty), documents jsonb, approvals jsonb, status enum(draft/pending/active/expired/terminated), nc031_contract_id?. **vnd_rate_contract_lines**: contract_id, item_id, uom, rate, tax_pct, hsn, moq, free_qty_scheme, price_history jsonb. INDEX (vendor_id, status), (valid_to).
- **vnd_score_periods**: id, vendor_id, period (month/quarter), metrics jsonb {otd_pct, fill_rate, quality_reject_pct, price_index, invoice_accuracy, service_sla_pct, responsiveness_hrs, compliance_pct, complaints}, weights_version, score numeric(5,2), grade char(1), computed_at, published_at, vendor_ack_at. UNIQUE (vendor_id, period).
- **vnd_events** (raw inputs: vendor_id, at, source enum(grn/po/service_call/rfq/invoice/complaint/audit/recall), ref_id, metric, value) — partitioned monthly.
- **vnd_audits** (vendor_id, planned_at, conducted_at, auditors, checklist jsonb, score, findings jsonb, capa_ref (NC-015), status).
- **vnd_actions**: id, vendor_id, action enum(watch_list/hold/blacklist/revoke/show_cause/improvement_notice), reason_category, evidence jsonb, notice_sent_at, response_due_at, vendor_response jsonb, committee_decision jsonb, effective_from, effective_to?, scope enum(branch/hospital/group), approved_by, status.
- **vnd_portal_tickets** (vendor_id, type enum(query/dispute/payment/document), subject, thread jsonb, status, sla_due).
- **vnd_bank_change_requests** (vendor_id, new_bank jsonb, requested_via, maker, checker, callback_verified_by, status).
- **analytics.vendor_kpis** (vendor/category/month: spend, po_count, otd, rejections, score, payment_days_avg, msme_overdue_amt).
- RLS; group-shared vendors via `group_id` policy; PAN/bank encrypted (pgcrypto); retention 8 years post last transaction.

## 5. Business Rules & Validations
- Approved status requires: PAN (mandatory except govt/foreign with reason), GSTIN or declared unregistered (RCM), bank verified (document + optional penny-drop), category-mandatory licences valid (drug vendors → drug licence; device → CDSCO/ISO 13485; BMW → CBWTF authorisation; food → FSSAI; security → PSARA), code-of-conduct signed, no duplicate PAN/GSTIN (dup → link as branch of same vendor).
- Licence expired → automatic `hold` for that category (POs blocked) until renewed; alerts at 90/60/30/7 days.
- Rate-contract rates auto-apply on PO within validity; PO above contract rate needs approval; expired contract cannot be used; overlapping contracts for same item/vendor blocked.
- Scorecard: only published scores visible to vendor; weights versioned; grade thresholds (A ≥ 85, B ≥ 70, C ≥ 55, else D) configurable; disputes on metrics via portal ticket resolve before publication lock.
- Blacklist requires show-cause notice + response window elapsed (or waived for fraud with admin approval) + committee approval; scope group-wide by default; NC-005 hard-block; NC-009 payment hold except undisputed dues per policy; revocation needs same authority.
- Bank change: maker-checker + call-back verification to registered contact; new bank effective only after checker; alert accounts of any change (fraud control).
- TDS: section/rate from master; 206AB/206CCA higher rate flag when PAN non-filer (annual check); LDC applied within validity & threshold.
- MSME: due date ≤ 45 days (or agreed shorter); overdue → interest exposure computed (3× bank rate) shown to finance; MSME class from Udyam.
- Related-party vendors flagged on POs; audit trail on all master changes (before/after).

## 6. API Surface (`/api/v1/vendors`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET/POST/PATCH | / ; GET /{id} ; POST /{id}/(submit|approve|reject|hold|reactivate) ; POST /import | vendor master | vendor.master.manage / .read / vendor.master.approve | Y | cursor |
| POST | /{id}/verify/(gstin|pan|bank) | KYC checks (EN-017 GSP/penny-drop) | vendor.kyc.verify | Y | – |
| GET/POST/PATCH | /{id}/gstins ; /{id}/documents ; /{id}/contacts ; /{id}/banks (change → request) | sub-entities | vendor.master.manage | Y | cursor |
| POST | /bank-change-requests/{id}/(check|verify-callback|approve) | maker-checker | vendor.bank.approve (accounts) | Y | – |
| GET/PUT | /{id}/items ; GET /avl?category=&item= | mapping / AVL | vendor.item.manage / .read | Y | cursor |
| GET/POST/PATCH | /rate-contracts ; POST /rate-contracts/{id}/(submit|approve|terminate|renew) ; GET /rate-contracts/lookup?item=&date= | rate contracts | vendor.contract.manage / .approve / .read | Y | cursor |
| GET | /{id}/scorecard?period= ; POST /scores/compute?period= ; POST /scores/{id}/publish | scorecard | vendor.score.read / .manage | Y | – |
| POST/GET | /audits ; POST /audits/{id}/close | supplier audits | vendor.audit.manage | Y | cursor |
| POST/GET | /actions ; POST /actions/{id}/(notice|record-response|decide|revoke) | watch/hold/blacklist | vendor.action.propose / .approve | Y | cursor |
| GET | /blacklist (public within group) | list | vendor.master.read | – | cursor |
| Portal | GET /portal/me ; GET /portal/pos ; POST /portal/pos/{id}/(ack|decline) ; POST /portal/asn ; POST /portal/invoices ; GET /portal/payments ; GET/POST /portal/rfqs/{id}/quote ; GET /portal/scorecard ; POST /portal/tickets ; POST /portal/documents ; POST /portal/profile/bank-change ; GET /portal/consignment ; GET/POST /portal/service-calls | vendor self-service | vendor.portal.* (role 63, scoped vendor_id) | Y | cursor |
| GET | /reports/(spend|otd|quality|score-trend|licence-expiry|msme-ageing|blacklist-register|related-party|contract-expiry) | analytics | vendor.report.read | – | – |

## 7. Domain Events (outbox)
- `vendor.created|submitted|approved|rejected|updated|hold|reactivated|inactive` {vendor_id, status, categories} → NC-005 (AVL cache), NC-009 (AP ledger create/update, TDS attrs), NC-007, EN-007 (portal user), NC-011.
- `vendor.document.expiring|expired` {vendor_id, doc_type, days} → EN-037 purchase, auto-hold logic, NC-023.
- `vendor.rate_contract.activated|expiring|expired|terminated` {contract_id, items} → NC-005 pricing cache, NC-031 mirror.
- `vendor.score.computed|published` {vendor_id, period, grade} → portal, NC-005 (award weighting), NC-011.
- `vendor.action.notice_sent|blacklisted|hold|revoked` {vendor_id, scope, until} → NC-005 block, NC-009 payment hold, NC-007 recall, EN-041 group broadcast, NC-023 legal log.
- `vendor.bank.changed` → NC-009 (payment master), accounts alert.
- `vendor.portal.po_acked|asn_submitted|invoice_uploaded|quote_submitted|ticket_raised` → NC-005/NC-009 queues.
- Consumes: `purchase.po.issued|grn.accepted|grn.rejected|rfq.sent|rfq.awarded|three_way.mismatch` (NC-005), `inventory.batch.recalled|near_expiry_received` (NC-006), `asset.service_call.closed` (NC-002), `bme.breakdown.closed` (NC-020), `finance.payment.made|invoice.posted` (NC-009), `quality.nc.raised` (NC-015), `licence.status.changed` (NC-023), `contract.expiring` (NC-031), `cdsco.nsq_alert` (EN-017 feed, if configured).

## 8. Screens (UI)
- **Vendor Directory** (desktop): search (trigram name/GSTIN/PAN/category), filters (status, grade, category, MSME, expiring docs), cards/table with grade badge & hold/blacklist ribbon; `N` new vendor, `/` search.
- **Vendor 360** (desktop): tabs Profile/KYC & Docs/GSTINs & Tax/Banks/Items & Rates/Contracts/Scorecard/Actions/Transactions (POs, GRNs, invoices, payments from NC-005/NC-009)/Portal activity/Audit trail; verification status chips; document expiry timeline.
- **Onboarding Wizard** (desktop; also portal self-registration on phone): steps Basic → Tax → Bank → Documents → Categories → Declarations (e-sign) → Review; inline GSTIN/PAN validation.
- **Rate Contract Editor**: header + line grid (paste from Excel), tax/HSN lookup, validity, split shares, approvals, compare with last contract; `Ctrl+S` save.
- **Scorecard** (desktop; portal read-only): radar chart of metrics, trend, drill to underlying GRNs/calls; publish button; dispute thread.
- **Actions/Blacklist Console**: proposals list, evidence, notice generator (template EN-039), response tracker, committee decision, register print.
- **Vendor Portal** (responsive): dashboard (open POs, invoices status, payments due, notices), PO ack, ASN form (batches/expiry grid; scan invoice), invoice upload with IRN check, RFQ quote form (sealed), documents, tickets, scorecard; i18n en/hi.
- **Approvals Inbox** (EN-038 shared).
- Empty/error states; WCAG 2.2 AA; i18n.

## 9. Integrations
- EN-017 GSP APIs: GSTIN search/status (public), GSTR-2A/2B pull for NC-009, e-invoice IRN validation, e-way bill lookup; Income-tax PAN verification & 206AB compliance check (TRACES/Reporting portal via GSP), Udyam verification (portal — manual with URL); bank penny-drop (Razorpay/Cashfree verification API via EN-010); EN-016 e-sign agreements; EN-007 portal auth; EN-032/EN-009 notifications; NC-004 documents; NC-005/NC-006/NC-007/NC-009/NC-002/NC-020/NC-031/NC-015/NC-023 internal events; EN-041 group vendor sharing; EN-036 legacy vendor import (Tally/Excel); CDSCO NSQ/spurious drug alert feed (scrape/manual).

## 10. Reports & Analytics
- Approved vendor list by category (NABH), spend by vendor/category/branch (Pareto), OTD & fill-rate trends, quality rejection by vendor/item, price index vs market/last, invoice accuracy & 3-way mismatch rate, service SLA (AMC/CMC vendors), scorecard grades distribution & trend, licence/document expiry calendar, MSME payment ageing & interest exposure, TDS section summary, blacklist/hold register with reasons, related-party vendor spend, rate contract coverage % of spend & expiring contracts, vendor concentration risk (single-source critical items), portal adoption (ack rate, ASN usage). Read model `analytics.vendor_kpis`.

## 11. Notifications
- Purchase/vendor manager: onboarding pending, document expiring/expired (auto-hold), contract expiring 60/30 d, score D, show-cause response received, portal tickets; Accounts: bank change requests, MSME dues approaching 45 d, 206AB flags, GST non-filer; Vendor (email/WhatsApp/portal): approval, PO issued, RFQ invitation, GRN/rejection, payment advice, TDS certificate, document expiry reminders, notices, scorecard published; Admin: blacklist decisions; Quality: audit due.

## 12. Permissions (RBAC keys)
`vendor.master.read|manage|approve`, `vendor.kyc.verify`, `vendor.bank.approve` (accounts, SoD from maker), `vendor.item.manage|read`, `vendor.contract.manage|approve|read`, `vendor.score.read|manage`, `vendor.audit.manage`, `vendor.action.propose|approve` (committee/admin), `vendor.report.read`, `vendor.export`, `vendor.configure`; portal role 63: `vendor.portal.read`, `vendor.portal.po.ack`, `vendor.portal.asn.create`, `vendor.portal.invoice.upload`, `vendor.portal.quote.submit`, `vendor.portal.ticket.create`, `vendor.portal.profile.update`. ABAC: portal scoped to own vendor_id; branch scope for purchase; SoD: onboarding creator ≠ approver; blacklist proposer ≠ approver.

## 13. Non-functional
- Volumes: 3–5k vendors, 200 rate contracts, 50k score events/month, portal 500 active vendors; directory search p95 < 150 ms; scorecard compute for all vendors nightly < 5 min; portal PO list p95 < 200 ms.
- Security: PAN/bank encrypted, masked in UI (reveal audited), portal 2FA, rate limits, file scanning; audit of master changes; RLS + group policy.
- Offline: not required (portal online); exports CSV/PDF; printing notices, AVL, blacklist register.
- i18n (portal en/hi), WCAG 2.2 AA.

## 14. Acceptance Criteria
1. Given a new drug distributor without a valid Form 20B/21B licence uploaded, when submitted for approval, then approval is blocked with the missing-licence reason.
2. Given a GSTIN entered, then the system validates format/state and (when GSP configured) fetches legal name & status; a cancelled GSTIN prevents approval.
3. Given a vendor's BMW authorisation expires today, then the vendor moves to `hold` for BMW category, NC-005 blocks new POs for that category, and purchase is notified.
4. Given an active rate contract for item X at ₹100 valid to 31 Mar, when a PO is raised 15 Mar, then rate auto-fills ₹100; a PO at ₹110 requires approval; on 1 Apr the contract cannot be used.
5. Given Q1 metrics OTD 70 %, rejection 6 %, invoice mismatches 10 %, then the score computes with configured weights and grade C; publishing makes it visible on the vendor portal.
6. Given a blacklist proposal, then a show-cause notice must be sent and response window elapsed before committee decision; upon blacklist, NC-005 blocks POs group-wide and NC-009 flags payments; audit records all steps.
7. Given a vendor requests a bank change on the portal, then payments continue to the old account until accounts checker verifies via call-back and approves; both events are notified to accounts.
8. Given an MSME vendor invoice dated 1 Jun unpaid on 16 Jul, then the MSME ageing report shows overdue with interest exposure and finance is alerted at day 40.
9. Given duplicate PAN on new vendor creation, then the system offers to link as a branch/GSTIN of the existing vendor instead of creating a duplicate.
10. Given a vendor user logs into the portal, then they see only their own POs/invoices/payments (RLS by vendor_id) and can acknowledge a PO with promised date, which appears in NC-005.
11. Given a user with `vendor.master.manage` but not `.approve`, then approve action returns 403.
12. Given a related-party flagged vendor, then POs display the flag and the related-party spend report includes them.
13. Given a vendor with no transactions for 24 months, then it moves to `inactive`; a new PO attempt prompts KYC refresh before re-activation.
14. Given a single-source vendor for a critical implant category, then risk rating = high, a quarterly review task and an alternate-source task are created for purchase.
15. Given a vendor self-registers via invite and uploads a drug licence expiring in 20 days, then the record shows `expiring` at onboarding and approval warns; on expiry the category auto-holds.
16. Given a consignment vendor with 3 reconciliation mismatches in the quarter, then the scorecard's reconciliation accuracy metric reduces the grade and NC-007 shows the flag.
17. Given a group with two branches, when Branch B requests an exception to a group blacklist, then group approval is required and the exception is time-bound and audited.

### 14.1 Test data & golden path (for e2e)
- Seed 30 vendors across categories (2 MSME, 1 related-party, 1 with expiring BMW authorisation), 5 rate contracts, portal users for 3 vendors; run: onboarding → approval → PO with contract rate → GRN rejection → scorecard compute → show-cause → blacklist → NC-005 block → revoke.

## 15. Enhancements / Later phases
- From VIMS sheet: vendor register, rate contract, performance score, blacklist (Phase 4/9 core above).
- (market) Vendor self-registration marketplace & e-tendering with sealed bids and auction (reverse auction), GeM/government e-procurement integration for public hospitals, dynamic discounting/early-payment programme, supplier risk intelligence (news/legal feeds), sustainability/ESG scoring, AI invoice-to-PO matching (AI-003), WhatsApp bot for vendors (PO ack, payment status), consignment vendor analytics (NC-007), group-level rate benchmarking across branches (EN-041), vendor-managed inventory dashboards.

## 16. Open Questions for the Hospital
1. Existing vendor list size/format (Tally/Excel), current codes; group-shared master across branches?
2. Onboarding approval matrix (who approves per category/value), mandatory documents per category, KYC refresh cycle?
3. Scorecard metrics & weights, grading thresholds, whether scores are shared with vendors?
4. Blacklisting procedure (committee, notice periods) — public/trust hospital CVC-style or private policy?
5. Bank verification method (penny-drop provider) and bank-change controls?
6. Rate-contract practice (annual tenders? split awards?), min shelf-life norms, penalties?
7. Vendor portal scope at go-live (PO ack/ASN/invoice) and languages?

