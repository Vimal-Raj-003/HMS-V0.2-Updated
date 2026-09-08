import { z } from 'zod';

/**
 * PE-009 · The public contract.
 *
 * Every field a stranger can send is bounded here. This is the only validation
 * an unauthenticated caller passes through before touching a database, so the
 * limits are deliberately tight: a message is 2000 characters because nothing a
 * visitor needs to say about a clinic is longer, and a transcript is 24 turns
 * because a longer one is somebody automating rather than asking.
 */

export const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(2000),
});

export const chatRequestSchema = z.object({
  hospitalId: z.string().uuid(),
  messages: z.array(chatMessageSchema).min(1).max(24),
  locale: z.string().max(12).optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export interface ChatResponse {
  readonly reply: string;
  /** `emergency` and `clinical` mean the model was never consulted. */
  readonly safety: 'none' | 'emergency' | 'clinical';
  /** Which of the three answered: the safety screen, the model, or the directory. */
  readonly source: 'safety' | 'model' | 'directory';
  readonly intent: {
    readonly kind: 'book_appointment';
    readonly specialityKey?: string;
    readonly specialityName?: string;
  } | null;
  readonly suggestions: readonly string[];
}

export const directoryQuerySchema = z.object({
  hospitalId: z.string().uuid(),
});
export type DirectoryQuery = z.infer<typeof directoryQuerySchema>;

export const availabilityQuerySchema = z.object({
  hospitalId: z.string().uuid(),
  specialityKey: z.string().uuid().optional(),
  practitionerKey: z.string().uuid().optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

/**
 * The appointment **request**.
 *
 * `consent` is `z.literal(true)`, not `z.boolean()`. A request from somebody who
 * did not agree to be telephoned is not a request with a flag set to false —
 * it is not a request, and the type says so before the CHECK constraint repeats
 * it (PE-009 §B.1).
 *
 * There is deliberately no field for symptoms, history, allergies or an
 * identifier. `reason` is 280 characters and named for what it is; a public box
 * that invites a medical narrative collects health data from somebody who was
 * never told it was being collected.
 */
export const appointmentRequestSchema = z.object({
  hospitalId: z.string().uuid(),
  name: z.string().min(2).max(120),
  phone: z
    .string()
    .min(7)
    .max(20)
    .regex(/^\+?[0-9][0-9 ()-]{6,19}$/, 'Enter a phone number we can call you back on.'),
  email: z.string().email().max(254).optional(),
  specialityKey: z.string().uuid().optional(),
  practitionerKey: z.string().uuid().optional(),
  slotId: z.string().uuid().optional(),
  preferredDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  preferredPeriod: z.enum(['morning', 'afternoon', 'evening', 'any']).optional(),
  reason: z.string().max(280).optional(),
  consent: z.literal(true),
  locale: z.string().max(12).optional(),
});
export type AppointmentRequestBody = z.infer<typeof appointmentRequestSchema>;

export interface AppointmentRequestReceipt {
  readonly id: string;
  readonly status: 'new';
  /**
   * Said in the response as well as in the UI. The commonest way a system like
   * this hurts somebody is by letting them believe they have an appointment.
   */
  readonly message: string;
}

/** The staff-side worklist. */
export const requestListQuerySchema = z.object({
  status: z.enum(['new', 'contacted', 'booked', 'declined', 'expired']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type RequestListQuery = z.infer<typeof requestListQuerySchema>;

export const requestUpdateSchema = z.object({
  status: z.enum(['contacted', 'declined', 'expired']),
  declineReason: z.string().min(3).max(200).optional(),
});
export type RequestUpdateBody = z.infer<typeof requestUpdateSchema>;

export const requestConvertSchema = z.object({
  appointmentId: z.string().uuid(),
});
export type RequestConvertBody = z.infer<typeof requestConvertSchema>;

export interface AppointmentRequestRow {
  readonly id: string;
  readonly channel: string;
  readonly requesterName: string;
  readonly requesterPhone: string;
  readonly requesterEmail: string | null;
  readonly specialityKey: string | null;
  readonly practitionerKey: string | null;
  readonly slotId: string | null;
  readonly preferredDate: string | null;
  readonly preferredPeriod: string | null;
  readonly reason: string | null;
  readonly status: string;
  readonly appointmentId: string | null;
  readonly handledAt: string | null;
  readonly declineReason: string | null;
  readonly createdAt: string;
}
