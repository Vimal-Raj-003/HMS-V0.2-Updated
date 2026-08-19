import { describe, expect, it } from 'vitest';
import { IDS } from '../__tests__/harness.js';
import { createMemoryPresenceStore } from './presence.js';

const { hospitalA, hospitalB, userAlice, userBob } = IDS;

describe('presence store', () => {
  it('refcounts sockets so a second device does not flip a user offline', async () => {
    const store = createMemoryPresenceStore();
    expect(await store.add(hospitalA, userAlice, 'socket-1')).toBe(1);
    expect(await store.add(hospitalA, userAlice, 'socket-2')).toBe(2);
    expect(await store.remove(hospitalA, userAlice, 'socket-1')).toBe(1);
    expect(await store.listUsers(hospitalA)).toEqual([userAlice]);
    expect(await store.remove(hospitalA, userAlice, 'socket-2')).toBe(0);
    expect(await store.listUsers(hospitalA)).toEqual([]);
  });

  it('is idempotent for the same socket id', async () => {
    const store = createMemoryPresenceStore();
    await store.add(hospitalA, userAlice, 'socket-1');
    expect(await store.add(hospitalA, userAlice, 'socket-1')).toBe(1);
    expect(await store.remove(hospitalA, userAlice, 'socket-unknown')).toBe(1);
  });

  it('never lets one hospital see another hospital presence', async () => {
    const store = createMemoryPresenceStore();
    await store.add(hospitalA, userAlice, 'socket-1');
    await store.add(hospitalB, userBob, 'socket-2');
    expect(await store.listUsers(hospitalA)).toEqual([userAlice]);
    expect(await store.listUsers(hospitalB)).toEqual([userBob]);
    expect(await store.socketCount(hospitalA, userBob)).toBe(0);
  });
});
