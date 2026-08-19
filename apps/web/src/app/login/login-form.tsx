'use client';

import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import { ApiProblem, apiFetch } from '@/lib/api';

interface LoginFormProps {
  readonly nextPath: Promise<{ next?: string }>;
}

/**
 * The sign-in form.
 *
 * Two details are deliberate and easy to get wrong:
 *
 * The error is rendered from problem+json, including its `reference`. A user at
 * 3 a.m. cannot debug a failure, but they can read eight characters to the
 * helpdesk, and that is what turns "it didn't work" into a findable request.
 *
 * The submit button reports busy state rather than disappearing, and the fields
 * stay populated on failure. Clearing a password field after a failed attempt is
 * a small cruelty that produces more failed attempts — and this form locks the
 * account after five.
 */
export function LoginForm({ nextPath }: LoginFormProps): React.JSX.Element {
  const router = useRouter();
  const params = use(nextPath);
  const hospitalFieldId = useId();
  const identifierFieldId = useId();
  const passwordFieldId = useId();
  const errorId = useId();

  const [hospitalId, setHospitalId] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { hospitalId, identifier, password },
      });
      // `next` is attacker-controllable (it comes from the query string), so it
      // is validated as a same-origin absolute path before use — an open
      // redirect on a login screen is a credible phishing vector. `typedRoutes`
      // cannot know that at compile time, hence the narrow cast after the check.
      const requested = params.next;
      const target = (
        typeof requested === 'string' && requested.startsWith('/') && !requested.startsWith('//')
          ? requested
          : '/dashboard'
      ) as Route;
      router.replace(target);
      router.refresh();
    } catch (error) {
      setProblem(error instanceof ApiProblem ? error : null);
    } finally {
      setBusy(false);
    }
  }

  const fieldErrors = problem?.fieldErrors ?? new Map<string, string>();

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      noValidate
      className="rounded-lg border border-control bg-layer-1 p-6 shadow-sm"
    >
      {problem && (
        <div
          id={errorId}
          role="alert"
          data-testid="login-error"
          className="mb-5 rounded-md border border-danger-border bg-danger-surface p-3 text-sm text-danger-fg"
        >
          <p className="font-medium">{problem.problem.title}</p>
          {problem.problem.detail && <p className="mt-1">{problem.problem.detail}</p>}
          {problem.problem.nextAction && <p className="mt-1">{problem.problem.nextAction}</p>}
          <p className="mt-2 font-mono text-xs text-fg-subtle">Reference: {problem.reference}</p>
        </div>
      )}

      <div className="space-y-4">
        <Field
          id={hospitalFieldId}
          label="Hospital"
          hint="Provided by your administrator"
          value={hospitalId}
          onChange={setHospitalId}
          autoComplete="organization"
          error={fieldErrors.get('hospitalId')}
        />
        <Field
          id={identifierFieldId}
          label="Username, email or employee ID"
          value={identifier}
          onChange={setIdentifier}
          autoComplete="username"
          autoFocus
          error={fieldErrors.get('identifier')}
        />
        <Field
          id={passwordFieldId}
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          error={fieldErrors.get('password')}
        />
      </div>

      <button
        type="submit"
        disabled={busy}
        aria-busy={busy}
        {...(problem ? { 'aria-describedby': errorId } : {})}
        className="mt-6 h-11 w-full rounded-md bg-accent-solid text-accent-on-solid font-medium transition-opacity disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

function Field(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  hint?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  error?: string | undefined;
}): React.JSX.Element {
  const hintId = `${props.id}-hint`;
  const errorId = `${props.id}-error`;
  const describedBy = [props.hint ? hintId : null, props.error ? errorId : null]
    .filter((v): v is string => v !== null)
    .join(' ');

  return (
    <div>
      <label htmlFor={props.id} className="mb-1 block text-sm font-medium">
        {props.label}
      </label>
      <input
        id={props.id}
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        autoComplete={props.autoComplete}
        autoFocus={props.autoFocus}
        aria-invalid={props.error ? true : undefined}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        className="h-11 w-full rounded-md border border-control bg-layer-1 px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      />
      {props.hint && (
        <p id={hintId} className="mt-1 text-xs text-fg-subtle">
          {props.hint}
        </p>
      )}
      {props.error && (
        <p id={errorId} className="mt-1 text-xs text-danger-fg">
          {props.error}
        </p>
      )}
    </div>
  );
}
