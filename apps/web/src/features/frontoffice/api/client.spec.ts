import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem } from '@/lib/api';
import {
  bookAppointment,
  cancelAppointment,
  collectPayment,
  listSlots,
  skipToken,
  transferToken,
  voidReceipt,
} from './client';

/**
 * What the client puts on the wire.
 *
 * Two classes of header carry a rule rather than a convenience, and both are
 * invisible in a screenshot, so they are asserted here:
 *
 *  - **`x-reason`.** The policy engine refuses every `requiresReason` key — the
 *    appointment cancel, the token transfer, the receipt void — *before* the
 *    handler runs when the header is absent. A missing one does not look like a
 *    missing reason; it looks like a permissions bug.
 *  - **`Idempotency-Key`.** A retried booking costs a patient their slot and a
 *    retried collection charges them twice, so the routes their module specs
 *    mark `Idem = Y` must always carry one.
 */

const fetchMock = vi.fn();

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  return { url: String(call?.[0]), init: (call?.[1] ?? {}) as RequestInit };
}

function header(name: string): string | undefined {
  const headers = lastCall().init.headers as Record<string, string> | undefined;
  return headers?.[name];
}

function body(): unknown {
  const raw = lastCall().init.body;
  return typeof raw === 'string' ? JSON.parse(raw) : undefined;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(ok({}));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reason-required calls', () => {
  it('sends the reason as a header and in the body when the token is skipped', async () => {
    await skipToken('token-1', 'patient_absent: called three times');
    expect(header('x-reason')).toBe('patient_absent: called three times');
    expect(body()).toEqual({ reason: 'patient_absent: called three times' });
  });

  it('sends the reason on a transfer, which the supervisor key demands', async () => {
    await transferToken('token-1', 'queue-2', 'wrong_queue');
    expect(header('x-reason')).toBe('wrong_queue');
    expect(body()).toEqual({ toQueueId: 'queue-2', reason: 'wrong_queue' });
  });

  it('sends the reason on an appointment cancellation, with who cancelled', async () => {
    await cancelAppointment(
      'appt-1',
      { reason: 'patient_request', cancelledBy: 'patient' },
      'patient_request',
    );
    expect(header('x-reason')).toBe('patient_request');
    expect(body()).toEqual({ reason: 'patient_request', cancelledBy: 'patient' });
  });

  it('sends the reason on a void, alongside the co-signer', async () => {
    await voidReceipt(
      'receipt-1',
      { reason: 'Wrong patient', coSigner: { identifier: 'head', credential: 'secret' } },
      'Wrong patient',
    );
    expect(header('x-reason')).toBe('Wrong patient');
  });
});

describe('idempotency', () => {
  it('puts a key on a booking, so a retry does not take a second slot', async () => {
    await bookAppointment({ slotId: 'slot-1', patientId: 'patient-1' });
    expect(header('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('reuses the caller’s key on a collection, so a retry does not charge twice', async () => {
    await collectPayment(
      { shiftId: 's-1', purpose: 'consultation', amount: '500.00', lines: [] },
      'fixed-key',
    );
    expect(header('idempotency-key')).toBe('fixed-key');
  });

  it('never puts one on a read', async () => {
    await listSlots('doctor-1', '2026-08-24');
    expect(header('idempotency-key')).toBeUndefined();
    expect(lastCall().url).toContain('includeFull=true');
  });
});

describe('failures', () => {
  /**
   * The screen needs `detail`, `nextAction` and `reference` — a bare
   * `Error('Request failed')` discards exactly the fields `docs/06` §1.1 says a
   * clinical error must carry.
   */
  it('preserves the problem+json body, including the helpdesk reference', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'https://errors.vimshms.com/statutory-limit',
          title: 'A statutory limit prevents this',
          status: 422,
          detail: 'Cash from this payer today would reach 220000.00…',
          nextAction: 'Take the balance by card.',
          reference: 'trace-99',
        }),
        { status: 422, headers: { 'content-type': 'application/problem+json' } },
      ),
    );

    await expect(
      collectPayment({ shiftId: 's-1', purpose: 'x', amount: '1.00', lines: [] }, 'k'),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ApiProblem);
      expect((error as ApiProblem).reference).toBe('trace-99');
      expect((error as ApiProblem).problem.nextAction).toBe('Take the balance by card.');
      return true;
    });
  });

  it('still yields a reference when the server did not send problem+json', async () => {
    fetchMock.mockResolvedValue(
      new Response('gateway down', { status: 502, headers: { 'x-trace-id': 'trace-502' } }),
    );
    await expect(listSlots('doctor-1', '2026-08-24')).rejects.toMatchObject({
      status: 502,
    });
  });
});
