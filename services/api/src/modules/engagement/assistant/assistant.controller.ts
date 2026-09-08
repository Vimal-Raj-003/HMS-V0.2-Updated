import { Body, Controller, Get, Inject, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { AssistantService } from './assistant.service.js';
import { DirectoryService, type PublicDirectory, type PublicSlot } from './directory.service.js';
import { AppointmentRequestService } from './requests.service.js';
import {
  appointmentRequestSchema,
  availabilityQuerySchema,
  chatRequestSchema,
  directoryQuerySchema,
  type AppointmentRequestBody,
  type AppointmentRequestReceipt,
  type AvailabilityQuery,
  type ChatRequest,
  type ChatResponse,
  type DirectoryQuery,
} from './assistant.schemas.js';

/**
 * `/api/v1/assistant/*` — PE-009, and the only unauthenticated business routes
 * in the API.
 *
 * `@Public()` is not used lightly here. `AuthGuard` is deliberately opt-out
 * rather than opt-in so a controller written in a hurry is closed; these four
 * routes opt out because a visitor to a hospital's website has no account and
 * is not going to make one to ask which departments exist.
 *
 * What makes that safe is not this decorator but everything under it:
 *
 *   - The tenant is supplied by the caller and confined by RLS, exactly as at
 *     login. A body naming another hospital reads that hospital's *public
 *     directory* — the same page it publishes on its own website.
 *   - Every route is rate-limited on a hash of the caller, in a transaction
 *     that commits whether or not the request then succeeds.
 *   - Nothing here reads a patient, an appointment, a bill or a clinical row.
 *     The reads are the lobby board; the single write is an enquiry.
 *   - The model has no tools, so no sentence a visitor types can become a
 *     statement against the database.
 */
@Controller('assistant')
export class AssistantController {
  constructor(
    @Inject(AssistantService) private readonly assistant: AssistantService,
    @Inject(DirectoryService) private readonly directory: DirectoryService,
    @Inject(AppointmentRequestService) private readonly requests: AppointmentRequestService,
  ) {}

  /** The departments and consultants a hospital has chosen to publish. */
  @Public()
  @Get('directory')
  async getDirectory(
    @Query(new ZodBody(directoryQuerySchema)) query: DirectoryQuery,
  ): Promise<PublicDirectory> {
    return this.directory.directory(query.hospitalId);
  }

  /** Slots with room left against the online quota — never the clinic's true capacity. */
  @Public()
  @Get('availability')
  async getAvailability(
    @Query(new ZodBody(availabilityQuerySchema)) query: AvailabilityQuery,
  ): Promise<readonly PublicSlot[]> {
    return this.directory.availability(query.hospitalId, {
      specialityKey: query.specialityKey,
      practitionerKey: query.practitionerKey,
      fromDate: query.fromDate,
      toDate: query.toDate,
    });
  }

  @Public()
  @Post('chat')
  async chat(
    @Body(new ZodBody(chatRequestSchema)) body: ChatRequest,
    @Req() request: FastifyRequest,
  ): Promise<ChatResponse> {
    return this.assistant.chat(body, request.ip ?? null);
  }

  /**
   * Captures an enquiry. Not a booking, and the response says so in words as
   * well as in its shape.
   */
  @Public()
  @Post('appointment-requests')
  async request(
    @Body(new ZodBody(appointmentRequestSchema)) body: AppointmentRequestBody,
    @Req() request: FastifyRequest,
  ): Promise<AppointmentRequestReceipt> {
    return this.requests.capture(body, request.ip ?? null);
  }
}
