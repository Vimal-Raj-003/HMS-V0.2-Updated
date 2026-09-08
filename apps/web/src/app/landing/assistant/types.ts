/** The shapes `/api/assistant/*` returns. Mirrors `assistant.schemas.ts` in the API. */

export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface AssistantIntent {
  readonly kind: 'book_appointment';
  readonly specialityKey?: string;
  readonly specialityName?: string;
}

export interface ChatResponse {
  readonly reply: string;
  readonly safety: 'none' | 'emergency' | 'clinical';
  readonly source: 'safety' | 'model' | 'directory';
  readonly intent: AssistantIntent | null;
  readonly suggestions: readonly string[];
}

export interface PublicSpeciality {
  readonly key: string;
  readonly code: string;
  readonly name: string;
  readonly telemedicineAllowed: boolean;
}

export interface PublicDirectory {
  readonly hospitalName: string;
  readonly specialities: readonly PublicSpeciality[];
  readonly practitioners: readonly {
    readonly key: string;
    readonly displayName: string;
    readonly qualifications: readonly string[];
  }[];
}

export interface RequestReceipt {
  readonly id: string;
  readonly status: 'new';
  readonly message: string;
}

/**
 * The exact wording a visitor agrees to, and the version stored beside their
 * row. `CONSENT_TEXT_VERSION` in `requests.service.ts` must move whenever this
 * sentence does — a consent whose wording nobody can reconstruct is not
 * evidence of anything (DPDP 2023 §6).
 */
export const CONSENT_TEXT =
  'I agree that the hospital may store my name and phone number and call me back about this request.';
