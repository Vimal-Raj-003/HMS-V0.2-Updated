import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { AuthService, type LoginResult } from './auth.service.js';

/**
 * `docs/05`: one login URL per tenant. The hospital is therefore known before
 * the user is, and is supplied by the caller (from the sub-domain in cloud, or
 * from configuration on-prem) rather than guessed from the identifier — guessing
 * would mean searching every tenant for a username, which is both slow and an
 * enumeration channel across hospitals.
 */
export const loginSchema = z.object({
  hospitalId: z.string().uuid(),
  identifier: z.string().min(1).max(254),
  password: z.string().min(1).max(512),
});

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  async login(
    @Body(new ZodBody(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() request: FastifyRequest,
  ): Promise<LoginResult> {
    return this.auth.login({
      hospitalId: body.hospitalId,
      identifier: body.identifier,
      password: body.password,
      ip: request.ip ?? null,
      userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    });
  }
}
