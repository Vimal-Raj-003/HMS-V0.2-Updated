import type { Metadata } from 'next';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: "Sign in · Vim's HMS" };

/**
 * `docs/05`: one login screen for every role. The system identifies the user,
 * resolves their roles and branch scope, and routes them to their home
 * workspace — the user never picks "what kind of user am I", because they get it
 * wrong and because the answer is already known.
 */
export default function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-[26rem]">
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Vim&rsquo;s HMS</h1>
          <p className="mt-1 text-sm text-fg-subtle">by VIMS ENTERPRISE</p>
        </header>
        <LoginForm nextPath={searchParams} />
      </div>
    </main>
  );
}
