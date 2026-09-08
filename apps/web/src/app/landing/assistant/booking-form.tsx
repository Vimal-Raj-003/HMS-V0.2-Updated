'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { CONSENT_TEXT, type AssistantIntent, type PublicDirectory, type RequestReceipt } from './types';

/**
 * The form that actually submits an enquiry.
 *
 * ── Why this is a form and not a conversation ──────────────────────────────
 *
 * The assistant could have collected a name, a number and a date across four
 * chat turns, and it would have demoed better. It would also have meant a
 * language model deciding what went into a database row, which is the one thing
 * PE-009 refuses to allow. Here the fields are typed, validated by Zod on the
 * server, and visible to the person filling them in before they are sent.
 *
 * ── The two sentences that matter ──────────────────────────────────────────
 *
 * The consent checkbox is required and its wording is versioned alongside the
 * row (DPDP 2023 §6 — a consent nobody can reconstruct is not evidence). And
 * the panel says, before submission and again after it, that this is a request
 * rather than a booking. The commonest way a system like this hurts somebody is
 * by letting them believe they have an appointment and not turn up to anything.
 */

interface BookingFormProps {
  readonly hospitalId: string;
  readonly intent: AssistantIntent;
  readonly onDone: (receipt: RequestReceipt) => void;
  readonly onCancel: () => void;
}

/** Tomorrow, in the browser's zone — nobody enquires about yesterday. */
function tomorrow(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function BookingForm({ hospitalId, intent, onDone, onCancel }: BookingFormProps) {
  const id = useId();
  /**
   * Seeded with the department the visitor actually named, before the directory
   * has loaded.
   *
   * A controlled `<select>` whose `value` matches no `<option>` is a value the
   * browser silently drops, and React does not re-apply it when the options
   * arrive later because the prop never changed. So when the directory fetch
   * resolved after the form's first paint — which is most of the time on a cold
   * load — the form quietly reset to "No preference" for somebody who had just
   * typed "an appointment with Orthopaedics". It was worse than a visible bug:
   * it looked fine and discarded the one thing they had told us. An earlier
   * test passed only because a warm fetch happened to resolve first.
   *
   * Making the option exist from the first render removes the race rather than
   * narrowing it.
   */
  const [specialities, setSpecialities] = useState<PublicDirectory['specialities']>(() =>
    intent.specialityKey !== undefined && intent.specialityName !== undefined
      ? [
          {
            key: intent.specialityKey,
            code: '',
            name: intent.specialityName,
            telemedicineAllowed: true,
          },
        ]
      : [],
  );
  /**
   * Controlled, not `defaultValue`.
   *
   * The department list arrives after the first paint, so at that moment there
   * is no `<option>` matching the speciality the visitor named and the browser
   * silently falls back to the first one. The form then said "No preference"
   * to somebody who had just typed "an appointment with Orthopaedics" — it
   * looked fine and quietly discarded the one thing they had told us.
   */
  const [specialityKey, setSpecialityKey] = useState(intent.specialityKey ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // The department list is the hospital's own, so the enquiry names something
  // that exists rather than something the visitor typed.
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/assistant/directory?hospitalId=${encodeURIComponent(hospitalId)}`, {
      signal: controller.signal,
    })
      .then(async (r) => (r.ok ? ((await r.json()) as PublicDirectory) : null))
      .then((d) => {
        // The real list replaces the seed. It contains the seeded department
        // too — it came from this same directory — so the selection survives.
        if (d !== null && d.specialities.length > 0) setSpecialities(d.specialities);
      })
      .catch(() => {
        // A missing department list is not a reason to block the enquiry: the
        // field is optional and front office will ask on the phone anyway.
      });
    return () => {
      controller.abort();
    };
  }, [hospitalId]);

  return (
    <form
      className="rounded-xl border border-strong bg-layer-2 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (submitting) return;
        setSubmitting(true);
        setError(null);
        setFieldErrors(new Map());

        const data = new FormData(event.currentTarget);
        const value = (key: string): string | undefined => {
          const raw = data.get(key);
          const text = typeof raw === 'string' ? raw.trim() : '';
          return text === '' ? undefined : text;
        };

        const body = {
          hospitalId,
          name: value('name') ?? '',
          phone: value('phone') ?? '',
          email: value('email'),
          specialityKey: value('specialityKey'),
          preferredDate: value('preferredDate'),
          preferredPeriod: value('preferredPeriod'),
          reason: value('reason'),
          consent: data.get('consent') === 'on',
        };

        void (async () => {
          try {
            const response = await fetch('/api/assistant/appointment-requests', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            });
            const payload: unknown = await response.json();

            if (response.ok) {
              onDone(payload as RequestReceipt);
              return;
            }

            const problem = payload as {
              detail?: string;
              errors?: readonly { path: string; message: string }[];
            };
            const map = new Map<string, string>();
            for (const e of problem.errors ?? []) map.set(e.path, e.message);
            setFieldErrors(map);
            setError(
              map.size > 0
                ? 'Please check the highlighted fields.'
                : (problem.detail ??
                    'That did not go through. Please try again, or call the hospital directly.'),
            );
          } catch {
            setError('I could not send that just now. Please try again, or call the hospital directly.');
          } finally {
            setSubmitting(false);
          }
        })();
      }}
    >
      <p className="font-display text-sm font-semibold tracking-tight">Request an appointment</p>
      <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">
        This sends a request, not a confirmed appointment. Our front office will call you back to agree a
        time.
      </p>

      <div className="mt-4 space-y-3">
        <Field id={`${id}-name`} label="Your name" error={fieldErrors.get('name')}>
          <input
            ref={nameRef}
            id={`${id}-name`}
            name="name"
            required
            maxLength={120}
            autoComplete="name"
            className={inputClass(fieldErrors.has('name'))}
          />
        </Field>

        <Field
          id={`${id}-phone`}
          label="Phone number"
          hint="We will call you on this number."
          error={fieldErrors.get('phone')}
        >
          <input
            id={`${id}-phone`}
            name="phone"
            type="tel"
            required
            maxLength={20}
            autoComplete="tel"
            inputMode="tel"
            className={inputClass(fieldErrors.has('phone'))}
          />
        </Field>

        <Field id={`${id}-speciality`} label="Department" error={fieldErrors.get('specialityKey')}>
          <select
            id={`${id}-speciality`}
            name="specialityKey"
            value={specialityKey}
            onChange={(event) => {
              setSpecialityKey(event.target.value);
            }}
            className={inputClass(false)}
          >
            <option value="">No preference</option>
            {specialities.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field id={`${id}-date`} label="Preferred date" error={fieldErrors.get('preferredDate')}>
            <input
              id={`${id}-date`}
              name="preferredDate"
              type="date"
              min={tomorrow()}
              className={inputClass(false)}
            />
          </Field>
          <Field id={`${id}-period`} label="Time of day">
            <select
              id={`${id}-period`}
              name="preferredPeriod"
              defaultValue="any"
              className={inputClass(false)}
            >
              <option value="any">Any</option>
              <option value="morning">Morning</option>
              <option value="afternoon">Afternoon</option>
              <option value="evening">Evening</option>
            </select>
          </Field>
        </div>

        <Field
          id={`${id}-reason`}
          label="Reason for the visit"
          hint="Optional, and brief. Please do not write medical details here."
          error={fieldErrors.get('reason')}
        >
          <input
            id={`${id}-reason`}
            name="reason"
            maxLength={280}
            className={inputClass(fieldErrors.has('reason'))}
          />
        </Field>

        <label className="flex items-start gap-2.5 text-xs leading-relaxed text-fg-muted">
          <input
            name="consent"
            type="checkbox"
            required
            className="mt-0.5 size-4 shrink-0 accent-[color:var(--color-accent-solid)]"
          />
          <span>{CONSENT_TEXT}</span>
        </label>
      </div>

      {error !== null ? (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-surface)] px-3 py-2 text-xs text-[color:var(--color-danger-on-surface)]"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-[color:var(--color-accent-solid)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-on-solid)] transition-colors hover:bg-[color:var(--color-accent-solid-hover)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--border-focus)]"
        >
          {submitting ? 'Sending…' : 'Send request'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-2 text-sm text-fg-muted transition-colors hover:text-fg-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--border-focus)]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function inputClass(invalid: boolean): string {
  return [
    'w-full rounded-lg bg-canvas px-3 py-2 text-sm text-fg-default',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--border-focus)]',
    invalid ? 'border border-[color:var(--color-danger-border)]' : 'border border-control',
  ].join(' ');
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-fg-default">
        {label}
      </label>
      {hint !== undefined ? <p className="mt-0.5 text-[0.6875rem] text-fg-subtle">{hint}</p> : null}
      <div className="mt-1.5">{children}</div>
      {error !== undefined ? (
        <p className="mt-1 text-[0.6875rem] text-[color:var(--color-danger-fg)]">{error}</p>
      ) : null}
    </div>
  );
}
