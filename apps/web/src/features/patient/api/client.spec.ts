import { describe, expect, it, vi } from 'vitest';
import {
  commitMerge,
  getPatientHistory,
  listPatientVisits,
  prepareMerge,
  registerPatient,
  searchPatients,
  unmerge,
  updatePatient,
} from './client';

/**
 * Three things this file exists to keep true, each of which fails silently and
 * expensively if it breaks:
 *
 *  1. **The reason travels twice** on every reason-required permission key. The
 *     policy engine reads the `x-reason` header *before* the handler runs, so
 *     omitting it turns an amendment into a 403 at a counter with a queue.
 *  2. **The idempotency key is present** on the three `@Idempotent()` routes. The
 *     interceptor fails closed with a 400, and the routes it guards are the ones
 *     a double-click would otherwise duplicate — a patient, or a merge.
 *  3. **Search sends exactly one criterion.** Each maps to a different index, and
 *     a query that ORs them together uses none of them on a three-million-row MPI.
 */

const apiFetch = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock('@/lib/api', () => ({ apiFetch, ApiProblem: class {} }));

const idempotentFetch = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock('./http', () => ({ idempotentFetch, newIdempotencyKey: () => 'test-key-0001' }));

interface Recorded {
  readonly path: string;
  readonly init: {
    readonly method?: string;
    readonly body?: unknown;
    readonly reason?: string;
    readonly idempotencyKey?: string;
  };
}

function last(mock: typeof apiFetch): Recorded {
  const calls = mock.mock.calls as [string, Recorded['init']][];
  const call = calls[calls.length - 1];
  if (call === undefined) throw new Error('the client was never called');
  return { path: call[0], init: call[1] ?? {} };
}

describe('search', () => {
  it('sends the mobile as `mobile`, not folded into the free-text parameter', async () => {
    await searchPatients({ mobile: '9845012345' });
    expect(last(apiFetch).path).toBe('/api/v1/patients?mobile=9845012345&limit=20');
  });

  it('widens a UHID search to merged records so an old card still resolves', async () => {
    await searchPatients({ uhid: '0021-45871', includeInactive: true });
    expect(last(apiFetch).path).toBe('/api/v1/patients?uhid=0021-45871&includeInactive=true&limit=20');
  });

  it('drops empty criteria rather than sending blanks the API would reject', async () => {
    await searchPatients({ q: '' });
    expect(last(apiFetch).path).toBe('/api/v1/patients?limit=20');
  });

  it('appends the cursor for the next page', async () => {
    await searchPatients({ q: 'sharma' }, 'cursor-1');
    expect(last(apiFetch).path).toBe('/api/v1/patients?q=sharma&cursor=cursor-1&limit=20');
  });

  it('asks a different module for the visit history, under its own permission', async () => {
    await listPatientVisits('p1');
    expect(last(apiFetch).path).toBe('/api/v1/visits?patientId=p1&limit=25');
  });

  it('reads the demographic history from the record’s own sub-resource', async () => {
    await getPatientHistory('p1');
    expect(last(apiFetch).path).toBe('/api/v1/patients/p1/history?limit=25');
  });
});

describe('registering', () => {
  it('always carries an idempotency key, because the route fails closed without one', async () => {
    await registerPatient({ firstName: 'Ramesh', gender: 'male', mobile: '9845012345' }, 'submission-1');
    const { path, init } = last(idempotentFetch);
    expect(path).toBe('/api/v1/patients');
    expect(init.method).toBe('POST');
    expect(init.idempotencyKey).toBe('submission-1');
  });

  it('sends no reason header for an ordinary registration', async () => {
    await registerPatient({ firstName: 'Ramesh', gender: 'male', mobile: '9845012345' }, 'submission-2');
    // An unnecessary reason would put a justification in the audit register for an
    // action nobody had to justify.
    expect(last(idempotentFetch).init.reason).toBeUndefined();
  });

  it('sends the override reason as a header as well as in the body', async () => {
    await registerPatient(
      {
        firstName: 'Ramesh',
        gender: 'male',
        mobile: '9845012345',
        overrideDuplicate: {
          acknowledgedPatientIds: ['p1'],
          reason: 'Different mother and address, checked the passport',
        },
      },
      'submission-3',
    );
    const { init } = last(idempotentFetch);
    // `patient.record.create_override` is `requiresReason`: the header satisfies
    // the policy, the body is written to `created_override_reason`.
    expect(init.reason).toBe('Different mother and address, checked the passport');
    expect(init.body).toMatchObject({
      overrideDuplicate: {
        acknowledgedPatientIds: ['p1'],
        reason: 'Different mother and address, checked the passport',
      },
    });
  });
});

describe('amending', () => {
  it('sends the reason twice: once for the guard, once for the demographic history', async () => {
    await updatePatient('p1', {
      version: 4,
      reason: 'Surname misspelled at registration; corrected against the passport',
      firstName: 'Ramesh',
    });
    const { path, init } = last(apiFetch);
    expect(path).toBe('/api/v1/patients/p1');
    expect(init.method).toBe('PATCH');
    expect(init.reason).toBe('Surname misspelled at registration; corrected against the passport');
    expect(init.body).toMatchObject({
      version: 4,
      reason: 'Surname misspelled at registration; corrected against the passport',
    });
  });

  it('sends the version it read, so a concurrent edit is a visible conflict', async () => {
    await updatePatient('p1', { version: 9, reason: 'Corrected the mobile number' });
    expect(last(apiFetch).init.body).toMatchObject({ version: 9 });
  });
});

describe('merging', () => {
  it('prepares without committing, and carries the reason and a key', async () => {
    await prepareMerge(
      {
        survivorId: 's',
        victimId: 'v',
        reason: 'Same person, second record at the ER desk',
        fieldChoices: {},
      },
      'merge-key-1',
    );
    const { path, init } = last(idempotentFetch);
    expect(path).toBe('/api/v1/patients/merge');
    expect(init.body).toMatchObject({ step: 'prepare', survivorId: 's', victimId: 'v' });
    expect(init.reason).toBe('Same person, second record at the ER desk');
    expect(init.idempotencyKey).toBe('merge-key-1');
  });

  it('commits by naming the prepared merge, never by repeating the two patient ids', async () => {
    await commitMerge('merge-1', 'Same person, second record at the ER desk', 'merge-key-2');
    const { init } = last(idempotentFetch);
    // Step two names step one's answer. Re-sending the ids would let a record
    // that changed between the two steps be merged unseen.
    expect(init.body).toEqual({ step: 'commit', mergeId: 'merge-1' });
    expect(init.reason).toBe('Same person, second record at the ER desk');
  });

  it('reverses a merge with its own reason and key', async () => {
    await unmerge('merge-1', 'Two different patients with the same name', 'unmerge-key-1');
    const { path, init } = last(idempotentFetch);
    expect(path).toBe('/api/v1/patients/unmerge');
    expect(init.body).toEqual({ mergeId: 'merge-1', reason: 'Two different patients with the same name' });
    expect(init.reason).toBe('Two different patients with the same name');
    expect(init.idempotencyKey).toBe('unmerge-key-1');
  });
});
