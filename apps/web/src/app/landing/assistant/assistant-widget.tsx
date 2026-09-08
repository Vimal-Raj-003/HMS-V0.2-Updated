'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { BookingForm } from './booking-form';
import type { AssistantIntent, ChatMessage, ChatResponse } from './types';

/**
 * The assistant on the landing page.
 *
 * ── What it can and cannot do ──────────────────────────────────────────────
 *
 * It answers questions about the hospital and it opens a booking form. It does
 * not book. The API it talks to gives a language model no tools at all, so no
 * sentence typed into this box can become a statement against the database —
 * the model's entire authority is over prose, and the form below is an ordinary
 * validated POST that a person fills in.
 *
 * ── Why an emergency reply looks different ─────────────────────────────────
 *
 * When the API returns `safety: 'emergency'` the visitor has said something
 * like "chest pain", and the reply is rendered in the danger colour with an
 * assertive live region rather than a polite one — a screen-reader user in that
 * situation should be interrupted, which is exactly what `aria-live="assertive"`
 * is for and exactly when it is justified.
 */

const GREETING: ChatMessage = {
  role: 'assistant',
  content:
    'Hello. I can tell you which departments we have and take an appointment request for the front office to call you back about.\n\nIf this is an emergency, please call 112 or come straight to our Emergency Department — do not wait for me.',
};

const OPENING_SUGGESTIONS = ['Which departments do you have?', 'Book an appointment'] as const;

export function AssistantWidget() {
  /**
   * Resolved at runtime, not passed down.
   *
   * `/` is prerendered at build time, so a `hospitalId` read from the
   * environment in the page's server component was frozen by `next build` and
   * never read again — an operator who set the variable on their server got no
   * assistant and no error. `/api/assistant/config` is a dynamic route handler,
   * so it reads the real environment on the real machine. Until it answers, and
   * for ever if it says the assistant is not configured, nothing renders.
   */
  const [hospitalId, setHospitalId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<readonly ChatMessage[]>([GREETING]);
  const [suggestions, setSuggestions] = useState<readonly string[]>(OPENING_SUGGESTIONS);
  const [pending, setPending] = useState(false);
  const [lastSafety, setLastSafety] = useState<ChatResponse['safety']>('none');
  const [booking, setBooking] = useState<AssistantIntent | null>(null);

  const panelId = useId();
  const titleId = useId();
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/assistant/config', { signal: controller.signal })
      .then(async (r) => (r.ok ? ((await r.json()) as { configured: boolean; hospitalId?: string }) : null))
      .then((config) => {
        if (config?.configured === true && typeof config.hospitalId === 'string') {
          setHospitalId(config.hospitalId);
        }
      })
      .catch(() => {
        // No assistant is the correct outcome when we cannot tell which
        // hospital it would speak for.
      });
    return () => {
      controller.abort();
    };
  }, []);

  // Focus into the panel on open and back to the launcher on close. A dialog
  // that opens without moving focus strands a keyboard user at the bottom of
  // the page with no way to reach what just appeared.
  useEffect(() => {
    if (open) inputRef.current?.focus();
    else launcherRef.current?.focus();
  }, [open]);

  // Escape closes, from anywhere inside the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Keep the newest message in view without yanking the whole page.
  useEffect(() => {
    const log = logRef.current;
    if (log === null) return;
    log.scrollTop = log.scrollHeight;
  }, [messages, pending]);

  const send = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (trimmed === '' || pending || hospitalId === null) return;

      const next: ChatMessage[] = [...messages, { role: 'user', content: trimmed }];
      setMessages(next);
      setSuggestions([]);
      setPending(true);

      try {
        const response = await fetch('/api/assistant/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hospitalId, messages: next.slice(-24) }),
        });
        const payload: unknown = await response.json();

        if (!response.ok) {
          // `detail` is the RFC 9457 field, and it is written for a person to
          // read — the API's rate-limit and offline messages both arrive here.
          // Narrowed rather than cast: this is a body from the network.
          const detail =
            typeof payload === 'object' &&
            payload !== null &&
            'detail' in payload &&
            typeof payload.detail === 'string'
              ? payload.detail
              : 'Something went wrong at our end. Please call the hospital directly.';
          setMessages([...next, { role: 'assistant', content: detail }]);
          setLastSafety('none');
          return;
        }

        const data = payload as ChatResponse;
        setMessages([...next, { role: 'assistant', content: data.reply }]);
        setSuggestions(data.suggestions);
        setLastSafety(data.safety);
        // An emergency reply never opens a booking form on top of itself.
        if (data.intent !== null && data.safety === 'none') setBooking(data.intent);
      } catch {
        setMessages([
          ...next,
          {
            role: 'assistant',
            content:
              'I cannot reach the hospital’s systems just now. Please call the hospital directly, or try again in a few minutes.',
          },
        ]);
        setLastSafety('none');
      } finally {
        setPending(false);
        inputRef.current?.focus();
      }
    },
    [hospitalId, messages, pending],
  );

  if (hospitalId === null) return null;

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        onClick={() => {
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-controls={panelId}
        className="fixed bottom-5 end-5 z-50 flex items-center gap-2 rounded-full border border-strong bg-layer-2 px-5 py-3 font-mono text-xs uppercase tracking-[0.14em] text-fg-default shadow-e4 transition-colors hover:bg-layer-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--border-focus)]"
      >
        <span
          className="inline-block size-1.5 rounded-full motion-safe:animate-pulse"
          style={{ backgroundColor: 'var(--color-success-solid)' }}
          aria-hidden="true"
        />
        {open ? 'Close' : 'Ask a question'}
      </button>

      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        hidden={!open}
        className="fixed inset-x-0 bottom-0 z-50 flex h-[min(38rem,88dvh)] flex-col border-t border-strong bg-layer-1 shadow-e4 sm:inset-x-auto sm:bottom-24 sm:end-5 sm:h-[34rem] sm:w-[26rem] sm:rounded-2xl sm:border"
      >
        <div className="flex items-start justify-between gap-4 border-b border-default p-4">
          <div>
            <h2 id={titleId} className="font-display text-sm font-semibold tracking-tight">
              Hospital assistant
            </h2>
            <p className="mt-1 font-mono text-[0.625rem] uppercase tracking-[0.14em] text-fg-subtle">
              Not medical advice · Emergency? Call 112
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
            }}
            className="rounded-md px-2 py-1 text-sm text-fg-muted transition-colors hover:bg-layer-3 hover:text-fg-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--border-focus)]"
          >
            Close
          </button>
        </div>

        <div
          ref={logRef}
          className="flex-1 space-y-4 overflow-y-auto p-4"
          // Polite for an ordinary answer; assertive when the reply is "call an
          // ambulance", which is the case this attribute exists for.
          aria-live={lastSafety === 'emergency' ? 'assertive' : 'polite'}
          aria-busy={pending}
        >
          {messages.map((message, index) => (
            <Bubble
              // Messages are append-only and never reordered, so the index is a
              // stable identity here; content is not, because a visitor can ask
              // the same question twice.
              key={index}
              message={message}
              danger={lastSafety === 'emergency' && index === messages.length - 1}
            />
          ))}

          {pending ? (
            <p className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-fg-subtle">
              <span className="motion-safe:animate-pulse">Thinking…</span>
            </p>
          ) : null}

          {booking !== null ? (
            <BookingForm
              hospitalId={hospitalId}
              intent={booking}
              onDone={(receipt) => {
                setBooking(null);
                setMessages((current) => [...current, { role: 'assistant', content: receipt.message }]);
              }}
              onCancel={() => {
                setBooking(null);
              }}
            />
          ) : null}
        </div>

        {suggestions.length > 0 && !pending ? (
          <div className="flex flex-wrap gap-2 border-t border-default px-4 py-3">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => {
                  void send(suggestion);
                }}
                className="rounded-full border border-default px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-[color:var(--border-strong)] hover:text-fg-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--border-focus)]"
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}

        <form
          className="flex items-center gap-2 border-t border-default p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const input = inputRef.current;
            if (input === null) return;
            const value = input.value;
            input.value = '';
            void send(value);
          }}
        >
          <label htmlFor={`${panelId}-input`} className="sr-only">
            Your question
          </label>
          <input
            ref={inputRef}
            id={`${panelId}-input`}
            name="question"
            type="text"
            autoComplete="off"
            maxLength={2000}
            placeholder="Ask about departments or book a visit"
            className="min-w-0 flex-1 rounded-lg border border-control bg-canvas px-3 py-2 text-sm text-fg-default placeholder:text-fg-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--border-focus)]"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-[color:var(--color-accent-solid)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-on-solid)] transition-colors hover:bg-[color:var(--color-accent-solid-hover)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--border-focus)]"
          >
            Send
          </button>
        </form>
      </div>
    </>
  );
}

function Bubble({ message, danger }: { readonly message: ChatMessage; readonly danger: boolean }) {
  const isUser = message.role === 'user';
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={[
          'max-w-[85%] whitespace-pre-wrap rounded-xl px-3.5 py-2.5 text-sm leading-relaxed',
          isUser
            ? 'bg-layer-3 text-fg-default'
            : danger
              ? 'border border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-surface)] text-[color:var(--color-danger-on-surface)]'
              : 'bg-layer-2 text-fg-muted',
        ].join(' ')}
      >
        <span className="sr-only">{isUser ? 'You said: ' : 'Assistant said: '}</span>
        {/* Rendered as text, never as markup. The reply can contain whatever a
            language model produced from whatever a stranger typed, and React
            escaping it is the reason that is merely untidy rather than an XSS. */}
        {message.content}
      </div>
    </div>
  );
}
