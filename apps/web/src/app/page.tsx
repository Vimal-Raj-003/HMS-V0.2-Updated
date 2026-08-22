import type { Metadata } from 'next';
import Link from 'next/link';
import { LandingBoard } from './landing-board';

export const metadata: Metadata = {
  title: "Vim's HMS — the record that travels with the patient",
  description:
    'Hospital management system by VIMS ENTERPRISE. Registration, appointments, queues, clinical records, diagnostics, pharmacy, wards and billing in one system. ABDM-ready, NABH-aligned, DPDP-compliant.',
};

/**
 * The front door.
 *
 * Its single job is to get the right person signed in. Everything else on the
 * page exists to make that fast or to tell a first-time visitor what they are
 * signing in to.
 *
 * **Every staff route leads to the same `/login`.** `docs/05` and the login
 * screen's own contract are explicit that the user never declares what kind of
 * user they are — the system resolves their roles and branch scope from their
 * credentials and routes them to their home workspace. So the groups below are
 * wayfinding, not identity selection: they tell a ward nurse that this is the
 * right building, and then hand them the one door. A picker that actually set a
 * role would be a privilege-escalation surface built into the home page.
 *
 * The page is rendered dark. `CLAUDE.md` §5 puts clinical work on the light
 * theme and reserves dark for boards and analytics; this is a board, not a
 * charting screen, and it is the surface most often shown on a lobby display or
 * a phone in daylight.
 */

interface Destination {
  readonly name: string;
  readonly who: string;
  /**
   * Typed as the literal route rather than `string`, so Next's typed-routes
   * check catches a typo here at build time instead of shipping a tile that
   * leads to a 404. Every staff destination is the same door by design.
   */
  readonly href?: '/login';
  readonly note?: string;
}

/**
 * Grouped by where someone works rather than by job title. A hospital has 60+
 * roles (`docs/05`) and a list of them is unreadable; a receptionist looking for
 * their way in recognises "front office" instantly and never has to find
 * "Receptionist / Front Office" in an alphabetical column.
 */
const DESTINATIONS: readonly Destination[] = [
  {
    name: 'Front office',
    who: 'Reception, registration, appointments, cash counter',
    href: '/login',
  },
  {
    name: 'Clinical',
    who: 'Doctors, nurses, OPD, emergency, wards, theatre',
    href: '/login',
  },
  {
    name: 'Diagnostics',
    who: 'Laboratory, radiology, blood bank',
    href: '/login',
  },
  {
    name: 'Pharmacy & stores',
    who: 'Dispensing, inventory, purchase, biomedical',
    href: '/login',
  },
  {
    name: 'Administration',
    who: 'Hospital and branch admins, MRD, quality, accounts, HR',
    href: '/login',
  },
  {
    // Patients authenticate with OTP or ABHA rather than a password, which is a
    // different sign-in flow and a different phase of the build. Linking it to
    // the staff screen would send a patient somewhere their credentials cannot
    // work, so it says so instead.
    name: 'Patients & partners',
    who: 'Patients, families, corporate HR, TPAs, referring doctors',
    note: 'Opens with the patient portal',
  },
];

/** What the software actually covers, in the order a patient meets it. */
const PATHWAY: readonly { readonly step: string; readonly detail: string }[] = [
  { step: 'Arrives', detail: 'Registration, UHID, ABHA, appointment, token' },
  { step: 'Is assessed', detail: 'Triage, vitals, consultation, prescription' },
  { step: 'Is investigated', detail: 'Lab orders, samples, results, imaging, reports' },
  { step: 'Is treated', detail: 'Pharmacy, admission, ward, theatre, intensive care' },
  { step: 'Settles', detail: 'Tariff, bill, insurance, receipt, discharge summary' },
];

export default function LandingPage() {
  return (
    <div data-theme="dark" className="min-h-dvh bg-canvas text-fg-default">
      <a
        href="#sign-in"
        className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-layer-3 focus:px-4 focus:py-2 focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--border-focus)]"
      >
        Skip to sign in
      </a>

      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-6 sm:px-8">
        <p className="font-display text-sm font-semibold tracking-tight">
          Vim&rsquo;s HMS
          <span className="ms-2 font-mono text-[0.625rem] font-normal uppercase tracking-[0.18em] text-fg-subtle">
            by VIMS Enterprise
          </span>
        </p>
        <Link
          href="/login"
          className="rounded-lg border border-strong px-4 py-2 font-mono text-xs uppercase tracking-[0.14em] transition-colors hover:bg-layer-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--border-focus)]"
        >
          Sign in
        </Link>
      </header>

      {/* Hero. The thesis on the left, the product's own artefact on the right. */}
      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 pt-4 pb-20 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:gap-16 lg:pt-8">
          <div>
            <p className="font-mono text-[0.6875rem] uppercase tracking-[0.2em] text-fg-subtle">
              Hospital management system
            </p>
            <h1 className="mt-5 font-display text-4xl font-semibold leading-[1.05] tracking-tight text-balance sm:text-5xl lg:text-6xl">
              A hospital runs on handoffs.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-fg-muted text-pretty">
              Registration to triage. Triage to the consultant. The consultant to the lab, the pharmacy, the
              ward, the cashier. Vim&rsquo;s HMS is the record that travels with the patient through every one
              of them — so nobody has to ask the patient a question the hospital already knows the answer to.
            </p>

            <div id="sign-in" className="mt-9 flex flex-wrap items-center gap-4">
              <Link
                href="/login"
                className="rounded-lg bg-[color:var(--color-accent-solid)] px-6 py-3 font-medium text-[color:var(--color-accent-on-solid)] transition-colors hover:bg-[color:var(--color-accent-solid-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--border-focus)]"
              >
                Sign in
              </Link>
              <p className="font-mono text-xs uppercase tracking-[0.14em] text-fg-subtle">
                One door for every role
              </p>
            </div>
          </div>

          <LandingBoard />
        </section>

        {/* The pathway. A real sequence, so it is numbered; the order is the content. */}
        <section className="border-t border-default bg-layer-1/40">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
            <h2 className="font-mono text-[0.6875rem] uppercase tracking-[0.2em] text-fg-subtle">
              One patient, one record
            </h2>
            <ol className="mt-8 grid gap-px overflow-hidden rounded-xl border border-default bg-[color:var(--border-default)] sm:grid-cols-2 lg:grid-cols-5">
              {PATHWAY.map((stage, index) => (
                <li key={stage.step} className="bg-canvas p-5">
                  <p className="font-mono text-[0.6875rem] tabular-nums text-fg-subtle">
                    {String(index + 1).padStart(2, '0')}
                  </p>
                  <p className="mt-3 font-display text-base font-semibold tracking-tight">{stage.step}</p>
                  <p className="mt-2 text-sm leading-relaxed text-fg-muted">{stage.detail}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Wayfinding. Every one of these leads to the same login. */}
        <section className="border-t border-default">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
            <h2 className="font-display text-2xl font-semibold tracking-tight">Where do you work?</h2>
            <p className="mt-3 max-w-2xl text-fg-muted">
              Everyone signs in at the same screen. Your roles, your branch and your home screen come from
              your account — you never have to pick them.
            </p>

            <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {DESTINATIONS.map((destination) => {
                const shared =
                  'flex h-full flex-col rounded-xl border p-5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--border-focus)]';
                return (
                  <li key={destination.name}>
                    {destination.href === undefined ? (
                      <div className={`${shared} border-default bg-layer-1/40`}>
                        <p className="font-display text-base font-semibold tracking-tight text-fg-muted">
                          {destination.name}
                        </p>
                        <p className="mt-2 text-sm leading-relaxed text-fg-subtle">{destination.who}</p>
                        <p className="mt-4 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-fg-subtle">
                          {destination.note}
                        </p>
                      </div>
                    ) : (
                      <Link
                        href={destination.href}
                        className={`${shared} border-strong bg-layer-1 hover:bg-layer-2`}
                      >
                        <p className="font-display text-base font-semibold tracking-tight">
                          {destination.name}
                        </p>
                        <p className="mt-2 text-sm leading-relaxed text-fg-muted">{destination.who}</p>
                        <p className="mt-4 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-[color:var(--color-accent-fg)]">
                          Sign in &rarr;
                        </p>
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-t border-default">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p className="font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-fg-subtle">
            ABDM-ready · NABH-aligned · DPDP 2023 · GST
          </p>
          <p className="text-sm text-fg-subtle">
            Vim&rsquo;s HMS by VIMS ENTERPRISE. Cloud, on-premise or hybrid.
          </p>
        </div>
      </footer>
    </div>
  );
}
