import type { Provider, Type } from '@nestjs/common';
import { AssistantController } from './assistant.controller.js';
import { AssistantService } from './assistant.service.js';
import { DirectoryService } from './directory.service.js';
import { LlmClient } from './llm.client.js';
import { PublicRateLimitService } from './rate-limit.service.js';
import { AppointmentRequestController } from './requests.controller.js';
import { AppointmentRequestService } from './requests.service.js';

/**
 * PE-009 — the public assistant and the enquiries it leaves behind.
 *
 * Exported as arrays and spread into `AppModule` rather than imported as a
 * Nest module, following every other module here. A `@Module` with its own
 * injector would construct a second `pg.Pool` against the same database and
 * would need a `forwardRef` cycle back through `app.module.ts` to reach the
 * shared guards. Spreading keeps one pool and one guard chain.
 */
export const ASSISTANT_CONTROLLERS: readonly Type<unknown>[] = [
  AssistantController,
  AppointmentRequestController,
];

export const ASSISTANT_PROVIDERS: readonly Provider[] = [
  AssistantService,
  DirectoryService,
  LlmClient,
  PublicRateLimitService,
  AppointmentRequestService,
];
