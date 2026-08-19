import {
  PairingChallengeSchema,
  PairingStatusSchema,
  type DeviceRegistration,
  type PairingChallenge,
  type PairingClient,
  type PairingStatus,
} from './pairing-contract';

export class PairingServiceError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'PairingServiceError';
    this.status = status;
  }
}

/**
 * `POST /display/devices/register` then poll `GET /display/devices/pair-status`
 * (EN-018 §6). Both responses are validated: a proxy or captive portal that
 * answers with an HTML login page must be treated as "not paired yet", not as a
 * credential.
 */
export function createHttpPairingClient(apiBaseUrl: string): PairingClient {
  const url = (path: string): string => `${apiBaseUrl}/display${path}`;

  return {
    async requestChallenge(input: DeviceRegistration, signal: AbortSignal): Promise<PairingChallenge> {
      const response = await fetch(url('/devices/register'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(input),
        cache: 'no-store',
        signal,
      });
      if (!response.ok) {
        throw new PairingServiceError('Pairing service rejected the registration', response.status);
      }
      const body: unknown = await response.json();
      const parsed = PairingChallengeSchema.safeParse(body);
      if (!parsed.success) {
        throw new PairingServiceError('Pairing service returned an unreadable challenge', 502);
      }
      return parsed.data;
    },

    async pollStatus(deviceId: string, pairingCode: string, signal: AbortSignal): Promise<PairingStatus> {
      const query = new URLSearchParams({ deviceId, code: pairingCode });
      const response = await fetch(`${url('/devices/pair-status')}?${query.toString()}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal,
      });
      if (response.status === 404 || response.status === 410) return { status: 'expired' };
      if (!response.ok) {
        throw new PairingServiceError('Pairing service is unavailable', response.status);
      }
      const body: unknown = await response.json();
      const parsed = PairingStatusSchema.safeParse(body);
      if (!parsed.success) {
        throw new PairingServiceError('Pairing service returned an unreadable status', 502);
      }
      return parsed.data;
    },
  };
}
