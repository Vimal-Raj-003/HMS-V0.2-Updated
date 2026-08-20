import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Liveness and readiness, kept apart on purpose.
 *
 * `/healthz` answers "is this process alive" — it must keep answering during a
 * graceful shutdown, or the orchestrator kills the pod while it is still
 * draining sockets. `/readyz` answers "should the load balancer send new
 * connections here", and goes false the instant SIGTERM arrives so that no new
 * socket lands on a pod that is closing.
 */
export interface HealthState {
  isAlive(): boolean;
  isReady(): boolean;
  details(): Readonly<Record<string, number | string | boolean>>;
}

export const HEALTH_PATHS = { live: '/healthz', ready: '/readyz' } as const;

export function createHealthHandler(state: HealthState): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (path !== HEALTH_PATHS.live && path !== HEALTH_PATHS.ready) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'not_found' }));
      return;
    }

    const ok = path === HEALTH_PATHS.live ? state.isAlive() : state.isReady();
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(
      JSON.stringify({
        status: ok ? 'ok' : 'unavailable',
        check: path === HEALTH_PATHS.live ? 'live' : 'ready',
        ...state.details(),
      }),
    );
  };
}
