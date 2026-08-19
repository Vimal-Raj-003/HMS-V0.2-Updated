import { describe, expect, it } from 'vitest';
import type { CircuitConfig } from '../config/connector-config.js';
import { canAttempt, forceClose, initialCircuit, onFailure, onSuccess } from './circuit-breaker.js';

const POLICY: CircuitConfig = {
  failureThreshold: 3,
  errorRatePct: 50,
  coolDownSec: 60,
  halfOpenMaxProbes: 1,
};

const T0 = new Date('2026-08-19T10:00:00.000Z');
const plus = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

/** Drive `n` failures through the machine, returning the resulting snapshot. */
function failTimes(n: number, at: Date = T0) {
  let snapshot = initialCircuit();
  for (let i = 0; i < n; i += 1) {
    snapshot = onFailure(snapshot, POLICY, at, 'partner_5xx');
  }
  return snapshot;
}

describe('circuit breaker state machine', () => {
  it('starts closed and lets everything through', () => {
    const decision = canAttempt(initialCircuit(), POLICY, T0);
    expect(decision.allowed).toBe(true);
    expect(decision.snapshot.state).toBe('closed');
  });

  it('stays closed below the failure threshold', () => {
    const snapshot = failTimes(2);
    expect(snapshot.state).toBe('closed');
    expect(snapshot.consecutiveFailures).toBe(2);
    expect(canAttempt(snapshot, POLICY, T0).allowed).toBe(true);
  });

  it('opens exactly at the threshold and schedules the probe one cool-down later', () => {
    const snapshot = failTimes(3);
    expect(snapshot.state).toBe('open');
    expect(snapshot.openedAt).toEqual(T0);
    expect(snapshot.nextProbeAt).toEqual(plus(60));
    expect(snapshot.lastTransitionReason).toMatch(/3 consecutive failures/);
  });

  it('refuses attempts while open, so a dead partner stops consuming the retry budget', () => {
    const snapshot = failTimes(3);
    const decision = canAttempt(snapshot, POLICY, plus(59));
    expect(decision.allowed).toBe(false);
    expect(decision.snapshot.state).toBe('open');
    expect(decision.reason).toMatch(/circuit open until/);
  });

  it('half-opens once the cool-down has elapsed', () => {
    const snapshot = failTimes(3);
    const decision = canAttempt(snapshot, POLICY, plus(60));
    expect(decision.allowed).toBe(true);
    expect(decision.snapshot.state).toBe('half_open');
    expect(decision.snapshot.halfOpenProbes).toBe(1);
  });

  it('lets only `halfOpenMaxProbes` through at a time', () => {
    // Without this a queue of 4 000 parked messages would all be released the
    // instant the cool-down expires, which is the thundering herd the breaker
    // was opened to prevent.
    const first = canAttempt(failTimes(3), POLICY, plus(60));
    const second = canAttempt(first.snapshot, POLICY, plus(60));
    expect(second.allowed).toBe(false);
    expect(second.reason).toMatch(/probe already in flight/);
  });

  it('closes on a successful probe', () => {
    const probing = canAttempt(failTimes(3), POLICY, plus(60)).snapshot;
    const closed = onSuccess(probing);
    expect(closed.state).toBe('closed');
    expect(closed.consecutiveFailures).toBe(0);
    expect(closed.nextProbeAt).toBeNull();
    expect(closed.lastTransitionReason).toBe('probe succeeded');
  });

  it('re-opens immediately when the probe fails, without waiting for the threshold again', () => {
    const probing = canAttempt(failTimes(3), POLICY, plus(60)).snapshot;
    const reopened = onFailure(probing, POLICY, plus(60), 'timeout');
    expect(reopened.state).toBe('open');
    expect(reopened.nextProbeAt).toEqual(plus(120));
    expect(reopened.lastTransitionReason).toMatch(/half-open probe failed \(timeout\)/);
    // The original opening time is kept: "open since 10:00" is what the
    // dashboard and the incident report need, not "open since the last probe".
    expect(reopened.openedAt).toEqual(T0);
  });

  it('resets the failure count on any success while closed', () => {
    const snapshot = onSuccess(failTimes(2));
    expect(snapshot.consecutiveFailures).toBe(0);
    expect(snapshot.state).toBe('closed');
  });

  it('tracks an error rate for the dashboard without letting it trip the breaker', () => {
    const snapshot = failTimes(2);
    expect(snapshot.errorRate).toBeGreaterThan(0);
    expect(snapshot.errorRate).toBeLessThan(1);
    expect(snapshot.state).toBe('closed');
    // 4 decimal places, matching `numeric(5,4)`, so the value read back from the
    // database is the value the machine last computed.
    expect(snapshot.errorRate).toBe(Number(snapshot.errorRate.toFixed(4)));
  });

  it('records the reason on a manual force-close', () => {
    const forced = forceClose(failTimes(3), 'vendor confirmed the outage is over');
    expect(forced.state).toBe('closed');
    expect(forced.lastTransitionReason).toBe('force_close: vendor confirmed the outage is over');
  });

  it('is a pure function of its inputs — the same sequence always gives the same state', () => {
    expect(failTimes(3)).toEqual(failTimes(3));
  });
});
