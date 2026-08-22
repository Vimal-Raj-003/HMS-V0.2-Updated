import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '@/lib/api';
import {
  amendEncounter,
  createPrescription,
  evaluate,
  getAllergies,
  recordVitals,
  respondToAlert,
  updateEncounter,
} from './client';

/**
 * The wire behaviour of the clinical client.
 *
 * Three things are asserted here because they are invisible in a component test
 * and expensive to discover in production:
 *
 *  - **`Idempotency-Key` is sent on every write that has one.** The API's
 *    interceptor fails closed — a POST without the header is refused with 400 —
 *    so a missing header is not a subtle bug, it is a broken screen;
 *  - **`x-reason` is sent on the `requiresReason` keys.** The policy guard
 *    demands it *before* the handler runs, so omitting it is a 403 the user
 *    cannot act on;
 *  - **a `problem+json` refusal arrives as an `ApiProblem` with its extensions
 *    intact.** `ProblemCard` renders `nextAction` and `reference` from it, and a
 *    plain `Error` would lose exactly the fields a clinician needs.
 */

const fetchMock = vi.fn();

function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function refusal(): Response {
  return {
    ok: false,
    status: 422,
    headers: new Headers({ 'content-type': 'application/problem+json' }),
    json: () =>
      Promise.resolve({
        type: 'https://errors.vimshms.com/clinical-hard-stop',
        title: 'Stopped for patient safety',
        status: 422,
        reference: 'trace-1',
        detail: 'Documented anaphylaxis',
        nextAction: 'Change the prescription.',
        clinicalImpact: 'Anaphylaxis risk',
      }),
  } as unknown as Response;
}

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  return { url: String(call?.[0]), init: (call?.[1] ?? {}) as RequestInit };
}

/** The JSON body as sent, so an assertion reads the wire rather than an object. */
function lastBody(): string {
  const body = lastCall().init.body;
  return typeof body === 'string' ? body : '';
}

function header(name: string): string | undefined {
  const headers = lastCall().init.headers as Record<string, string> | undefined;
  return headers?.[name];
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('idempotency', () => {
  it('sends a key on an observation set, so a retried save is not a second reading', async () => {
    fetchMock.mockResolvedValue(ok({ id: 'v1' }));
    await recordVitals({ patientId: 'p1' }, 'key-123');
    expect(header('idempotency-key')).toBe('key-123');
  });

  it('sends a key on a prescription, so a retry is not a second script at the counter', async () => {
    fetchMock.mockResolvedValue(ok({ id: 'rx1' }));
    await createPrescription({ patientId: 'p1', items: [{ genericName: 'Amoxicillin' }] }, 'key-456');
    expect(header('idempotency-key')).toBe('key-456');
  });

  /**
   * `POST /cdss/evaluate` is deliberately not idempotent on the API side: every
   * call is a fresh evaluation against a context that may have changed, and
   * replaying a cached answer is precisely what a safety check must not do.
   */
  it('sends no key on a safety evaluation, which must never replay an answer', async () => {
    fetchMock.mockResolvedValue(ok({ alerts: [] }));
    await evaluate({ patientId: 'p1', items: [{ genericName: 'Amoxicillin' }] });
    expect(header('idempotency-key')).toBeUndefined();
  });

  it('sends no key on the autosave, which is a patch under an optimistic lock', async () => {
    fetchMock.mockResolvedValue(ok({ id: 'e1' }));
    await updateEncounter('e1', { version: 2 });
    expect(header('idempotency-key')).toBeUndefined();
    expect(lastCall().init.method).toBe('PATCH');
  });
});

describe('reason-bearing actions', () => {
  it('sends the amendment reason as a header as well as in the body', async () => {
    fetchMock.mockResolvedValue(ok({ id: 'e1' }));
    await amendEncounter('e1', { reason: 'Culture came back resistant.', note: { plan: 'Azithromycin' } });
    expect(header('x-reason')).toBe('Culture came back resistant.');
    expect(lastBody()).toContain('Culture came back resistant.');
  });

  it('sends a reason with a countersignature, and the coded reason in the body', async () => {
    fetchMock.mockResolvedValue(ok({ actionId: 'a1' }));
    await respondToAlert(
      'alert-1',
      { firedAt: '2026-08-22T09:00:00.000Z', kind: 'overridden', reasonCode: 'SPECIALIST_ADVICE' },
      'Countersigned after review',
    );
    expect(header('x-reason')).toBe('Countersigned after review');
    expect(lastBody()).toContain('SPECIALIST_ADVICE');
  });
});

describe('a refusal', () => {
  it('arrives with its detail, next action and reference intact', async () => {
    fetchMock.mockResolvedValue(refusal());
    await expect(
      createPrescription({ patientId: 'p1', items: [{ genericName: 'X' }] }),
    ).rejects.toBeInstanceOf(ApiProblem);

    fetchMock.mockResolvedValue(refusal());
    const error = await createPrescription({ patientId: 'p1', items: [{ genericName: 'X' }] }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiProblem);
    if (error instanceof ApiProblem) {
      expect(error.reference).toBe('trace-1');
      expect(error.problem.nextAction).toBe('Change the prescription.');
      expect(error.problem.clinicalImpact).toBe('Anaphylaxis risk');
    }
  });

  it('is never swallowed into an empty list', async () => {
    fetchMock.mockResolvedValue(refusal());
    await expect(getAllergies('p1')).rejects.toBeInstanceOf(ApiProblem);
  });
});

describe('the routes', () => {
  it('asks the versioned API through the same-origin proxy, with credentials', async () => {
    fetchMock.mockResolvedValue(ok([]));
    await getAllergies('p1');
    expect(lastCall().url).toBe('/api/v1/patients/p1/allergies');
    expect(lastCall().init.credentials).toBe('same-origin');
  });
});
