import { describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { createHealthHandler, HEALTH_PATHS, type HealthState } from './health.js';

function invoke(state: HealthState, url: string): { status: number; body: string } {
  let status = 0;
  let body = '';
  const res = {
    writeHead: (code: number) => {
      status = code;
      return res;
    },
    end: (chunk: string) => {
      body = chunk;
      return res;
    },
  } as unknown as ServerResponse;
  createHealthHandler(state)({ url } as never, res);
  return { status, body };
}

const state = (alive: boolean, ready: boolean): HealthState => ({
  isAlive: () => alive,
  isReady: () => ready,
  details: () => ({ sockets: 3 }),
});

describe('health endpoints', () => {
  it('reports live and ready when both are true', () => {
    expect(invoke(state(true, true), HEALTH_PATHS.live).status).toBe(200);
    expect(invoke(state(true, true), HEALTH_PATHS.ready).status).toBe(200);
  });

  it('keeps answering /healthz while draining, but fails /readyz', () => {
    // Liveness must stay green during a graceful shutdown, or the orchestrator
    // kills the pod mid-drain instead of letting it finish.
    expect(invoke(state(true, false), HEALTH_PATHS.live).status).toBe(200);
    expect(invoke(state(true, false), HEALTH_PATHS.ready).status).toBe(503);
  });

  it('includes details and ignores the query string', () => {
    const { body } = invoke(state(true, true), `${HEALTH_PATHS.ready}?verbose=1`);
    expect(JSON.parse(body)).toMatchObject({ status: 'ok', check: 'ready', sockets: 3 });
  });

  it('404s anything else', () => {
    expect(invoke(state(true, true), '/').status).toBe(404);
    expect(invoke(state(true, true), '/socket.io/').status).toBe(404);
    vi.restoreAllMocks();
  });
});
