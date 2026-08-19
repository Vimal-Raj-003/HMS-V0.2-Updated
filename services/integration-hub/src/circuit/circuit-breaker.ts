/**
 * EN-017 §3.2 step 5 — the circuit breaker, as a pure state machine.
 *
 * The reason it is worth having at all: a partner that is down does not fail
 * fast, it fails *slowly*. Every message spends its full 30 s timeout before
 * failing, five times, with backoff — so a single dead endpoint quietly consumes
 * the worker pool and the retry budget that the other twenty-nine connectors
 * need. Opening the circuit converts that into a cheap, visible refusal.
 *
 * `closed → open → half_open → closed` with an injected `now`, no timers and no
 * randomness, so the transitions can be tested by moving a clock rather than by
 * sleeping (`docs/09` §2 bans ambient time and `Math.random` in tests).
 *
 * The persisted copy lives in `integration.ihub_circuit_state` — see
 * `circuit-store.ts` for why the durable row matters even though EN-017 §5 says
 * the live state is shared through Redis.
 */
import type { CircuitConfig } from '../config/connector-config.js';
import type { ErrorClass } from '../adapter/types.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitSnapshot {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  /**
   * Exponentially-weighted failure ratio in [0,1], for the RAG dashboard.
   *
   * It does **not** trip the breaker on its own. EN-017 §5 puts the live state
   * in Redis precisely because an error *rate* needs a rolling window shared
   * across workers, and a single Postgres row cannot hold one honestly. Tripping
   * on `consecutiveFailures` needs no window and is correct on one worker or
   * fifty; the rate is recorded so the threshold is ready when Redis lands.
   */
  readonly errorRate: number;
  readonly openedAt: Date | null;
  readonly nextProbeAt: Date | null;
  readonly lastTransitionReason: string | null;
  /** Probes let through while half-open. Reset on every transition. */
  readonly halfOpenProbes: number;
}

export function initialCircuit(): CircuitSnapshot {
  return {
    state: 'closed',
    consecutiveFailures: 0,
    errorRate: 0,
    openedAt: null,
    nextProbeAt: null,
    lastTransitionReason: null,
    halfOpenProbes: 0,
  };
}

/** Weight of the newest sample in the EWMA. 1/20 ≈ a 20-attempt window. */
const ERROR_RATE_ALPHA = 0.05;

function nextErrorRate(previous: number, failed: boolean): number {
  const value = previous * (1 - ERROR_RATE_ALPHA) + (failed ? ERROR_RATE_ALPHA : 0);
  // `numeric(5,4)` — round here rather than let Postgres do it, so the value the
  // state machine sees next time is the value that was stored.
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
}

export interface AttemptDecision {
  readonly allowed: boolean;
  /** The snapshot after any time-driven transition (open → half_open). */
  readonly snapshot: CircuitSnapshot;
  readonly reason: string;
}

/**
 * May this message be attempted right now?
 *
 * Returns a snapshot because asking the question can itself change the state:
 * an open circuit whose cool-down has elapsed becomes half-open at the moment
 * someone tries, which is the only event available in a system with no timers.
 */
export function canAttempt(
  snapshot: CircuitSnapshot,
  policy: CircuitConfig,
  now: Date,
): AttemptDecision {
  switch (snapshot.state) {
    case 'closed':
      return { allowed: true, snapshot, reason: 'circuit closed' };

    case 'open': {
      const probeDue = snapshot.nextProbeAt !== null && now.getTime() >= snapshot.nextProbeAt.getTime();
      if (!probeDue) {
        return {
          allowed: false,
          snapshot,
          reason: `circuit open until ${snapshot.nextProbeAt?.toISOString() ?? 'manual close'}`,
        };
      }
      return {
        allowed: true,
        snapshot: {
          ...snapshot,
          state: 'half_open',
          halfOpenProbes: 1,
          lastTransitionReason: 'cool-down elapsed; probing',
        },
        reason: 'half-open probe',
      };
    }

    case 'half_open': {
      if (snapshot.halfOpenProbes >= policy.halfOpenMaxProbes) {
        return { allowed: false, snapshot, reason: 'half-open probe already in flight' };
      }
      return {
        allowed: true,
        snapshot: { ...snapshot, halfOpenProbes: snapshot.halfOpenProbes + 1 },
        reason: 'half-open probe',
      };
    }

    default:
      return { allowed: true, snapshot, reason: 'circuit closed' };
  }
}

/** A success closes a half-open circuit outright — one good answer is the signal. */
export function onSuccess(snapshot: CircuitSnapshot): CircuitSnapshot {
  return {
    state: 'closed',
    consecutiveFailures: 0,
    errorRate: nextErrorRate(snapshot.errorRate, false),
    openedAt: null,
    nextProbeAt: null,
    lastTransitionReason: snapshot.state === 'closed' ? snapshot.lastTransitionReason : 'probe succeeded',
    halfOpenProbes: 0,
  };
}

/**
 * A failure while half-open re-opens immediately, without waiting for the
 * threshold again: the probe *was* the test, and it failed.
 */
export function onFailure(
  snapshot: CircuitSnapshot,
  policy: CircuitConfig,
  now: Date,
  errorClass: ErrorClass,
): CircuitSnapshot {
  const consecutiveFailures = snapshot.consecutiveFailures + 1;
  const errorRate = nextErrorRate(snapshot.errorRate, true);
  const coolDownMs = policy.coolDownSec * 1000;

  if (snapshot.state === 'half_open') {
    return {
      state: 'open',
      consecutiveFailures,
      errorRate,
      openedAt: snapshot.openedAt ?? now,
      nextProbeAt: new Date(now.getTime() + coolDownMs),
      lastTransitionReason: `half-open probe failed (${errorClass})`,
      halfOpenProbes: 0,
    };
  }

  if (consecutiveFailures >= policy.failureThreshold) {
    return {
      state: 'open',
      consecutiveFailures,
      errorRate,
      openedAt: snapshot.state === 'open' ? (snapshot.openedAt ?? now) : now,
      nextProbeAt: new Date(now.getTime() + coolDownMs),
      lastTransitionReason: `${consecutiveFailures} consecutive failures (${errorClass})`,
      halfOpenProbes: 0,
    };
  }

  return {
    state: 'closed',
    consecutiveFailures,
    errorRate,
    openedAt: null,
    nextProbeAt: null,
    lastTransitionReason: `failure ${consecutiveFailures}/${policy.failureThreshold} (${errorClass})`,
    halfOpenProbes: 0,
  };
}

/**
 * EN-017 §5: "a manual `force_close` requires `ihub.connector.manage` and a
 * reason." The reason is not decoration — it is the record of a human deciding
 * to point traffic at a partner the system believes is broken.
 */
export function forceClose(snapshot: CircuitSnapshot, reason: string): CircuitSnapshot {
  return {
    ...initialCircuit(),
    errorRate: snapshot.errorRate,
    lastTransitionReason: `force_close: ${reason}`,
  };
}
