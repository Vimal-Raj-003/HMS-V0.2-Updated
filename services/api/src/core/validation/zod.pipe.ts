import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ProblemFieldError } from '@vims/contracts';
import { z } from 'zod';
import { AppError } from '../problem/app-error.js';

/**
 * Step 5 — validation against the **shared** Zod schema.
 *
 * The same schema object validates in the browser and here (`docs/09` §4), so a
 * rule cannot drift between the two and let the client accept something the
 * server rejects. Failures come back as RFC 9457 field errors, which is what lets
 * the UI attach each message to its own input instead of showing one opaque
 * banner.
 */
@Injectable()
export class ZodBody<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    // `path` is JSON-Pointer-ish (`items/0/quantity`) per primitives/problem.ts,
    // so the UI can walk straight to the offending input in a nested form.
    const errors: ProblemFieldError[] = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('/') || '(body)',
      code: issue.code,
      message: issue.message,
    }));
    throw AppError.validation(errors);
  }
}
