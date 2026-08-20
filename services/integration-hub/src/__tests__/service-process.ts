import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
/** The service root, two levels up from `src/__tests__`. */
export const SERVICE_ROOT = resolve(HERE, '../..');
export const REPO_ROOT = resolve(SERVICE_ROOT, '../..');

/**
 * Build the service, then run it the way a container does.
 *
 * The build is part of the test rather than a prerequisite of it, because the
 * thing under test is precisely "does `dist/main.js` run" — a suite that
 * assumed a `dist` someone else produced would keep passing after a change that
 * broke the emit, which is the failure this file exists to catch.
 */
export async function buildService(root: string = SERVICE_ROOT): Promise<void> {
  await execFileAsync(join(REPO_ROOT, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.build.json'], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!existsSync(join(root, 'dist/main.js'))) {
    throw new Error(`${root}/dist/main.js was not produced by the build`);
  }
}

export interface RunningService {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  /** Everything the process has written to stdout+stderr so far. */
  output(): string;
  /** Resolves when `predicate` matches the accumulated output. */
  waitForOutput(predicate: (out: string) => boolean, label: string, timeoutMs?: number): Promise<void>;
  /** Resolves with the exit code once the process has exited. */
  exited(): Promise<number | null>;
  stop(signal: NodeJS.Signals): Promise<number | null>;
}

/**
 * Start `node dist/main.js` with an explicit environment.
 *
 * `env` replaces rather than extends `process.env` apart from `PATH`: a service
 * that only starts because the developer's shell happened to export
 * `DATABASE_URL` is not a service that starts in a container.
 */
export function startService(root: string, env: Readonly<Record<string, string>>): RunningService {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: root,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buffer = '';
  const listeners = new Set<() => void>();
  const append = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8');
    for (const notify of [...listeners]) notify();
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  let exitCode: number | null = null;
  let exited = false;
  const exitPromise = new Promise<number | null>((resolveExit) => {
    child.on('exit', (code) => {
      exitCode = code;
      exited = true;
      for (const notify of [...listeners]) notify();
      resolveExit(code);
    });
  });

  return {
    child,
    output: () => buffer,
    waitForOutput(predicate, label, timeoutMs = 60_000): Promise<void> {
      return new Promise<void>((resolveWait, rejectWait) => {
        const check = (): boolean => {
          if (predicate(buffer)) {
            cleanup();
            resolveWait();
            return true;
          }
          if (exited) {
            cleanup();
            rejectWait(
              new Error(`process exited (${String(exitCode)}) before "${label}".\n--- output ---\n${buffer}`),
            );
            return true;
          }
          return false;
        };
        const timer = setTimeout(() => {
          cleanup();
          rejectWait(new Error(`timed out waiting for "${label}".\n--- output ---\n${buffer}`));
        }, timeoutMs);
        const notify = (): void => {
          check();
        };
        const cleanup = (): void => {
          clearTimeout(timer);
          listeners.delete(notify);
        };
        listeners.add(notify);
        check();
      });
    },
    exited: () => exitPromise,
    async stop(signal): Promise<number | null> {
      if (!exited) child.kill(signal);
      return exitPromise;
    },
  };
}

/** Poll an HTTP endpoint until it answers with one of `statuses`. */
export async function waitForHttp(
  url: string,
  statuses: readonly number[],
  timeoutMs = 30_000,
): Promise<{ status: number; body: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = 'never responded';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (statuses.includes(response.status)) return { status: response.status, body };
      last = `status ${response.status}: ${body}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} never returned one of ${statuses.join('/')} — last: ${last}`);
}

/** Poll `probe` until it returns a value, or fail with `label`. */
export async function until<T>(
  probe: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Ask the OS for a port that is free right now.
 *
 * A hard-coded port makes a suite fail on a developer machine that happens to
 * run something else, and makes two suites in the same CI job collide.
 */
export function freePort(): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    void import('node:net').then(({ createServer: createTcpServer }) => {
      const probe = createTcpServer();
      probe.once('error', rejectPort);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        probe.close(() => (port === 0 ? rejectPort(new Error('no free port')) : resolvePort(port)));
      });
    }, rejectPort);
  });
}
