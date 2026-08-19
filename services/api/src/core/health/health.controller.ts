import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../db/database.service.js';
import { Public } from '../policy/permission.decorator.js';

/**
 * Liveness and readiness.
 *
 * They are different questions and are deliberately separate endpoints:
 * `/healthz` asks "is this process alive" (restart me if not) and must never
 * touch the database, or a brief database blip would restart every API pod and
 * turn a degradation into an outage. `/readyz` asks "can this process serve
 * traffic" and therefore must check dependencies.
 */
@Controller()
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Public()
  @Get('healthz')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('readyz')
  async ready(): Promise<{ status: 'ok' | 'degraded'; database: boolean }> {
    const database = await this.db.ping().catch(() => false);
    return { status: database ? 'ok' : 'degraded', database };
  }
}
