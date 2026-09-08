import Link from 'next/link';

import { AssistantWidget } from './landing/assistant/assistant-widget';
import { CountUp } from './landing/count-up';
import { DESTINATIONS, DOMAINS, INSTRUMENTS, PATHWAY, RULES, STANDARDS } from './landing/content';
import { QueueBoard } from './landing/queue-board';
import { Reveal } from './landing/reveal';
import { SignalTrace } from './landing/signal-trace';

/**
 * The front door.
 *
 * Two things this page deliberately is not. It is not a role picker: everyone
 * signs in at `/login` whoever they are, and the system resolves roles and
 * branch scope from the credential. A picker that actually set a role would be
 * a privilege-escalation surface built into the home page, so the groups below
 * are wayfinding — they tell a ward nurse this is the right building and then
 * hand them the one door.
 *
 * And it is not a brochure. Every figure in the instrument strip was counted
 * from this repository (the commands are recorded in `landing/content.ts`), and
 * every rule quoted in "What the database refuses" is the text a Postgres
 * trigger actually raises. A hospital system that overstates itself on its own
 * landing page has said something about how it will behave at 3 a.m.
 *
 * The page is rendered dark. `CLAUDE.md` §5 puts clinical work on the light
 * theme and reserves dark for boards and analytics; this is a board, not a
 * charting screen, and it is the surface most often shown on a lobby display or
 * a phone in daylight.
 *
 * Motion: no animation library. `CLAUDE.md` §2 locks the stack behind an ADR,
 * and a fade, a rise and a stroke sweep are the platform's own primitives —
 * IntersectionObserver, the Web Animations API and a CSS keyframe. All of it is
 * behind `prefers-reduced-motion`, and none of it gates content.
 */

const SECTION = 'mx-auto max-w-6xl px-5 sm:px-8';
const EYEBROW = 'font-mono text-[0.6875rem] uppercase tracking-[0.2em] text-fg-subtle';
const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--border-focus)]';

export default function LandingPage() {
  return (
    <div data-theme="dark" className="min-h-dvh bg-canvas text-fg-default">
      <a
        href="#sign-in"
        className={`sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-layer-3 focus:px-4 focus:py-2 ${FOCUS}`}
      >
        Skip to sign in
      </a>

      {/* Sticky, hairline, translucent. The header of an instrument, not a
          marketing bar: it stays out of the way and never grows on scroll. */}
      <header className="sticky top-0 z-40 border-b border-default bg-[color:var(--bg-canvas)]/80 backdrop-blur-md">
        <div className={`${SECTION} flex items-center justify-between gap-4 py-4`}>
          <p className="font-display text-sm font-semibold tracking-tight">
            Vim&rsquo;s HMS
            <span className="ms-2 hidden font-mono text-[0.625rem] font-normal uppercase tracking-[0.18em] text-fg-subtle sm:inline">
              by VIMS Enterprise
            </span>
          </p>

          <nav aria-label="Sections" className="hidden items-center gap-7 md:flex">
            {[
              ['Coverage', '#coverage'],
              ['Safety', '#safety'],
              ['Standards', '#standards'],
            ].map(([label, href]) => (
              <a
                key={href}
                href={href}
                className={`font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-fg-muted transition-colors hover:text-fg-default ${FOCUS}`}
              >
                {label}
              </a>
            ))}
          </nav>

          <Link
            href="/login"
            className={`rounded-lg border border-strong px-4 py-2 font-mono text-xs uppercase tracking-[0.14em] transition-colors hover:bg-layer-2 ${FOCUS}`}
          >
            Sign in
          </Link>
        </div>
      </header>

      <main>
        {/* ── Hero ─────────────────────────────────────────────────────────── */}
        <section className="relative isolate overflow-hidden border-b border-default">
          <SignalTrace />
          <div
            className={`${SECTION} grid items-center gap-12 pt-16 pb-40 lg:grid-cols-[1.05fr_1fr] lg:gap-16 lg:pt-24 lg:pb-48`}
          >
            <Reveal>
              <p className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${EYEBROW}`}>
                <span
                  className="inline-block size-1.5 rounded-full motion-safe:animate-pulse"
                  style={{ backgroundColor: 'var(--color-success-solid)' }}
                  aria-hidden="true"
                />
                Multi-tenant · On-premise, cloud or hybrid
              </p>

              <h1 className="mt-6 font-display text-4xl font-semibold leading-[1.03] tracking-tight text-balance sm:text-5xl lg:text-6xl">
                A hospital runs on handoffs.
              </h1>

              <p className="mt-6 max-w-xl text-lg leading-relaxed text-fg-muted text-pretty">
                Registration to triage. Triage to the consultant. The consultant to the lab, the pharmacy, the
                ward, the cashier. Vim&rsquo;s HMS is the record that travels with the patient through every
                one of them — so nobody has to ask the patient a question the hospital already knows the
                answer to.
              </p>

              <div id="sign-in" className="mt-9 flex flex-wrap items-center gap-3">
                <Link
                  href="/login"
                  className={`rounded-lg bg-[color:var(--color-accent-solid)] px-6 py-3 font-medium text-[color:var(--color-accent-on-solid)] transition-colors hover:bg-[color:var(--color-accent-solid-hover)] ${FOCUS}`}
                >
                  Sign in
                </Link>
                <a
                  href="#safety"
                  className={`rounded-lg border border-strong px-6 py-3 font-medium text-fg-default transition-colors hover:bg-layer-2 ${FOCUS}`}
                >
                  What it refuses to do
                </a>
              </div>

              <p className="mt-5 font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-fg-subtle">
                One door for every role
              </p>
            </Reveal>

            <Reveal delay={140}>
              <QueueBoard />
            </Reveal>
          </div>
        </section>

        {/* ── The instrument strip ─────────────────────────────────────────── */}
        <section aria-labelledby="built" className="border-b border-default bg-layer-1/40">
          <div className={`${SECTION} py-16`}>
            <h2 id="built" className={EYEBROW}>
              Counted from the repository, not rounded
            </h2>
            {/* A list, not a description list.
                `<dl>` was the first instinct — term and definition — but each
                cell here is a value, a label *and* a sentence, and a `<dl>`
                wrapper may contain only `<dt>` and `<dd>`. Axe caught it. The
                alternatives were to contort the markup with CSS `order` so the
                number could still come first visually, or to admit this is a
                list of six things. It is a list of six things. */}
            <ul className="mt-8 grid gap-px overflow-hidden rounded-xl border border-default bg-[color:var(--border-default)] sm:grid-cols-2 lg:grid-cols-3">
              {INSTRUMENTS.map((instrument, index) => (
                <Reveal key={instrument.label} as="li" delay={index * 70} className="bg-canvas p-6">
                  <p className="font-display text-4xl font-semibold tracking-tight text-[color:var(--color-accent-fg)]">
                    <CountUp value={instrument.value} suffix={instrument.suffix ?? ''} />
                  </p>
                  <p className="mt-2 font-display text-base font-semibold tracking-tight">
                    {instrument.label}
                  </p>
                  <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{instrument.note}</p>
                </Reveal>
              ))}
            </ul>
          </div>
        </section>

        {/* ── The pathway ──────────────────────────────────────────────────── */}
        <section aria-labelledby="pathway" className="border-b border-default">
          <div className={`${SECTION} py-16`}>
            <h2 id="pathway" className={EYEBROW}>
              One patient, one record
            </h2>
            <ol className="mt-8 grid gap-px overflow-hidden rounded-xl border border-default bg-[color:var(--border-default)] sm:grid-cols-2 lg:grid-cols-5">
              {PATHWAY.map((stage, index) => (
                <Reveal key={stage.step} as="li" delay={index * 80} className="bg-canvas p-5">
                  <p className="font-mono text-[0.6875rem] tabular-nums text-[color:var(--color-accent-fg)]">
                    {String(index + 1).padStart(2, '0')}
                  </p>
                  <p className="mt-3 font-display text-base font-semibold tracking-tight">{stage.step}</p>
                  <p className="mt-2 text-sm leading-relaxed text-fg-muted">{stage.detail}</p>
                </Reveal>
              ))}
            </ol>
          </div>
        </section>

        {/* ── Coverage ─────────────────────────────────────────────────────── */}
        <section id="coverage" aria-labelledby="coverage-h" className="scroll-mt-16 border-b border-default">
          <div className={`${SECTION} py-20`}>
            <Reveal>
              <p className={EYEBROW}>Eight domains</p>
              <h2
                id="coverage-h"
                className="mt-4 max-w-2xl font-display text-3xl font-semibold leading-tight tracking-tight text-balance sm:text-4xl"
              >
                The whole hospital, or the part of it you have licensed.
              </h2>
              <p className="mt-4 max-w-2xl leading-relaxed text-fg-muted text-pretty">
                Every module is behind a feature flag and a licence entitlement. A fifty-bed nursing home runs
                the four it needs; a group of tertiary centres runs all eight across every branch, with the
                same schema underneath.
              </p>
            </Reveal>

            <ul className="mt-12 grid gap-4 md:grid-cols-2">
              {DOMAINS.map((domain, index) => (
                <Reveal
                  key={domain.index}
                  as="li"
                  delay={(index % 2) * 90}
                  className="group flex h-full gap-5 rounded-xl border border-default bg-layer-1/50 p-6 transition-colors hover:border-[color:var(--border-strong)] hover:bg-layer-2/60"
                >
                  <p
                    className="shrink-0 font-mono text-sm tabular-nums text-fg-subtle transition-colors group-hover:text-[color:var(--color-accent-fg)]"
                    aria-hidden="true"
                  >
                    {domain.index}
                  </p>
                  <div>
                    <h3 className="font-display text-lg font-semibold tracking-tight">{domain.name}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-fg-muted text-pretty">{domain.detail}</p>
                  </div>
                </Reveal>
              ))}
            </ul>
          </div>
        </section>

        {/* ── What the database refuses ────────────────────────────────────── */}
        <section
          id="safety"
          aria-labelledby="safety-h"
          className="scroll-mt-16 border-b border-default bg-sunken"
        >
          <div className={`${SECTION} py-20`}>
            <Reveal>
              <p className={EYEBROW}>Patient safety</p>
              <h2
                id="safety-h"
                className="mt-4 max-w-3xl font-display text-3xl font-semibold leading-tight tracking-tight text-balance sm:text-4xl"
              >
                Some rules are not settings. They are shapes in the schema.
              </h2>
              <p className="mt-4 max-w-2xl leading-relaxed text-fg-muted text-pretty">
                A rule enforced in a form is a rule until somebody writes a script. These are enforced in
                PostgreSQL — triggers, constraints and, in one case, the absence of a column. The proof that a
                value cannot be overridden is that nothing in the system can express overriding it.
              </p>
            </Reveal>

            <ul className="mt-12 grid gap-4 lg:grid-cols-2">
              {RULES.map((rule, index) => (
                <Reveal
                  key={rule.reference}
                  as="li"
                  delay={(index % 2) * 90}
                  className="flex h-full flex-col rounded-xl border border-default bg-layer-1 p-6 sm:p-7"
                >
                  <div className="flex items-center justify-between gap-4">
                    <p className="font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-[color:var(--color-danger-fg)]">
                      {rule.law}
                    </p>
                    <p className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-fg-subtle">
                      {rule.reference}
                    </p>
                  </div>

                  <h3 className="mt-4 font-display text-xl font-semibold leading-snug tracking-tight text-balance">
                    {rule.title}
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-fg-muted text-pretty">{rule.body}</p>

                  <p className="mt-5 border-s-2 border-[color:var(--color-accent-border)] ps-4 text-sm leading-relaxed text-fg-default text-pretty">
                    {rule.enforcement}
                  </p>
                </Reveal>
              ))}
            </ul>
          </div>
        </section>

        {/* ── Standards ────────────────────────────────────────────────────── */}
        <section
          id="standards"
          aria-labelledby="standards-h"
          className="scroll-mt-16 border-b border-default"
        >
          <div className={`${SECTION} py-20`}>
            <Reveal>
              <p className={EYEBROW}>Built for India, architected for anywhere</p>
              <h2
                id="standards-h"
                className="mt-4 max-w-2xl font-display text-3xl font-semibold leading-tight tracking-tight text-balance sm:text-4xl"
              >
                The standards are in the schema, not in a compliance appendix.
              </h2>
            </Reveal>

            <dl className="mt-12 grid gap-px overflow-hidden rounded-xl border border-default bg-[color:var(--border-default)] sm:grid-cols-2 lg:grid-cols-4">
              {STANDARDS.map((standard, index) => (
                <Reveal key={standard.code} as="div" delay={(index % 4) * 70} className="bg-canvas p-5">
                  <dt className="font-mono text-xs uppercase tracking-[0.16em] text-[color:var(--color-accent-fg)]">
                    {standard.code}
                  </dt>
                  <dd className="mt-2 text-sm leading-relaxed text-fg-muted">{standard.detail}</dd>
                </Reveal>
              ))}
            </dl>
          </div>
        </section>

        {/* ── Wayfinding. Every one of these leads to the same login. ──────── */}
        <section aria-labelledby="where" className="border-b border-default">
          <div className={`${SECTION} py-20`}>
            <Reveal>
              <h2 id="where" className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
                Where do you work?
              </h2>
              <p className="mt-4 max-w-2xl leading-relaxed text-fg-muted text-pretty">
                Everyone signs in at the same screen. Your roles, your branch and your home screen come from
                your account — you never have to pick them.
              </p>
            </Reveal>

            <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {DESTINATIONS.map((destination, index) => {
                const shared = `flex h-full flex-col rounded-xl border p-5 transition-colors ${FOCUS}`;
                return (
                  <Reveal key={destination.name} as="li" delay={(index % 3) * 80}>
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
                  </Reveal>
                );
              })}
            </ul>
          </div>
        </section>
      </main>

      {/* Renders nothing until `/api/assistant/config` names a hospital for it.
          This page is prerendered, so the widget cannot be handed the id from
          the environment here — `next build` would freeze it and an operator
          setting the variable on their own server would get no assistant and no
          error. It asks at runtime instead. */}
      <AssistantWidget />

      <footer>
        <div
          className={`${SECTION} flex flex-col gap-4 py-10 sm:flex-row sm:items-center sm:justify-between`}
        >
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
