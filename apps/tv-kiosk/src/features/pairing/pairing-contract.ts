import { z } from 'zod';

/**
 * EN-018 §3.2 / docs/05 §"Kiosk / TV / Devices": a display never holds a user
 * session. It holds a device-bound, read-only token whose only scope is reading
 * one board. The schema is enforced on read from storage as well as on the wire,
 * because a token that has been tampered with in `localStorage` must be discarded
 * rather than sent.
 */
/**
 * The one authority a display device holds.
 *
 * `queue.board.read` is the key registered in `packages/contracts`, and its
 * catalogue entry says what it is for in as many words: "Render a queue board.
 * Held by display device tokens as well as staff." It replaces the
 * `display.token_board.read` this file previously invented — a scope the API
 * would have refused, because `PermissionRegistryService` verifies the
 * catalogue at boot and nothing may hold a key that is not in it.
 *
 * Written as a literal rather than imported from `@vims/contracts` so that a
 * board on a 2 GB Android box does not ship the 2,000-entry permission
 * catalogue in its bundle. `pairing-scope.test.ts` imports the catalogue and
 * asserts this string is in it, so the saving costs nothing in safety.
 */
export const DISPLAY_BOARD_SCOPE = 'queue.board.read';

export const DeviceCredentialSchema = z.object({
  deviceId: z.string().min(1),
  /** Scoped, device-bound, long-lived. Never contains PHI claims (EN-018 §5). */
  token: z.string().min(1),
  boardId: z.string().min(1),
  boardName: z.string().min(1),
  scopes: z.array(z.string()).min(1),
  pairedAt: z.string().min(1),
});
export type DeviceCredential = z.infer<typeof DeviceCredentialSchema>;

export const PairingChallengeSchema = z.object({
  deviceId: z.string().min(1),
  /** 6 digits, single-use, 10-minute life (EN-018 §5). */
  pairingCode: z.string().min(4).max(8),
  expiresAt: z.string().min(1),
  pollIntervalMs: z.number().int().positive(),
});
export type PairingChallenge = z.infer<typeof PairingChallengeSchema>;

export const PairingStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('paired'), credential: DeviceCredentialSchema }),
]);
export type PairingStatus = z.infer<typeof PairingStatusSchema>;

export interface DeviceRegistration {
  readonly deviceId: string;
  readonly kind: string;
  readonly resolution: string;
  readonly appVersion: string;
}

/**
 * The device half of `/api/v1/display/devices` (EN-018 §6). Injected rather than
 * imported so the pairing screen can be rendered in a test, and so the API can be
 * built after this app.
 */
export interface PairingClient {
  requestChallenge(input: DeviceRegistration, signal: AbortSignal): Promise<PairingChallenge>;
  pollStatus(deviceId: string, pairingCode: string, signal: AbortSignal): Promise<PairingStatus>;
}
