# <MODULE ID> — <Module Name>

| Field           | Value                                                                            |
| --------------- | -------------------------------------------------------------------------------- |
| Domain          | OPD / Trauma-Ortho / IP / Non-Clinical / Enabler / RCM / Patient Engagement / AI |
| Module ID       | e.g. OP-001                                                                      |
| Phase           | 0–13 (see CLAUDE.md §6)                                                          |
| Priority        | P0 / P1 / P2                                                                     |
| Complexity      | Low / Medium / High / Very High                                                  |
| Depends on      | list of module IDs                                                               |
| Feature flag    | `module.<key>.enabled`                                                           |
| Primary roles   | roles that use it daily                                                          |
| Secondary roles | roles that view/approve                                                          |
| Regulatory      | NABH / NABL / ABDM / GST / DPDP / CDSCO / SBTC / AERB / BMW …                    |

## 1. Purpose (2–4 sentences)

## 2. Users & Jobs-to-be-done

- Role → what they must accomplish, how often, on which device.

## 3. Core Workflows (numbered, step-by-step, with system behaviour)

Format each step: **Actor** does X → System validates/does Y → Output Z → Event `domain.event`.
Include happy path + key exceptions (cancel, reject, reversal, offline).

## 4. Data Model (entities & key fields)

Table names in `snake_case`; every business table has `id uuid`, `hospital_id`, `branch_id?`, audit columns.
List entities, important columns, enums, uniqueness constraints, key indexes, partitioning notes.

## 5. Business Rules & Validations

Hard rules, approvals, thresholds, calculations, numbering series, immutability, retention.

## 6. API Surface (REST `/api/v1/...`)

Method, path, purpose, permission key, idempotent?, pagination.

## 7. Domain Events (outbox)

`event.name` → payload summary → consumers.

## 8. Screens (UI)

Screen name → device(s) → key components → keyboard shortcuts → real-time behaviour → empty/error states.

## 9. Integrations

External systems, protocols, retries, fallbacks.

## 10. Reports & Analytics

Operational reports, KPIs, read-model tables/materialised views.

## 11. Notifications

SMS/WhatsApp/Email/Push/TV templates & triggers.

## 12. Permissions (RBAC keys)

`module.entity.action` list mapped to default roles.

## 13. Non-functional

Performance targets, volumes, offline behaviour, printing, accessibility, i18n specifics.

## 14. Acceptance Criteria (Given/When/Then, testable)

At least 8–15 covering happy path, safety, edge cases, permissions, audit.

## 15. Enhancements / Later phases

From the "Missing Features / Enhancements" column and market gaps.

## 16. Open Questions for the Hospital

Things Claude Code must ask before implementing.
