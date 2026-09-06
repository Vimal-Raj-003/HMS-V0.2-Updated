# 06 — UI/UX & Design System

> Source of truth for `packages/ui` (tokens, primitives, clinical widgets), `apps/web` shell and `apps/tv-kiosk`.
> Nothing ships without: tokens (no hard-coded hex), keyboard path, empty/loading/error states, i18n keys, WCAG 2.2 AA.
> Governance: any new token or clinical component needs an entry here + a Storybook story + an a11y test.

---

## 1. Design principles

### 1.1 Heuristics (Nielsen, applied to hospital work)

| #   | Heuristic                   | What it means here                                                                                                                                                                                            |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Visibility of system status | Every async action shows state: saving/saved chip, "queued offline (3)", queue position, TAT countdown, socket freshness chip. Never a silent spinner without a label.                                        |
| 2   | Match the real world        | Use ward vocabulary: _token_, _UHID_, _IP no._, _accession_, _cross-match_, _pre-auth_, _indent_, _DAMA_. Never DB words (`encounter_id`, `status_enum`) in the UI.                                           |
| 3   | User control & freedom      | Undo window for non-clinical actions (10 s toast undo). Clinical/financial actions are not undone — they are **reversed with a reason** (amendment, credit note, cancellation) leaving both versions visible. |
| 4   | Consistency & standards     | One pattern per job across 177 modules: same search combobox, same date picker, same money input, same confirm dialog, same audit drawer.                                                                     |
| 5   | Error prevention            | Hard-stops before harm (allergy, wrong-patient scan, duplicate STAT test); required-field gating at the _step_, not at submit; dose calculators instead of free typing.                                       |
| 6   | Recognition over recall     | Show the last 5 values, favourites, "repeat last Rx", the drug's stock and price inline, the previous result beside the new one. Never make a clinician remember a code.                                      |
| 7   | Flexibility & efficiency    | Keyboard-first for OPD/billing/lab/pharmacy; templates and order sets; ⌘K palette; barcode as the primary "navigation device" at the bedside.                                                                 |
| 8   | Aesthetic & minimalist      | Density is a feature. Remove decoration, not information. One primary action per screen region.                                                                                                               |
| 9   | Help users recover          | Errors say _what happened, what it means clinically/financially, what to do next, and the reference id_ for the helpdesk.                                                                                     |
| 10  | Help & documentation        | `?` opens the screen's shortcut sheet + module help; every hard-stop explains the rule and links to the policy.                                                                                               |

### 1.2 Clinical-safety principles (non-negotiable, per `04-security-compliance.md` §7)

1. **Two identifiers, always.** Any screen that acts on a patient shows UHID + name + age/sex. Barcode verification wherever the action is physical (medication, specimen, blood, imaging, transfusion).
2. **Hard-stop vs soft-stop are visually distinct and never interchangeable.**
   - **Hard stop** = full-screen-blocking `AlertDialog`, danger border, no close button, no ESC, no click-outside. Continue requires a typed/selected **reason** and (where policy says) a **second person**. Used for: documented allergy match, contraindicated interaction, wrong-patient scan, >200 % dose ceiling, missing paediatric weight, narcotic without dual auth, blood without two-person verify.
   - **Soft stop** = inline `Banner` or non-blocking dialog with "Acknowledge" and a visible acknowledger name. Used for: major (non-contraindicated) interaction, duplicate test, Beers-list flag, delta check.
   - Never style a soft stop like a hard stop; alert fatigue is a safety defect (tracked as a metric — EN-037).
3. **Colour is never the only signal.** Every status carries **icon + text label + colour**, and shape where it is a chip (ESI numerals, ▲/▼ result flags, hatched bed tiles). Verified against deuteranopia/protanopia/tritanopia simulations in CI.
4. **No destructive action without confirmation + reason.** Cancellation, amendment, discount override, refund, void, merge, discharge-against-advice: typed confirmation of a distinguishing value (bill no. / UHID last 4) for high-impact actions, mandatory reason, immediate audit entry visible in the row's history drawer.
5. **Never lose clinician input.** Autosave drafts every 5 s (server + IndexedDB), dirty-state guard on navigation, offline queue with visible pending count. A failed write raises a human-visible queue item — never a swallowed exception.
6. **Immutability is visible.** Finalised documents render with a "Final v2 · signed by … · 14:22" seal; amendments show "Amended" and a diff link. Nothing clinical is ever "edited in place" in the UI language.
7. **Escalation is in the UI, not only in a notification.** Unacknowledged critical results and NEWS2 ≥ 7 surface as a blocking inbox item on the next action, plus timer.
8. **Privacy by default in public view.** TV/board/kiosk surfaces default to token or masked labels (EN-018 §5); full names are an audited Hospital-Admin override.
9. **Degraded mode is designed, not accidental.** Offline, read-only DB, printer down, analyzer down, CDSS down each have a defined banner, a defined fallback path, and a defined catch-up flow.
10. **Time is unambiguous.** Clinical timestamps show `dd-MM HH:mm` in hospital time zone with relative age ("+18 m") for anything in an alert or task; never bare relative time on a clinical record.

---

## 2. Visual language & the two themes

Two themes, one token set. Theme is chosen by **surface**, not by user whim:

| Surface                                                                           | Theme                        | Why                                                                                                              |
| --------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Clinical & data-entry (OPD, nursing, lab, pharmacy, billing, admin forms)         | **Light Clinical** (default) | Long-duration reading under bright ward lighting; printed-form mental model; lowest eye strain for dense tables. |
| Dashboards, command centres, analytics, TV boards, kiosk idle, IT/integration ops | **Dark Layered Stack**       | Glanceable at distance, high contrast, less light pollution in wards at night, matches the VIMS brand.           |
| Any surface, user preference                                                      | Either                       | Users may switch (`⌘K → theme`), except TV boards (board-level `theme_key`, EN-018) and printing (always light). |
| Bright-ward / outdoor (ER ambulance bay, day-light wards)                         | **High-contrast Light**      | Forced ≥ 7:1 body text, thicker borders, no subtle greys.                                                        |

### 2.1 Light Clinical

Paper-like: `--bg-canvas` near-white, cards on hairline borders (`1px` neutral-200) with **shadow only for floating layers** (menus, dialogs, popovers). Data tables are borderless with zebra-free row separators. Accent used sparingly — primary is for _the_ action, not decoration. Status is carried by chips, not by row backgrounds (except a single 3 px left rule for critical rows).

### 2.2 Dark Layered Stack

The brand aesthetic: a stack of visibly separated planes rather than shadow depth.

- **Layer 0** page canvas `#0D1219` · **Layer 1** section `#111820` · **Layer 2** card `#172029` · **Layer 3** raised/hover/selected `#1E2A35`, each separated by a `1px rgba(255,255,255,.06)` hairline and `0` shadow.
- **Display headings in monospace** (JetBrains Mono, `500`/`600`, `letter-spacing: -0.01em`, uppercase for section eyebrows with `+0.08em`) — KPI numerals, board titles, token digits, timers, IDs.
- Body/labels remain Inter. Numerals everywhere use `font-variant-numeric: tabular-nums slashed-zero`.
- Accent glow is allowed **only** on live/realtime elements (pulsing dot on "now serving", socket-connected chip) and never on static content.
- Charts on dark use the dark categorical ramp (§3.7) and a `#1E2A35` plot background with `rgba(255,255,255,.08)` gridlines.

---

## 3. Design tokens

CSS custom properties live in `packages/ui/src/tokens/*.css`, exported to Tailwind v4 `@theme` and to a JS object for React Native (Phase 13) and print templates. **Rule: components consume semantic tokens (`--color-danger-fg`), never raw scale tokens.**

### 3.1 Neutral scale (`--n-*`)

`0 #FFFFFF` · `25 #FAFBFC` · `50 #F4F6F8` · `100 #E8ECF1` · `200 #D5DBE3` · `300 #B3BDCA` · `400 #8A97A8` · `500 #67748A` · `600 #4E5A6E` · `700 #3A4553` · `800 #262F3A` · `900 #171E27` · `950 #0D1219`

### 3.2 Brand primary — "VIMS Teal" (`--p-*`)

`50 #E6F7F8` · `100 #C2ECEF` · `200 #93DDE3` · `300 #5FC9D2` · `400 #33B2BF` · `500 #1596A5` · `600 #0E7A88` · `700 #0B606C` · `800 #094A54` · `900 #073942` · `950 #04252B`

- Light theme: action fill `--p-600` with `#FFFFFF` text → **5.08:1** (AA normal text ✓). Link/label text `--p-700` → 7.24:1.
- Dark theme: action fill `--p-400` with `--p-950` text → **6.33:1**; link text `--p-300` on `--n-950` → **9.76:1**. (`--p-500` on `--p-950` is 4.55:1 — usable for text but **not** for a fill that also carries an icon; use `--p-400` for fills.)

### 3.3 Semantic scales

| Role                | 50        | 100       | 300       | 500       | 600       | 700       | 800       | Text-on-white token | Ratio    |
| ------------------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- | ------------------- | -------- |
| success             | `#ECFDF3` | `#D1FADF` | `#6CE9A6` | `#12B76A` | `#039855` | `#027A48` | `#05603A` | `--su-700`          | 5.44:1 ✓ |
| warning             | `#FFFAEB` | `#FEF0C7` | `#FEC84B` | `#F79009` | `#DC6803` | `#B54708` | `#93370D` | `--wa-700`          | 5.46:1 ✓ |
| danger              | `#FEF3F2` | `#FEE4E2` | `#FDA29B` | `#F04438` | `#D92D20` | `#B42318` | `#912018` | `--da-700`          | 6.68:1 ✓ |
| info                | `#EFF8FF` | `#D1E9FF` | `#84CAFF` | `#2E90FA` | `#1570EF` | `#175CD3` | `#1849A9` | `--in-700`          | 6.09:1 ✓ |
| violet (accent/2nd) | `#F4F3FF` | `#EBE9FE` | `#BDB4FE` | `#7A5AF8` | `#6938EF` | `#5925DC` | `#4A1FB8` | `--vi-700`          | 7.71:1 ✓ |

White text on `--da-600 #D92D20` = 4.89:1 ✓; on `--su-700` = 5.44:1 ✓; on `--wa-700` = 5.46:1 ✓. **Amber fills always take dark text** (`--wa-900` on `--wa-300` = 6.21:1 ✓); white on any amber below `--wa-700` fails and is blocked by the contrast unit test.

### 3.4 Semantic aliases (light → dark)

| Alias              | Light                | Dark                    |
| ------------------ | -------------------- | ----------------------- |
| `--bg-canvas`      | `--n-25`             | `--n-950`               |
| `--bg-layer-1`     | `--n-0`              | `#111820`               |
| `--bg-layer-2`     | `--n-0`              | `#172029`               |
| `--bg-layer-3`     | `--n-50`             | `#1E2A35`               |
| `--bg-sunken`      | `--n-100`            | `#0A0F15`               |
| `--fg-default`     | `--n-900` (16.78:1)  | `#E7ECF2` (15.72:1)     |
| `--fg-muted`       | `--n-600` (6.97:1)   | `#9FADBD` (8.26:1)      |
| `--fg-subtle`      | `--n-500` (4.73:1)   | `#7E8C9C` (5.51:1)      |
| `--fg-on-accent`   | `--n-0`              | `--p-950`               |
| `--border-default` | `--n-200`            | `rgba(255,255,255,.08)` |
| `--border-strong`  | `--n-300`            | `rgba(255,255,255,.16)` |
| `--border-focus`   | `--p-600`            | `--p-300`               |
| `--overlay-scrim`  | `rgba(23,30,39,.55)` | `rgba(0,0,0,.68)`       |

**All body text ≥ 4.5:1, all ≥18.66px/bold text ≥ 3:1, all UI component boundaries & focus rings ≥ 3:1 (WCAG 2.2 AA: 1.4.3, 1.4.11, 2.4.11 Focus Not Obscured, 2.4.13 Focus Appearance).** High-contrast mode raises every `--fg-*` to ≥ 7:1 and `--border-default` to `--n-400`.

### 3.5 Clinical status tokens

**Triage — ESI (OP-006 / TR-001).** Chip = numeral + label + colour + icon; the numeral is the primary signal.
`--esi-1` 1 Resuscitation `#B42318`/white/pulse-off · `--esi-2` 2 Emergent `#B54708`/white/alert-triangle · `--esi-3` 3 Urgent `#FEC84B`/`#7A2E0E`/clock-alert · `--esi-4` 4 Less urgent `#039855`/white/check · `--esi-5` 5 Non-urgent `#4E5A6E`/white/minus.

**START / mass casualty (TR-001):** `--triage-immediate #B42318` · `--triage-delayed #FEC84B`/dark text · `--triage-minor #039855` · `--triage-expectant #171E27` (white text, diagonal hatch) · `--triage-deceased #0D1219` (white text, cross-hatch).

**Bed states (IP-001 / IP-025).** Each tile carries an icon + 2-letter code; colour-blind pattern in brackets.
`--bed-vacant-clean #039855` (VC, solid) · `--bed-occupied #1570EF` (OC, solid) · `--bed-vacant-dirty #DC6803` (VD, 45° hatch) · `--bed-cleaning #FEC84B`+dark (CL, dots) · `--bed-blocked #4E5A6E` (BL, cross-hatch) · `--bed-reserved #5FC9D2`+dark (RS, dashed border) · `--bed-discharge-pending #F79009`+dark (DP, half-fill) · `--bed-isolation #6938EF` (IS, ring border, biohazard icon) · `--bed-oos #B42318` (XX, dense hatch).

**Result flags (OP-004 / OP-008).** Glyph is mandatory.
`--flag-normal` `--n-500` "—" · `--flag-high --wa-700` "▲ H" · `--flag-low --in-700` "▼ L" · `--flag-critical-high --da-700` filled "▲▲ HH" + left rule · `--flag-critical-low --vi-700` filled "▼▼ LL" + left rule · `--flag-abnormal --wa-600` "◆ A" · `--flag-delta --vi-600` "Δ" · `--flag-corrected --n-600` "✎ C" strikethrough on prior · `--flag-pending --n-400` "…".

**Queue states (EN-006 / EN-018):** `--q-waiting --n-500` · `--q-called --in-600` + 1 Hz pulse (≤ 3 Hz, photosensitivity-safe) · `--q-in-progress --su-600` · `--q-on-hold --wa-600` · `--q-skipped --da-600` · `--q-completed --n-400` · `--q-no-show --n-700` strikethrough.

**Other clinical:** `--ews-low --su-700` / `--ews-low-medium --wa-600` / `--ews-medium --wa-800` / `--ews-high --da-700` (NEWS2 bands, IP-003) · `--allergy --da-700` · `--mlc --vi-700` · `--isolation --vi-600` · `--dnr --n-800` · `--npo --wa-700` · `--fall-risk --wa-600` · `--infection --su-800`.

### 3.6 Typography

| Token            | Family stack                                                                                                                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--font-ui`      | `"Inter var", Inter, system-ui, -apple-system, "Segoe UI", sans-serif`                                                                                                                                                                                               |
| `--font-display` | `"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace`                                                                                                                                                                                                         |
| `--font-mono`    | same as display (code, IDs, HL7, accession numbers)                                                                                                                                                                                                                  |
| `--font-indic`   | `"Noto Sans Devanagari", "Noto Sans Tamil", "Noto Sans Telugu", "Noto Sans Malayalam", "Noto Sans Kannada", "Noto Sans Bengali", "Noto Sans Gujarati", "Noto Sans Gurmukhi", "Noto Sans Oriya"` — appended to `--font-ui` so mixed English/Indic lines share metrics |
| `--font-arabic`  | `"Noto Sans Arabic", "Noto Kufi Arabic"` (RTL builds)                                                                                                                                                                                                                |

Fonts are **self-hosted, subset per locale, `font-display: swap`**, woff2 only; Indic subsets load lazily on locale switch (never ship Tamil to an `en-IN` session). Numerals: `font-variant-numeric: tabular-nums slashed-zero` on every table cell, money field, vitals value, token and ID.

Scale `--fs-*` (px / line-height / use): `3xs` 10/14 dense meta & print footers · `2xs` 11/16 chips & axis labels · `xs` 12/16 dense table body & helper text · `sm` 13/18 default table body · **`md` 14/20 body default** (inputs, nav, buttons) · `lg` 16/24 tablet inputs & dialog body · `xl` 18/26 section headings & banner patient name · `2xl` 20/28 page title · `3xl` 24/32 card value · `4xl` 30/38 KPI value · `5xl` 36/44 KPI hero & kiosk heading · `6xl` 48/56 kiosk primary action · `display-1` 64/68 dark dashboard hero (mono) · `display-2` 88/92 command-centre hero (mono) · `tv-body` 32/42 (min 28 @1080p, EN-018) · `tv-token` 180/1.0 TV token digits @1080p (×2 = 360 @4K, mono 600).

Weights: 400 body · 500 labels/table headers · 600 headings & mono display · 700 only for numerals in alerts. Never 300 (fails legibility on cheap ward monitors). Max measure 72ch for prose, 100ch for clinical notes.

### 3.7 Spacing, radii, elevation, motion, z-index

- **Spacing** (`--sp-*`, 4 px base): `0.5=2 · 1=4 · 1.5=6 · 2=8 · 3=12 · 4=16 · 5=20 · 6=24 · 8=32 · 10=40 · 12=48 · 16=64 · 20=80 · 24=96`. Table row padding `--sp-2` dense / `--sp-3` default / `--sp-4` touch.
- **Radii**: `--r-xs 2 · --r-sm 4 · --r-md 6 (default) · --r-lg 8 (cards) · --r-xl 12 (dialogs, tiles) · --r-2xl 16 (TV widgets) · --r-full 9999`.
- **Elevation (light only)**: `--e-1 0 1px 2px rgb(16 24 40/.06), 0 1px 3px rgb(16 24 40/.10)` · `--e-2 0 2px 4px -2px rgb(16 24 40/.06), 0 4px 8px -2px rgb(16 24 40/.10)` · `--e-3 0 4px 6px -2px rgb(16 24 40/.03), 0 12px 16px -4px rgb(16 24 40/.08)` · `--e-4` dialogs · `--e-5` critical alert. **Dark theme uses layers + hairlines, `--e-*` collapse to `none` except dialogs.**
- **Motion**: `--dur-instant 0 · --dur-fast 120ms · --dur-base 180ms · --dur-slow 240ms · --dur-deliberate 320ms · --dur-tv 400ms` (EN-018 cap). Easing `--ease-standard cubic-bezier(.2,0,0,1)`, `--ease-decel cubic-bezier(0,0,0,1)`, `--ease-accel cubic-bezier(.3,0,1,1)`. `prefers-reduced-motion: reduce` → all durations `1ms`, transforms disabled, only opacity cross-fades; pulsing "live" dots become a static ring.
- **Z-index**: `base 0 · sticky 100 · appbar 150 · banner 200 · dropdown 300 · rail-overlay 400 · scrim 900 · dialog 1000 · popover 1100 · toast 1200 · critical-alert 1300 · emergency-code-overlay 1400` (EN-018 code banner outranks everything, cannot be dismissed at the device).
- **Chart ramps** (see the `dataviz` skill before writing any chart; enforced by `scripts/check-chart-palette.mjs`, which runs in CI):
  - light & high-contrast categorical: `#1596A5 #5925DC #B54708 #027A48 #175CD3 #B42318 #DD2590 #93370D`
  - dark categorical: `#1596A5 #B98246 #1570EF #DC6803 #039855 #DD2590 #7A5AF8 #F04438`
  - Sequential (occupancy/heat) `--p-50 → --p-900`; diverging (variance, delta) `--in-700 ↔ --n-200 ↔ --da-700`.

  **These replace the ramps this section carried until 2026-09-02, which did not pass the validator.** The
  old light ramp put `#B42318` next to `#027A48` — red beside green, ΔE 6.2 under deuteranopia — and read two
  steps as grey. The old dark ramp failed four of five checks; the worst pair, `#D6BBFB` against `#B3BDCA`,
  was ΔE 9.0 under **normal** vision, so full-colour readers could not separate it either. Every step above is
  one the scales in §3.1–3.3 already own; only the step and the order changed. Two rules the numbers do not
  express and the check enforces anyway: **the VIMS teal always leads**, and **red is never adjacent to green**.

  The dark ramp sits in the CVD 6–8 "floor" band, which is permitted _only_ alongside secondary encoding — so
  on dark surfaces a legend is mandatory above one series, up to four series are also direct-labelled, and a
  texture fill is available. Colour is never the only carrier of identity.

---

## 4. Layout system

### 4.1 App shell (`apps/web`)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ TOP BAR  56px   [logo] Hospital ▸ Branch ▾ │ ⌘K search │ 🔔12 │ ⚙ │ ◐ │ user ▾ │
├────────┬─────────────────────────────────────────────────┬───────────────────┤
│ LEFT   │  PATIENT BANNER 72px (sticky, 48px when scrolled)│  RIGHT CONTEXT    │
│ NAV    ├─────────────────────────────────────────────────┤  RAIL 320px       │
│ 240px  │                                                 │  (collapsible)    │
│ (56px  │              WORK AREA  min 640px               │  alerts · tasks · │
│  rail) │                                                 │  vitals · meds ·  │
│        │                                                 │  audit · help     │
└────────┴─────────────────────────────────────────────────┴───────────────────┘
   STATUS STRIP 28px  ▸ socket ● live · offline queue (0) · print agent ● · shift 14:00–22:00 · v2.14.1
```

- **Top bar**: tenant/branch switcher (branch change re-scopes everything and is announced to screen readers), global `⌘K`, notification bell (EN-037 severity-coloured count), help, theme toggle, user menu with **role switcher** (multi-role users, per `05-rbac` §Login).
- **Left nav**: generated from the user's permission set — never render an item the user cannot use. Max 2 levels; each item shows a live count badge where meaningful (Rx queue, pending validations, DLQ). Collapses to a 56 px icon rail with tooltips; state persists per user per device.
- **Work area**: one `PageHeader` (title, breadcrumb, primary action, overflow), then content. Only one primary button per header.
- **Right context rail**: patient-scoped or screen-scoped; tabs, not accordions; remembers the last tab per screen. Auto-opens for critical alerts.
- **Status strip**: connectivity, offline queue depth, print-agent health, current shift/counter, build version — the single place engineers ask users to read during support calls.

### 4.2 Patient banner (`PatientBanner`) — the most safety-critical component

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ [photo] SHARMA, Ramesh Kumar   45 y / M   UHID 0021-45871  ·  IP 2026/IP/018452       │
│  56px   ⛔ ALLERGY: Penicillin (anaphylaxis) +1   🧫 CONTACT ISOLATION   ⚖ MLC #4471   │
│         Ward 3B · Bed 12 · LOS 6 d 4 h · Dr A. Menon (Ortho) · Payer: Star Health (TPA)│
│         [Timeline] [Orders] [Bills] [Documents]                       ⋯ [Break-glass]  │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

Contract:

- **Always present** on any patient-context screen; sticky; compacts to 48 px (photo 32 px, one line: name · age/sex · UHID · allergy chip · bed) on scroll, never disappears.
- **Fields**: photo (or initials avatar with deterministic neutral colour — never colour-coded by sex/religion), full name (family name emphasised), age + sex, UHID, active episode id (OP visit / IP no. / ER no.), ward·bed, LOS, attending consultant + department, payer/scheme + credit status, and **flag row**: allergies (danger, always first, expands to full list), alerts (VIP, fall risk, DNR, infection, deteriorating), isolation type, MLC, blood group, pregnancy/LMP, weight (mandatory-empty state for paediatrics), care-team membership.
- Allergy chip is `--da-700` with ⛔ glyph and the reaction severity; "**No known allergies (verified 12-08-2026)**" is an explicit positive state — an _empty_ allergy area is never allowed (renders `⚠ Allergies not recorded` in warning).
- Clicking any flag opens the source record; hovering shows who recorded it and when.
- Outside the care team the banner renders masked (initials + UHID last 4) with a **Break-glass** button → reason dialog → `READ_PHI` audit (04 §5).
- Print/PDF variant: monochrome, no photo, allergies in bold caps.

### 4.3 Responsive breakpoints

| Token  | Min width | Layout                                 | What collapses                                                                                                                     |
| ------ | --------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `xs`   | 0         | single pane + bottom nav (5 items max) | left nav → bottom nav; context rail → bottom sheet; patient banner → 2-line compact; tables → card list; toolbars → overflow sheet |
| `sm`   | 480       | single pane, wider cards               | as `xs`; 2-col forms become 1-col                                                                                                  |
| `md`   | 768       | 2-pane (list + detail)                 | context rail → slide-over; left nav → icon rail; tables keep 4–6 priority columns, rest in row expander                            |
| `lg`   | 1024      | 2-pane + rail overlay                  | left nav icon rail by default; rail overlays rather than pushes                                                                    |
| `xl`   | 1280      | **3-pane reference layout**            | nothing; this is the design target for clinical desktops                                                                           |
| `2xl`  | 1536      | 3-pane + wider tables/charts           | —                                                                                                                                  |
| `tv`   | 1920      | TV/board layout (no chrome)            | see §4.4                                                                                                                           |
| `tv4k` | 3840      | TV 4K, 2× type scale                   | see §4.4                                                                                                                           |

Rules: a workflow must be **completable** at `xs` if a mobile role exists for it (IP-004 nursing, IP-010 doctor rounds, NC-018 housekeeping, TR-009 ambulance); otherwise show a "best on tablet/desktop" state with the read-only summary rather than a broken layout. Never hide a safety-critical control behind an overflow menu at any breakpoint (allergy flag, hard-stop, scan button, panic/code button).

### 4.4 TV & kiosk (`apps/tv-kiosk`, EN-018 / EN-034)

- **Grid**: 12 × 8 layout cells, `--sp-6` gutters at 1080p (`--sp-12` at 4K). No cursor, no chrome, no scrollbars. Dark Layered Stack theme (10 seeded themes selectable per board).
- **10-foot readability**: minimum text `28 px` @1080p (`--fs-tv-body 32` recommended), token digits `≥ 180 px` (mono 600), contrast **≥ 7:1**, max 7 rows per list widget, max 2 fonts, no thin weights, no italics.
- **4K** = same layout with a ×2 type/space multiplier and 2× assets — never more content.
- Transitions ≤ `--dur-tv` (400 ms); no animation faster than 3 Hz (photosensitive-epilepsy safety); pixel-shift every 15 min for burn-in; dimmed clock screensaver after `idle_minutes`.
- Staleness chip bottom-right: amber "Last updated HH:MM:SS" after loss of socket, red + dimmed token data after `stale_threshold` (default 120 s).
- **Emergency code overlay** at `z 1400`: full-width band, code colour, location, instruction, ≥ 64 px text, audible; not dismissible at the device.
- **Kiosk**: 1080p portrait or landscape touch; primary actions ≥ `120 × 120 px`, `--fs-6xl` labels, max 4 choices per screen, language selector always visible, 60 s inactivity → reset to home with a 10 s "still there?" countdown; every screen has an "Ask for help" that raises a reception task.

### 4.5 Print layouts (`packages/print-templates`)

- Sizes: **A4** (reports, discharge summary, claim packs, MAR sheet landscape), **A5** (prescription, receipt), **80 mm / 58 mm thermal** (token, cash receipt — ESC/POS), **labels** 50×25 / 100×50 mm (specimen, drug, asset — ZPL/TSPL), **wristband** 25×280 mm.
- Always light theme, `#000` on `#FFF`, no background fills except 8 % grey table headers, hairline `0.5 pt` rules, min body `9 pt` (`10 pt` for patient-facing), Indic text `11 pt` minimum.
- Every printed clinical/financial document: hospital letterhead block (EN-039 template), patient identity block (name, UHID, age/sex, episode), page `n of N`, generated-at + generated-by, **QR verify link** (EN-013), and a "Final v2 / Amended" seal where applicable.
- `@page { margin: 12mm 10mm }`; `print-color-adjust: exact` only for the QR and the ESI/flag glyph column; `break-inside: avoid` on table rows and signature blocks.

---

## 5. Component inventory

### 5.1 Base (shadcn/Radix, restyled with our tokens — we own the code)

`Button` (variants: primary/secondary/ghost/danger/link; sizes sm/md/lg/touch) · `IconButton` · `Input` · `Textarea` · `Select` · `Combobox` · `MultiSelect` · `Checkbox` · `Radio` · `Switch` · `Slider` · `DatePicker` / `DateTimePicker` / `DateRangePicker` (dd-MM-yyyy) · `Label` · `FormField` (label + hint + error + required marker) · `Card` · `Tabs` · `Accordion` · `Dialog` · `AlertDialog` · `Sheet` (slide-over) · `Drawer` (bottom, mobile) · `Popover` · `Tooltip` (never the only source of information) · `DropdownMenu` · `ContextMenu` · `Command` (⌘K) · `Toast` · `Banner` · `Badge` · `Chip` · `Avatar` · `Separator` · `ScrollArea` · `Progress` · `Spinner` · `Skeleton` · `Table` (TanStack, virtualised) · `Pagination` (cursor) · `Breadcrumb` · `Stepper` · `Tree` · `Calendar` · `Timeline` · `Kbd` · `CopyButton` · `FileDropzone` · `SignaturePad` · `Resizable` panes.

### 5.2 Clinical components — behaviour contracts

| #   | Component                                         | Contract (props → behaviour → events/a11y)                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `PatientBanner`                                   | §4.2. `patientId, episodeId, mode(full/compact/masked/print)`. Fetches from a shared cache; re-renders on `allergy.recorded`, `patient.updated`, `bed.assigned`. `role="region" aria-label="Patient identity and alerts"`. Masked mode requires `onBreakGlass`.                                                                              |
| 2   | `TriageChip`                                      | `scale(esi/start/meows), level, editable`. Renders numeral + label + colour + icon. Editing opens the triage form; downgrade from ESI-1/2 requires reason. `aria-label="ESI level 2, emergent"`.                                                                                                                                             |
| 3   | `VitalsSparkline`                                 | `param, series, window(24h/72h/stay), refRange`. Line + reference band + last value + arrow; abnormal points marked with glyph. ≤ 200 points (downsampled server-side). Not interactive on TV. `role="img"` with a text summary (min/max/last/trend).                                                                                        |
| 4   | `VitalsEntryPad`                                  | Large numeric pads, per-field ranges, unit toggles (°C/°F), device auto-fill chip ("from monitor MX-7, 14:02 — confirm"), instant NEWS2/PEWS/MEOWS badge with required action text. `Enter` next field, `Ctrl+Enter` save. Blocks impossible values, warns on implausible with confirm.                                                      |
| 5   | `EWSBadge`                                        | `type(news2/pews/mews/meows/qsofa), total, band, scale`. Band colour + numeral + "Scale 2" marker + required-action sentence. Click → component breakdown. Never shown without the action text.                                                                                                                                              |
| 6   | `ResultFlag`                                      | `value, unit, refLow, refHigh, flag, delta, corrected`. Glyph + letter + colour + tabular numerals; critical adds a left rule and `aria-live="assertive"` on first render in an inbox.                                                                                                                                                       |
| 7   | `ResultTable`                                     | Cumulative columns by date, sticky analyte column, delta arrows, unit row, comment footnotes, "compare with prior" toggle, print view. Virtualised beyond 60 rows.                                                                                                                                                                           |
| 8   | `BedTile`                                         | `bed, state, patient?, acuity, flags[]`. 2-letter state code + icon + hatch pattern + masked/full label per board policy. Drag to transfer (desktop only, with confirm dialog). Keyboard: arrow-key grid navigation, `Enter` opens.                                                                                                          |
| 9   | `BedBoard`                                        | Grid/list toggle, ward filters, legend always visible, live diffs (≤1 push/s coalesced), reconnect snapshot. Counts strip (occupied/free/dirty/blocked/reserved).                                                                                                                                                                            |
| 10  | `QueueCard`                                       | Token (mono, large), patient masked label, visit type, wait time (turns amber >30 m, red >60 m), vitals chips, flags. Actions: call/skip/requeue with confirm on skip. `Space` = call next from the list.                                                                                                                                    |
| 11  | `TokenDisplay`                                    | TV widget: `--fs-tv-token`, flip transition ≤400 ms, room + doctor, holds enlarged for the full TTS duration; suppresses audio for calls older than 90 s.                                                                                                                                                                                    |
| 12  | `MARGrid`                                         | Rows = drugs, columns = administration times; cell = status icon + time; PRN panel and infusion panel separate; click → `AdministerDialog`. Past cells immutable (rendered as facts, not inputs). Horizontal virtualisation for 24 h × 40 drugs. High-alert rows carry a persistent marker.                                                  |
| 13  | `AdministerDialog`                                | Step 1 scan patient → Step 2 scan drug → checks panel (5 Rights + lab/vitals gates) → outcome (`G` given / `H` held / `R` refused) → witness step for high-alert/narcotic (second user auth, self-witness = 403). Any failed check renders a hard stop with the failing right named. Offline-capable with cached order snapshot age warning. |
| 14  | `OrderSetPicker`                                  | Search + department/pathway grouping + favourites; preview of every item with price and coverage; apply is additive and fully editable afterwards; shows what will be charged and what needs pre-auth.                                                                                                                                       |
| 15  | `DrugSearchCombobox`                              | Debounce 150 ms, min 2 chars, brand↔generic dual line, strength/form/route, **live stock at the target store**, price, schedule (H/H1/X/NDPS) badge, formulary/scheme flag, favourites and "my frequent" first. Keyboard-only selectable; never auto-selects the first row on blur.                                                          |
| 16  | `AllergyAlertDialog`                              | Hard stop. Substance, documented reaction + severity, source and date, matched molecule/class, the rule id. Continue requires a reason from a coded list + free text, and disables for roles without `override` (residents). Writes `cdss_alert_log`. `role="alertdialog"`, focus trapped, ESC disabled.                                     |
| 17  | `InteractionPanel`                                | Severity-sorted list (contraindicated → major → moderate → minor) with mechanism, management text, and per-item acknowledge; contraindicated escalates to `AllergyAlertDialog` styling.                                                                                                                                                      |
| 18  | `DoseCalculator`                                  | mg/kg (+ BSA for oncology), age/weight/eGFR inputs pulled from the chart, max-dose ceiling, rounding to available strengths, shows the arithmetic ("12 kg × 15 mg/kg = 180 mg → 5 mL of 250 mg/5 mL"). Blocks >200 % ceiling. Missing weight = blocking empty state, not a silent default.                                                   |
| 19  | `ConsentSigner`                                   | Template (EN-028/EN-039) → language selector → read-confirm scroll gate → signature (pad / OTP / Aadhaar eSign via EN-016) → witness/relation block → PDF preview → sign. Records artefact id; withdrawal path always visible.                                                                                                               |
| 20  | `BodyMapAnnotator`                                | SVG body (adult M/F, paediatric, infant, dental, ocular, dermatome). Tap/click to drop coded pins (site, side, type), free-draw for wounds, measurement entry, photo attach with consent gate. Keyboard: region list fallback (a11y equivalent, mandatory).                                                                                  |
| 21  | `PartographChart`                                 | WHO/modified partograph (IP-011): cervical dilatation with alert & action lines, descent, FHR, contractions, liquor, moulding, maternal obs, drugs. Time-locked x-axis, entries append-only, crossing the action line raises an alert.                                                                                                       |
| 22  | `GrowthChart`                                     | WHO/IAP percentile charts (OP-033/IP-015): weight, height, HC, BMI, weight-for-height; plotted points with visit tooltips; z-score readout; prematurity correction toggle.                                                                                                                                                                   |
| 23  | `BarcodeScanInput`                                | Keyboard-wedge detection (§6.2); accepts USB HID, Bluetooth, camera (PWA `BarcodeDetector` + ZXing fallback); resolves any symbology via EN-013 scan resolver and routes to the entity action; shows the decoded entity for 1.5 s before acting; audible + haptic confirm; failure shows the raw payload for support.                        |
| 24  | `MoneyInput`                                      | `numeric(14,2)`, currency prefix from tenant, Indian grouping (`₹1,23,45,678.00`), no float maths (minor units), paste-tolerant, `-` blocked unless credit note, on blur formats and announces the value. Never rounds silently — rounding shows as an explicit line.                                                                        |
| 25  | `TariffPicker`                                    | Service search with payer-aware price (RC-003 effective-dated), shows base vs payer rate vs package inclusion, coverage/exclusion badge, quantity, and the resulting patient-payable delta live.                                                                                                                                             |
| 26  | `ChargeSheet`                                     | Grouped bill lines (consultation, investigations, pharmacy, procedures, room, package), per-line discount with approval state, tax lines (CGST/SGST/IGST with HSN/SAC), advance adjustment, running balance pinned.                                                                                                                          |
| 27  | `PaymentSplitter`                                 | Multi-tender (cash/card/UPI QR/link/cheque/advance/credit/scheme), per-tender reference capture, ₹2,00,000 §269ST cash guard, change calculation, receipt print/reprint. Idempotency key per attempt.                                                                                                                                        |
| 28  | `ApprovalTimeline`                                | Vertical steps with actor, role, timestamp, decision, reason, SLA timer; pending step highlighted with the action button for authorised users; escalation shown as a branch (EN-038).                                                                                                                                                        |
| 29  | `AuditDiffViewer`                                 | Before/after field diff with old struck / new emphasised, actor + role + IP + device + reason, hash-chain verification chip. Read-only; opens from any record's "History".                                                                                                                                                                   |
| 30  | `ShiftHandoverPanel`                              | I-PASS/SBAR cards per patient, pre-populated and editable, bedside walk-round mode (wristband scan per patient), per-patient acknowledge, dual sign-off, immutable PDF. Unacknowledged count pinned.                                                                                                                                         |
| 31  | `TaskList`                                        | Grouped by due window (overdue / now / next 2 h / later), swipe-to-complete on touch, skip requires reason, live re-sort, "my patients" filter, count badges feeding the shell.                                                                                                                                                              |
| 32  | `CriticalAlertToast`                              | `z 1300`, danger, **not auto-dismissing**, requires "Acknowledge" (records who/when), stacks max 3 with "+n more" opening the inbox, plays a distinct sound once (respects device mute but not quiet hours for critical), duplicates the alert into the notification bell.                                                                   |
| 33  | `KeyboardHintBar`                                 | Bottom-docked contextual shortcut strip per screen; `?` expands the full sheet; auto-hides on touch-only devices; reflects the user's remapped keys.                                                                                                                                                                                         |
| 34  | `OfflineBadge`                                    | States: online · degraded (slow) · offline (queued n) · syncing (n/m) · conflict (n). Click opens the offline queue with per-item retry/discard and conflict resolution — never silently overwrites.                                                                                                                                         |
| 35  | `PrintPreview`                                    | Renders the actual print template at scale, printer/target picker (EN-005 agent, browser fallback), copies, tray, "print later"; shows the last print of this document (who/when/where) to prevent duplicate handouts.                                                                                                                       |
| 36  | `EmptyState`                                      | Illustration-free: icon + one-line cause + one-line next action + primary button. Must be specific ("No patients waiting — next appointment 10:30", never "No data").                                                                                                                                                                        |
| 37  | `SkeletonList` / `SkeletonForm` / `SkeletonChart` | Match final layout metrics exactly (no layout shift, CLS 0). Shown only after 200 ms of loading; below 200 ms show nothing.                                                                                                                                                                                                                  |
| 38  | `ErrorBoundaryCard`                               | Contained failure with error reference id, "Retry", "Copy diagnostics", "Report to IT" (creates NC-028 ticket). Never blanks the screen; never leaks a stack trace or PHI.                                                                                                                                                                   |
| 39  | `ConflictResolver`                                | Side-by-side mine/theirs/base for offline sync conflicts, field-level pick, mandatory human choice for clinical fields, audit note on resolve.                                                                                                                                                                                               |
| 40  | `SignatureSeal`                                   | Document status seal: Draft / Final v_n / Amended / Cancelled, signer name + reg no + method + timestamp, hash chip, verify link.                                                                                                                                                                                                            |
| 41  | `WorklistTable`                                   | Server-driven cursor pagination, sticky header + first column, saved views per user, column chooser, density toggle, bulk selection with a persistent action bar, row expander for secondary fields, virtualisation above 100 rows.                                                                                                          |
| 42  | `PatientSearchDialog`                             | ⌘K-embedded and standalone: search by name/UHID/phone/ABHA/token/bed/bill; trigram-tolerant; results show photo, UHID, age/sex, last visit, active episode; duplicates flagged for MPI merge; **opening a non-care-team patient routes through break-glass**.                                                                                |
| 43  | `WardCensusStrip`                                 | Occupied/free/dirty/blocked/reserved counts + admissions/discharges/transfers today + expected discharges; identical numbers on desktop, TV and mobile (single read model).                                                                                                                                                                  |
| 44  | `AttachmentViewer`                                | Sandboxed render of PDF/JPEG/DICOM thumbnail; DICOM opens OHIF (EN-008) in a new context with the study id; download requires `*.export` permission and is audited.                                                                                                                                                                          |

Every clinical component ships with: Storybook story (light + dark + high-contrast + 200 % zoom + RTL), `axe` test, keyboard-only test, and a "degraded data" story (missing weight, unknown allergies, stale socket).

---

## 6. Interaction standards

### 6.1 Keyboard-first

**Global shortcuts** (registered centrally; user-remappable; never conflict with browser/OS reserved keys):

| Key                    | Action                                                       | Key                  | Action                              |
| ---------------------- | ------------------------------------------------------------ | -------------------- | ----------------------------------- |
| `⌘/Ctrl + K`           | Command palette (patient, bed, bill, order, action, setting) | `⌘/Ctrl + S`         | Save draft                          |
| `⌘/Ctrl + Enter`       | Sign / complete / submit the primary object                  | `⌘/Ctrl + P`         | Print current document              |
| `/`                    | Focus the screen's search                                    | `?`                  | Shortcut sheet                      |
| `g` then `d/q/w/l/p/b` | Go to dashboard / queue / ward / lab / pharmacy / billing    | `Esc`                | Close top layer (never a hard stop) |
| `Alt + 1..9`           | Switch work-area tab                                         | `[` / `]`            | Toggle left nav / context rail      |
| `n`                    | New (context-dependent: visit, order, note)                  | `.`                  | Row actions menu on the focused row |
| `Alt + ↑/↓`            | Previous / next patient in the worklist                      | `⌘/Ctrl + Shift + L` | Lock screen (PIN quick re-auth)     |

**Per-screen conventions** (documented in each module spec §8 and surfaced in `KeyboardHintBar`): single letters act on the focused list (`V` vitals, `M` MAR, `N` note, `H` handover, `T` tasks, `G/H/R` in `AdministerDialog`); `Alt + <letter>` opens a composer (`Alt+R` Rx, `Alt+L` lab, `Alt+I` imaging, `Alt+D` diagnosis); `Space` = call next in a queue; `1..9` = jump to the nth bed/counter. Grids behave like spreadsheets (`Tab`/`Shift+Tab` cells, `↑↓` rows, `Ctrl+D` duplicate row, `Del` remove row).

Rules: every action reachable by mouse is reachable by keyboard; tab order follows visual order; focus is never trapped except in hard stops; after a dialog closes focus returns to the trigger; after a row action the focus stays on the row; roving `tabindex` in grids and bed boards (one tab stop per grid).

### 6.2 Barcode scanner input (keyboard-wedge detection)

- Detection heuristic: a burst of `keydown` events with **median inter-key interval < 30 ms**, length ≥ 6, terminated by `Enter`/`Tab` within 300 ms → treat as a **scan**, not typing. Buffer is captured at the document level, suppressed from the focused input, and dispatched to the scan resolver (EN-013).
- Global scan works with **no focused field** (bedside/counter reality). A focused `BarcodeScanInput` takes priority; a focused free-text field only receives the scan if it is marked `data-scan-target`.
- Prefix/suffix configurable per device profile (e.g. `~` prefix for wristbands); symbology inferred (Code128, GS1-128 with AIs, GS1 DataMatrix, QR, ISBT-128 for blood).
- Feedback: short beep + 60 ms haptic + the resolved entity chip for 1.5 s. Unresolved scan → non-blocking error with the raw payload and "search manually".
- Camera fallback in PWA (`BarcodeDetector`, ZXing polyfill) with torch toggle; a manual-entry path with reason is always available (scan-compliance % is a tracked KPI, IP-003).
- Scanner never triggers a destructive action directly; it selects a target, the human confirms.

### 6.3 Touch, pointer, density

- Touch targets ≥ **44 × 44 px** with ≥ 8 px separation on clinical tablets/phones (exceeds WCAG 2.2 AA 2.5.8's 24 px). Desktop mouse targets ≥ 28 px height for rows, ≥ 32 px for buttons.
- Three densities: `compact` (32 px rows, power users), `default` (40 px), `touch` (52 px, auto on coarse pointers). Persisted per user per device.
- Gloved-hand mode (ICU/OT): forces `touch` density, disables swipe-to-delete, increases hit slop by 8 px.
- No hover-only affordances anywhere; no drag-only interactions without a menu equivalent.

### 6.4 Forms

- **Autosave drafts** every 5 s and on blur (server draft + IndexedDB mirror); explicit "Saved 14:02" chip; `⌘S` forces a save. Signing/finalising is always a separate deliberate action.
- **Dirty-state guard** on route change, tab close, branch switch and logout: "3 unsaved changes — Save draft / Discard / Cancel". Auto-logout saves the draft first.
- **Validation**: Zod schema shared with the API (`packages/contracts`). Validate on blur, re-validate on change once a field has errored, never on first keystroke. Errors sit under the field with a `⛔` glyph, plus a summary banner listing the fields (each link focuses the field). Server errors (RFC 9457 problem+json) map to the same field slots.
- Required fields marked with a red asterisk **and** `aria-required`; optional fields labelled "(optional)" where the ratio is mostly required.
- Section-level gating for multi-step clinical forms; never let a user reach step 5 to learn step 2 was invalid.
- Units, ranges and reference values always visible next to numeric clinical inputs; unit changes never silently reinterpret the number.

### 6.5 Search

- Global `⌘K`: scoped tabs (Patients · Beds · Bills · Orders · Actions · Settings), debounce 150 ms, min 2 chars (3 for free-text notes), trigram-tolerant, recent-first when empty. Results show enough to disambiguate (photo, UHID, age/sex, last visit).
- In-screen search filters the current list server-side (never client-only above 200 rows); the applied filter is a visible removable chip set, shareable via URL (no PHI in the URL — only opaque ids and filter keys).
- Clinical catalogues (drugs, ICD, tests, services) search brand + generic + synonym + Indian colloquial alias + code; exact-code match always ranks first.

### 6.6 Optimistic updates & rollback

- **Allowed optimistic**: task complete/skip, queue call/skip, filter/sort, favourite/pin, read-marks, non-clinical toggles, draft note text.
- **Never optimistic**: anything that signs, dispenses, administers, issues blood, posts a charge, takes a payment, cancels an order, or discharges. These show an inline pending state on the control and wait for the server.
- Rollback: TanStack Query `onError` restores the snapshot, the row flashes `--wa-100` for 600 ms, and a toast states what failed and why, with "Retry". Two consecutive failures escalate to a dialog (silent repeated failure is a safety defect).
- Idempotency-Key is generated client-side per user intent (not per retry) for money/order endpoints.

### 6.7 Loading, empty, error states

| Situation                          | Pattern                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| < 200 ms / 200 ms–3 s / > 3 s      | Nothing (avoid flicker) / skeleton matching the final layout with the shell + banner still interactive / skeleton + "Still loading…" + Cancel where cancellable |
| Streamed page (RSC)                | Shell + banner first, then panes as they resolve; never reflow the banner                                                                                       |
| Background refetch                 | Subtle top progress bar; stale data stays visible and legible (never blank a chart to reload it)                                                                |
| Empty — no data yet / filtered out | `EmptyState` with cause + next action / "No results for these filters" + "Clear filters"                                                                        |
| Permission denied                  | Explain the missing permission key in plain words + "Request access" (raises an EN-038 request)                                                                 |
| Not found / wrong tenant           | Neutral "Not available" (never reveal existence across tenants)                                                                                                 |
| Server error / offline             | `ErrorBoundaryCard` with reference id / `OfflineBadge` + banner, queued actions still usable                                                                    |
| Read-only mode (DB failover)       | Persistent amber banner "Read-only — writes disabled since 14:02"; write controls disabled with tooltips, not hidden                                            |

### 6.8 Toast vs banner vs dialog vs inline

| Use                         | When                                                                                                                         | Rules                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Inline**                  | Field-level validation, per-row status                                                                                       | Nearest to the cause; never a toast for a field error                                                                                                   |
| **Toast**                   | Non-blocking confirmation of a user-initiated action ("Rx signed", "Task completed")                                         | Auto-dismiss 4 s (6 s with Undo); max 3 stacked; bottom-right desktop / top mobile; never for errors that need action; never for clinical alerts        |
| **Banner**                  | Persistent state affecting the whole screen (offline, read-only, stale board, unsigned draft, pending co-sign, CDSS offline) | Dismissible only if the state is informational; sticky under the top bar; one at a time (highest severity wins, others collapse to "+2")                |
| **Dialog**                  | A decision that needs the user's full attention with a reversible outcome                                                    | Focus trap, ESC + click-outside close, primary action right                                                                                             |
| **AlertDialog (hard stop)** | Safety/financial irreversibility                                                                                             | No ESC, no click-outside, no close X, explicit reason, sometimes a second person; primary action is the _safe_ one and destructive continue is `danger` |
| **CriticalAlertToast**      | Critical result, code blue, NEWS2 ≥ 7, panic                                                                                 | `z 1300`, non-dismissing, acknowledge required, mirrored to the bell + push (EN-037)                                                                    |

### 6.9 Confirmation patterns (escalating friction)

1. **None** — reversible, low impact (toggle a filter).
2. **Undo toast (10 s)** — task complete, queue skip.
3. **Simple confirm** — cancel an unsent draft.
4. **Confirm + reason (coded list + free text)** — order cancellation, dose held/refused, appointment cancel, amendment.
5. **Confirm + reason + typed value** — refund, bill void, patient merge, discharge-against-advice: type the bill no. or UHID last 4.
6. **Confirm + reason + second person** — narcotic, blood issue, high-alert dose, discount above limit, break-glass on a VIP record: second user authenticates on the same or their own device; the same user can never be both.
7. **Confirm + reason + 3-second press-and-hold** — emergency code activation (EN-018), mass-casualty declaration.

---

## 7. Accessibility (WCAG 2.2 AA — contractual)

- **Perceivable**: contrast per §3.4; text resizes to **200 %** without loss (no fixed-height rows, no clipped labels) and reflows at **400 % / 320 px** equivalent; no information by colour alone (§1.2.3); every icon-only button has an accessible name; images/charts have text alternatives (`ResultTable` is the text alternative for `VitalsSparkline`).
- **Operable**: full keyboard operation; visible focus ring `2px --border-focus` + `2px` offset with ≥ 3:1 against both the component and the background (2.4.13); focus never obscured by sticky headers/rails (2.4.11 — scroll-padding equal to banner height); no keyboard traps; target size ≥ 24 px (we require 44 px on touch, 2.5.8); dragging always has a click alternative (2.5.7 — bed transfer, layout builder); no time limits on clinical entry except the security idle timeout, which warns at 13 min and preserves the draft (2.2.1); redundant entry avoided (2.4.11/3.3.7 — patient data pre-filled, never retyped); accessible authentication (3.3.8 — no cognitive-function test; PIN quick-unlock and WebAuthn allowed, no puzzles).
- **Understandable**: language of page and of parts (`lang` on Indic/Arabic spans so screen readers switch voice); consistent help location (3.2.6 — `?` and help icon in the same place on every screen); error identification, suggestion and prevention for legal/financial/data actions (3.3.1/3.3.3/3.3.4).
- **Robust**: semantic HTML first, ARIA only to fill gaps; live regions — `aria-live="polite"` for queue/task/board changes and autosave, `aria-live="assertive"` + `role="alert"` for critical results, hard stops and code banners; `role="status"` for the offline badge.
- **Screen-reader labelling for clinical data**: values are announced with unit, reference and flag — `"Potassium 6.8 millimoles per litre, critical high, reference 3.5 to 5.1, delta up 1.9 since yesterday"`; MAR cells announce `"Insulin 10 units subcutaneous, due 08:00, high alert, requires witness, status due"`; bed tiles announce `"Bed 12, occupied, isolation contact, 3 tasks overdue"`; abbreviations expanded on first use per screen (`<abbr>` with title + `aria-label`).
- **Colour-blind safety**: palettes validated for protanopia/deuteranopia/tritanopia; the ESI/START, bed-state, result-flag and RAG sets never rely on hue; RAG chips carry icon + text (EN-017 §13).
- **Font scaling**: root `rem`-based; user scale 100/112/125/150 % stored per user; no `px` line clamping on clinical text; tables switch to card layout beyond 150 %.
- **Reduced motion**: `prefers-reduced-motion` honoured everywhere including TV boards (token flip becomes a cross-fade); pulsing "live" indicators become static rings.
- **High-contrast mode for bright wards**: a third token map (`[data-contrast="high"]`) with ≥ 7:1 body text, `--border-strong` everywhere, no subtle greys, chips gain 1 px outlines; toggled per user and forced on ER/ambulance-bay kiosks.
- **Hearing**: every TTS announcement is simultaneously visual and enlarged (RPwD Act 2016, EN-018 §3.4); no audio-only alerts.

---

## 8. Internationalisation & localisation

- **Catalogue**: `next-intl`, keys namespaced `<module>.<screen>.<element>` (`opd.consult.signButton`), one JSON per locale in `packages/i18n`. **No string literals in components** (ESLint rule). ICU MessageFormat for plurals/gender/select; no string concatenation for sentences; variables carry semantic names (`{patientName}`, `{count}`).
- **Locales**: `en-IN` (default) → `hi, ta, te, ml, kn, mr, bn, gu, or, pa` → `ar` (RTL). Untranslated keys fall back to `en-IN` and are reported by a CI coverage check (fail below 100 % for P0 clinical screens in the hospital's enabled locales).
- **What is never translated**: drug molecule names, ICD/SNOMED/LOINC display terms, lab analyte names, HL7/FHIR codes, accession/bill/UHID formats. Patient-facing _instructions_ are translated via the phrasebook (OP-002 §3.2); clinical content stays English with a translated instruction line.
- **Numbers & money**: Indian grouping (`##,##,###.##`) via `Intl.NumberFormat('en-IN')`; lakh/crore abbreviations in dashboards only (`₹1.24 Cr`, `₹8.5 L`) with the exact value in the tooltip and in all printed/exported documents; currency symbol from tenant config (`₹`, `AED`, `QAR`, `$`); amounts right-aligned, tabular numerals, two decimals always.
- **Dates & times**: display `dd-MM-yyyy` and `dd-MMM-yyyy` for documents; times `HH:mm` (24 h) in clinical contexts, 12 h allowed in patient-facing text; always hospital time zone with the zone shown on cross-branch/group views; ISO-8601 with offset in APIs, exports and HL7. Age formats: `<1 m` in days, `<2 y` in months, else years; gestational age `w+d`.
- **Indic typography**: line-height +2 px over Latin equivalents for Devanagari/Bengali/Tamil ascenders-descenders; never `text-transform: uppercase` on Indic; avoid letter-spacing on Indic; test the 8 longest strings per screen (German-length proxy: Tamil/Malayalam run ~30–40 % longer than English).
- **RTL readiness**: logical CSS properties only (`margin-inline-start`, `padding-block`, `inset-inline`); no `left/right` in component CSS; icons that encode direction are mirrored (`[dir=rtl] .mirror { transform: scaleX(-1) }`), icons that encode objects are not; charts and clinical timelines stay LTR with a mirrored label rail; numbers and Latin drug names stay LTR inside RTL paragraphs (`bdi`).
- **TTS announcements** (EN-018/EN-034): template-driven per language with a per-branch rotation order (max 3 languages per call), pre-generated audio cached by `(text, lang, voice)` hash; numerals spoken digit-by-digit for tokens (`"C four five"`), names optional per privacy policy; the same text is displayed enlarged for the announcement duration.

---

## 9. Screen archetypes

**A. Worklist** (doctor queue, lab bench, validation, radiology reading, DLQ, claims)

```
PageHeader: "Bench worklist — Biochemistry"        [Saved view ▾] [+ New]  ⋯
Filter bar: [Status ▾][Priority ▾][Ward ▾][Date ▾]  chips: STAT ×  Ward 3B ×   [Clear]
┌ 68 items · 12 STAT ─────────────────────────── density ▤ · columns ⚙ ─────────┐
│☐│Acc no │Patient (masked)│Test    │Pri │Received│Age  │Status      │Flags     │
│☐│L-4471 │RS ·8471 45/M   │Sr K+   │STAT│14:02   │18m  │● Resulted  │▲▲ HH     │
│☐│L-4472 │AK ·2210 62/F   │CBC     │Rtn │13:40   │40m  │◐ In progress│         │
└──────────────────────────────────────────────────────── cursor: load more ────┘
[bulk bar appears on selection: Validate (3) · Assign · Print · Export*]
```

Rules: server-side sort/filter/pagination; sticky header + first column; saved views; overdue rows carry a left rule not a background; bulk actions require an explicit confirm listing counts; `*` export is permission-gated and audited.

**B. Patient chart** (OP-002 consultation, IP nursing chart)

```
[ PatientBanner ..................................................................... ]
┌ Timeline rail 280 ┬ Work area ─────────────────────────┬ Context rail 320 ───────┐
│ ▾ Today           │ [Complaint][History][Exam][Dx][Plan]│ Vitals  ▁▂▅▇ BP 148/92  │
│  14:02 Consult    │ [Rx][Orders]      Alt+1..7          │ NEWS2 6 ▲ act ≤30 min   │
│ ▾ 12-08-2026      │ ┌─────────────────────────────────┐ │ Allergies ⛔ Penicillin │
│  Lab: CBC ▲       │ │ note editor / Rx grid / orders  │ │ Active meds (5)         │
│  Rx v2 (amended)  │ │                                 │ │ Last labs  ▲▲ K+ 6.8    │
│ ▸ 02-08-2026      │ └─────────────────────────────────┘ │ Alerts (2)  Tasks (3)   │
└───────────────────┴ autosave ● Saved 14:03 ─────────────┴─────────────────────────┘
KeyboardHintBar: Alt+R Rx · Alt+L Lab · Alt+I Imaging · ⌘S Save · ⌘↵ Sign & complete
```

**C. Order entry / CPOE**

```
[ PatientBanner ]                                  Estimated: ₹4,250 · Pre-auth needed ⚠
┌ Catalogue ────────┬ Cart (4 items) ──────────────────────────────────────────────┐
│ / search tests    │ CBC          Routine  Fasting: No   ₹350   [×]                │
│ ▾ Favourites      │ Sr Creatinine STAT ⚡  ₹280  ⚠ duplicate within 24 h — reason?│
│ ▾ Order sets      │ CT Brain plain  ⚠ LMP/pregnancy check required               │
│ ▾ Haematology     │ ─────────────────────────────────────────────────────────────│
│ ▾ Biochemistry    │ Priority ▾ · Clinical indication * · Notify on result ☑       │
└───────────────────┴ [Save draft]                      [Place orders  ⌘↵] ────────┘
```

**D. Billing counter** (OP-005/NC-001) — two-column: left charge sheet with running total pinned bottom; right tender panel. Keyboard: `F2` add service, `F4` discount (approval), `F8` payment, `F9` print, `F10` next patient. Cash drawer/shift state and ₹2 L §269ST guard visible. Every amount tabular; discount shows approver; receipt prints on ESC/POS via the print agent with browser fallback.

**E. Bed board** (IP-001/IP-025)

```
Ward 3B · 40 beds   Occ 34 · Free 3 · Dirty 2 · Blocked 1        [Grid|List] [Legend]
┌────┬────┬────┬────┬────┐   Legend: OC occupied · VC vacant-clean · VD dirty ▨
│301 │302 │303 │304 │305 │            BL blocked ▩ · IS isolation ◎ · RS reserved ⌐
│OC◎ │OC  │VD▨ │VC  │OC⚠ │   Tile: bed no · state code · masked label · acuity bar
│RS·2│AK·1│    │    │MN·3│         · task count · isolation ring · LOS
└────┴────┴────┴────┴────┘
```

**F. TV token board** (EN-018, 1080p, dark)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  VIM'S HOSPITAL — OPD BLOCK A                                    14:07  Mon  │
│  ┌───────────────── NOW SERVING ─────────────────┐ ┌──── NEXT ────┐          │
│  │                                               │ │ C-46  Room 3 │          │
│  │        C-45                Room 3             │ │ C-47  Room 3 │          │
│  │      (180px mono)     Dr A. Menon · Ortho     │ │ C-48  Room 4 │          │
│  └───────────────────────────────────────────────┘ └──────────────┘          │
│  Waiting 18 · Avg wait 22 min · Dr Rao: on break, back 14:30                 │
│  ▸ health tip ticker ─────────────────────────  ● Last updated 14:07:02      │
└──────────────────────────────────────────────────────────────────────────────┘
```

**G. Mobile bedside** (IP-004) — single pane, bottom nav (Patients · Tasks · Scan · Alerts · More), giant `Scan` FAB, offline badge in the header, per-patient card with EWS badge + next dose + overdue count; `AdministerDialog` full-screen with 56 px outcome buttons.

**H. Kiosk** (EN-034) — 3 choices max: `Check in with UHID / ABHA QR / Mobile OTP`; `--fs-6xl` buttons, language bar top, help button bottom-right, printed token preview before printing, 60 s reset.

---

## 10. Do's and don'ts

| ✅ Do                                                                                                                       | ❌ Don't                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `⛔ ALLERGY: Penicillin (anaphylaxis)` — icon + word + colour                                                               | A red dot next to the name                                                                |
| "No known allergies (verified 12-08-2026)" as an explicit state                                                             | An empty allergy area that could mean "none" or "not asked"                               |
| Hard stop for a documented allergy match with a coded reason                                                                | A dismissible toast saying "possible allergy"                                             |
| Soft-stop banner "Acknowledged by Dr X, 14:02" for a major interaction                                                      | Styling every warning as a blocking modal (alert fatigue)                                 |
| "Cancel order — reason required" + audit entry                                                                              | A trash icon that deletes an order                                                        |
| `₹1,23,45,678.00` right-aligned tabular; `18-08-2026 14:07` on records                                                      | `12345678.0`, a rounded `1.2 Cr` on a bill, or "2 hours ago" as a record's only timestamp |
| Weight required, `DoseCalculator` shows the arithmetic                                                                      | A free-text mg field for a 12 kg child                                                    |
| Bed tile `VD ▨ vacant-dirty`; RAG chip with icon + text                                                                     | An orange square only; a colour-only RAG chip                                             |
| Token digits 180 px, 7:1 contrast, name masked                                                                              | 48 px token text with the patient's full name on a corridor TV                            |
| Skeleton matching the final table; "No patients waiting — next appointment 10:30"; error with reference id + "Report to IT" | A centred spinner replacing the page; "No data found"; "Something went wrong"             |
| Optimistic tick on "task complete" with rollback                                                                            | Optimistic "dose given" before the server confirms                                        |
| Keyboard path for every mouse action, `?` sheet                                                                             | Drag-only bed transfer                                                                    |
| Logical CSS properties, `bdi` around Latin names in Hindi text                                                              | `margin-left` and hard-coded LTR chart labels                                             |
| One primary button per header                                                                                               | Three teal buttons competing in a toolbar                                                 |
| Print with letterhead, page n/N, QR verify, "Amended v2" seal                                                               | A browser print of the screen with the nav bar                                            |

---

## 11. Implementation & governance

- Tokens: `packages/ui/src/tokens/{color,typography,space,motion,elevation}.css` → Tailwind v4 `@theme` → `tokens.ts` for RN/print. **CI fails on any hex literal outside the token files.**
- Components: `packages/ui/src/{primitives,clinical,charts,print}`; each exports types from `packages/contracts` — clinical components never fetch on their own except through injected hooks (testable, storybook-able).
- Themes applied via `data-theme="light|dark"` + `data-contrast="normal|high"` + `data-density="compact|default|touch"` on `<html>`; TV boards force theme from `display_boards.theme_key` (EN-018).
- Quality gates (with `09-quality-gates-and-testing.md`): Storybook a11y (`axe`) zero violations on P0 components; Playwright keyboard-only golden path per module; visual regression on light/dark/high-contrast/RTL/200 %; contrast unit tests over the token map; i18n key-coverage check; bundle budget per route (`07-performance-scalability.md` §3).
- Change control: token or clinical-component changes that alter a safety signal (colour meaning, hard-stop styling, banner content) require clinical sign-off recorded with the release, per `04-security-compliance.md` §7.
