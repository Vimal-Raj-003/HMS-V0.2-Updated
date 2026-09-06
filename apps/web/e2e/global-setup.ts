import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const HANDOFF = join(process.cwd(), 'e2e', '.stack.json');

export interface StackHandoff {
  readonly apiOrigin: string;
  readonly webOrigin: string;
  readonly hospitalId: string;
}

let stack: ChildProcess | undefined;

/**
 * Starts `e2e/stack.mts` and waits for it to publish its handoff file.
 *
 * The stack runs as a child process because it is ESM and Playwright's loader is
 * CommonJS; see the note at the top of `stack.mts`.
 */
export default async function globalSetup(): Promise<void> {
  rmSync(HANDOFF, { force: true });

  stack = spawn('npx', ['tsx', 'e2e/stack.mts'], { cwd: process.cwd(), stdio: 'inherit' });
  (globalThis as Record<string, unknown>)['__vimsStackPid'] = stack.pid;

  // On an object rather than a bare `let`: TypeScript's control-flow analysis
  // cannot see the assignment inside the `exit` callback, so it narrows a plain
  // binding to `null` and the check below becomes `never`. A property read is
  // re-widened across the intervening await, which is the truth here.
  const outcome: { exited: number | null } = { exited: null };
  stack.on('exit', (code) => {
    outcome.exited = code ?? 1;
  });

  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (existsSync(HANDOFF)) {
      const handoff = JSON.parse(readFileSync(HANDOFF, 'utf8')) as StackHandoff;
      if (handoff.hospitalId.length > 0) return;
    }
    if (outcome.exited !== null) {
      throw new Error(`e2e stack exited early with code ${String(outcome.exited)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('e2e stack did not become ready within 300s');
}

export function stopStack(): void {
  const pid = (globalThis as Record<string, unknown>)['__vimsStackPid'];
  if (typeof pid === 'number') {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  rmSync(HANDOFF, { force: true });
}
