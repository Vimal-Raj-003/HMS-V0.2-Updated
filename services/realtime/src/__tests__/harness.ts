import { Writable } from 'node:stream';
import { SignJWT } from 'jose';
import type { Logger } from 'pino';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import type { AccessTokenClaims } from '../auth/access-token.js';
import { loadEnv, type RealtimeEnv } from '../config/env.js';
import { createLogger } from '../logger.js';
import type { ClientToServerEvents, HelloMessage, ServerToClientEvents } from '../gateway/protocol.js';

/**
 * Fixed ids, not generated ones. `docs/09` §2 forbids ambient randomness in
 * tests; a cross-tenant assertion that fails should name the same two hospitals
 * every time so the failure can be read without re-running it.
 */
export const IDS = {
  hospitalA: '018f3a20-0000-7000-8000-000000000001',
  hospitalB: '018f3a20-0000-7000-8000-000000000002',
  branchA1: '018f3a20-0000-7000-8000-000000001001',
  branchA2: '018f3a20-0000-7000-8000-000000001002',
  userAlice: '018f3a20-0000-7000-8000-000000002001',
  userBob: '018f3a20-0000-7000-8000-000000002002',
  userCarol: '018f3a20-0000-7000-8000-000000002003',
  userDan: '018f3a20-0000-7000-8000-000000002004',
  doctorOrtho: '018f3a20-0000-7000-8000-000000003001',
  sessionAlice: '018f3a20-0000-7000-8000-000000004001',
} as const;

export const TEST_SECRET = 'test-access-secret-at-least-32-chars-long';
export const TEST_ISSUER = 'vims-hms';

export function testEnv(overrides: Record<string, string> = {}): RealtimeEnv {
  return loadEnv({
    NODE_ENV: 'test',
    // A real port value; suites bind with `listen(0)` for an ephemeral one.
    PORT: '3002',
    REDIS_URL: 'redis://127.0.0.1:6379',
    JWT_ACCESS_SECRET: TEST_SECRET,
    JWT_ISSUER: TEST_ISSUER,
    LOG_LEVEL: 'debug',
    REALTIME_PING_INTERVAL_MS: '1000',
    REALTIME_PING_TIMEOUT_MS: '1000',
    ...overrides,
  });
}

export interface SignOptions {
  readonly secret?: string;
  readonly issuer?: string;
  /** Seconds from now; negative produces an already-expired token. */
  readonly expiresInSeconds?: number;
  readonly algorithm?: 'HS256';
}

export function claimsFor(overrides: Partial<AccessTokenClaims> = {}): AccessTokenClaims {
  return {
    sub: IDS.userAlice,
    sid: IDS.sessionAlice,
    hid: IDS.hospitalA,
    bid: IDS.branchA1,
    scope: 'branch',
    roles: ['nurse_ward'],
    acr: 'aal2',
    amr: ['pwd', 'otp'],
    authTime: 1_700_000_000,
    ...overrides,
  };
}

export async function signAccessToken(claims: AccessTokenClaims, options: SignOptions = {}): Promise<string> {
  const secret = new TextEncoder().encode(options.secret ?? TEST_SECRET);
  const ttl = options.expiresInSeconds ?? 900;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: options.algorithm ?? 'HS256', typ: 'JWT' })
    .setIssuer(options.issuer ?? TEST_ISSUER)
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(secret);
}

export interface CapturedLogger {
  readonly logger: Logger;
  lines(): ReadonlyArray<Record<string, unknown>>;
  find(event: string): ReadonlyArray<Record<string, unknown>>;
}

export function createCapturingLogger(): CapturedLogger {
  const captured: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim().length === 0) continue;
        try {
          captured.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // Not our JSON; ignore rather than fail the suite on log formatting.
        }
      }
      callback();
    },
  });
  return {
    logger: createLogger('debug', stream),
    lines: () => captured,
    find: (event) => captured.filter((l) => l['event'] === event),
  };
}

export type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

/**
 * `hello` is emitted by the server as soon as the socket has joined its own
 * room, which can be *before* a test gets a chance to add a listener. Socket.IO
 * drops an event with no listener, so the greeting is captured at construction
 * time and replayed by `helloOf()`. Without this the first assertion in a file
 * is a coin flip.
 */
const greetings = new WeakMap<TestClient, HelloMessage>();
const greetingWaiters = new WeakMap<TestClient, ((message: HelloMessage) => void)[]>();

export function connectClient(port: number, token: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket: TestClient = connect(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
      timeout: 5_000,
    });
    socket.on('hello', (message: HelloMessage) => {
      greetings.set(socket, message);
      for (const waiter of greetingWaiters.get(socket) ?? []) waiter(message);
      greetingWaiters.set(socket, []);
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (error: Error) => {
      socket.close();
      reject(error);
    });
  });
}

export function helloOf(socket: TestClient, timeoutMs = 5_000): Promise<HelloMessage> {
  const already = greetings.get(socket);
  if (already !== undefined) return Promise.resolve(already);
  return new Promise<HelloMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for "hello"')), timeoutMs);
    const waiters = greetingWaiters.get(socket) ?? [];
    waiters.push((message) => {
      clearTimeout(timer);
      resolve(message);
    });
    greetingWaiters.set(socket, waiters);
  });
}

type ServerEvent = keyof ServerToClientEvents;
type PayloadOf<E extends ServerEvent> = Parameters<ServerToClientEvents[E]>[0];

/**
 * Socket.IO's client event typing is conditional on the event name, which a
 * generic helper cannot satisfy without resolving the conditional. The payload
 * type is still enforced at the call site through `PayloadOf<E>`; only the
 * listener registration goes through this loose view.
 */
interface LooseClient {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener?: (...args: unknown[]) => void): unknown;
}

const loose = (socket: TestClient): LooseClient => socket as unknown as LooseClient;

/** Resolves with the first payload of `event`, or rejects after `timeoutMs`. */
export function once<E extends ServerEvent>(
  socket: TestClient,
  event: E,
  timeoutMs = 5_000,
): Promise<PayloadOf<E>> {
  return new Promise<PayloadOf<E>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    loose(socket).once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args[0] as PayloadOf<E>);
    });
  });
}

/** Collects every payload of `event` for `windowMs`, then resolves. */
export function collect<E extends ServerEvent>(
  socket: TestClient,
  event: E,
  windowMs: number,
): Promise<PayloadOf<E>[]> {
  const received: PayloadOf<E>[] = [];
  const listener = (...args: unknown[]): void => {
    received.push(args[0] as PayloadOf<E>);
  };
  loose(socket).on(event, listener);
  return new Promise<PayloadOf<E>[]>((resolve) => {
    setTimeout(() => {
      loose(socket).off(event, listener);
      resolve(received);
    }, windowMs);
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
