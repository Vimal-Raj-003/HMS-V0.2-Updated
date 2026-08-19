import { Inject, Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { ENV, type Env } from '../config/env.js';

/**
 * Password hashing and policy.
 *
 * Argon2**id** specifically (`CLAUDE.md` §2, `docs/05`): the `id` variant
 * resists both GPU cracking and the side-channel attacks that pure Argon2i and
 * Argon2d are each vulnerable to. The cost parameters below are the OWASP
 * baseline; they are configuration, not folklore, and should be re-measured on
 * the deployment's own hardware — a hash that takes under ~250 ms on the
 * production box is too cheap.
 */
@Injectable()
export class PasswordService {
  private readonly minLength: number;

  constructor(@Inject(ENV) env: Env) {
    this.minLength = env.AUTH_PASSWORD_MIN_LENGTH;
  }

  private static readonly OPTIONS = {
    type: argon2.argon2id,
    memoryCost: 19_456, // 19 MiB
    timeCost: 2,
    parallelism: 1,
  } as const;

  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, PasswordService.OPTIONS);
  }

  /**
   * Verifies a password.
   *
   * Returns `false` rather than throwing on a malformed stored hash: a corrupt
   * row must not become a 500 that tells an attacker the account exists.
   */
  async verify(storedHash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(storedHash, plaintext);
    } catch {
      return false;
    }
  }

  /**
   * `docs/05`: min 12, complexity, 90-day expiry, history 5, lockout after 5.
   * Length and complexity are checked here; expiry and history need the user's
   * stored history and live in the account service.
   */
  validateStrength(plaintext: string): readonly string[] {
    const failures: string[] = [];
    if (plaintext.length < this.minLength) {
      failures.push(`Must be at least ${this.minLength} characters.`);
    }
    if (!/[a-z]/.test(plaintext)) failures.push('Must include a lower-case letter.');
    if (!/[A-Z]/.test(plaintext)) failures.push('Must include an upper-case letter.');
    if (!/[0-9]/.test(plaintext)) failures.push('Must include a digit.');
    if (!/[^A-Za-z0-9]/.test(plaintext)) failures.push('Must include a symbol.');
    return failures;
  }

  /**
   * Whether a stored hash should be re-hashed on next successful login, because
   * the cost parameters have since been raised. Without this, passwords hashed
   * years ago stay at the old cost forever.
   */
  needsRehash(storedHash: string): boolean {
    try {
      return argon2.needsRehash(storedHash, PasswordService.OPTIONS);
    } catch {
      return true;
    }
  }
}
