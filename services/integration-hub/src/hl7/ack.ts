/**
 * HL7 v2 acknowledgements.
 *
 * `MSA-1` carries the whole meaning of an interface:
 *
 *  * `AA` — accepted. **The hub says this only after the frame is durably
 *    stored.** An analyzer that receives `AA` deletes its copy; saying it before
 *    the row is committed is a design that loses results, and the ingress is
 *    arranged so the two cannot be reordered by accident.
 *  * `AE` — application error: the message arrived intact and this system could
 *    not act on it (an unmapped instrument code, an instrument that is not
 *    `live`). Most analyzers do not resend on `AE`, which is why an `AE` is
 *    always paired with a retained message and an error-queue row.
 *  * `AR` — application reject: the message could not be understood at all
 *    (bad delimiters, truncated frame, wrong type). Analyzers do resend on `AR`,
 *    which is what we want, and the frame is retained regardless.
 *
 * The ACK echoes the sender's addressing back at it — `MSH-3/4` become `MSH-5/6`
 * — because an analyzer that receives an ACK addressed to somebody else logs a
 * routing error and, on several makes, closes the connection.
 *
 * `docs/04` §2: nothing from the inbound message body is copied into `MSA-3`.
 * The only inbound value that crosses into the ACK is `MSH-10`, a control id,
 * which identifies a message rather than a person.
 */
import { DEFAULT_HL7_DELIMITERS, type Hl7Delimiters } from './delimiters.js';
import { buildHl7, hl7Field, hl7Timestamp, type Hl7Message } from './message.js';

export type AckCode = 'AA' | 'AE' | 'AR';

export interface AckIdentity {
  /** `MSH-3` on the ACK. The LIS, as the analyzer is configured to know it. */
  readonly sendingApplication: string;
  /** `MSH-4`. */
  readonly sendingFacility: string;
  /** HL7 version to declare in `MSH-12`, when the inbound message did not. */
  readonly defaultVersion?: string;
}

export interface BuildAckInput {
  readonly identity: AckIdentity;
  readonly code: AckCode;
  /** Free text for `MSA-3`. Must be our own words — never inbound content. */
  readonly text?: string;
  /** Machine-readable reason for `ERR-3`, e.g. `unmatched_sample`. */
  readonly errorCode?: string;
  readonly controlId: string;
  readonly now: Date;
}

/** Acknowledges a message that parsed. */
export function buildAck(inbound: Hl7Message, input: BuildAckInput): string {
  const delimiters = inbound.delimiters;
  const msh = inbound.segment('MSH');
  const trigger = msh?.component(9, 2) ?? '';
  const processingId = msh?.component(11, 1) ?? 'P';
  const version = msh?.component(12, 1) ?? input.identity.defaultVersion ?? '2.5.1';

  return ackText({
    delimiters,
    identity: input.identity,
    receivingApplication: inbound.sendingApplication(),
    receivingFacility: inbound.sendingFacility(),
    trigger,
    processingId,
    version,
    controlId: input.controlId,
    now: input.now,
    code: input.code,
    originalControlId: inbound.controlId(),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
  });
}

/**
 * Acknowledges a frame that could not be parsed at all.
 *
 * There is nothing to echo — the delimiters are exactly what could not be read —
 * so the reply is built with the defaults and `MSA-2` carries a placeholder. An
 * analyzer that cannot correlate this ACK will resend, which is the correct
 * outcome for a frame that arrived corrupt.
 */
export function buildRejectAck(input: {
  readonly identity: AckIdentity;
  readonly reason: string;
  readonly errorCode: string;
  readonly controlId: string;
  readonly now: Date;
}): string {
  return ackText({
    delimiters: DEFAULT_HL7_DELIMITERS,
    identity: input.identity,
    receivingApplication: '',
    receivingFacility: '',
    trigger: '',
    processingId: 'P',
    version: input.identity.defaultVersion ?? '2.5.1',
    controlId: input.controlId,
    now: input.now,
    code: 'AR',
    originalControlId: 'UNKNOWN',
    text: input.reason,
    errorCode: input.errorCode,
  });
}

interface AckTextInput {
  readonly delimiters: Hl7Delimiters;
  readonly identity: AckIdentity;
  readonly receivingApplication: string;
  readonly receivingFacility: string;
  readonly trigger: string;
  readonly processingId: string;
  readonly version: string;
  readonly controlId: string;
  readonly now: Date;
  readonly code: AckCode;
  readonly originalControlId: string;
  readonly text?: string;
  readonly errorCode?: string;
}

function ackText(input: AckTextInput): string {
  const d = input.delimiters;
  const encoding = `${d.component}${d.repetition}${d.escape}${d.subcomponent}`;
  const messageType =
    input.trigger.length === 0 ? 'ACK' : `ACK${d.component}${input.trigger}${d.component}ACK`;

  const segments: string[][] = [
    [
      'MSH',
      encoding,
      hl7Field(input.identity.sendingApplication, d),
      hl7Field(input.identity.sendingFacility, d),
      hl7Field(input.receivingApplication, d),
      hl7Field(input.receivingFacility, d),
      hl7Timestamp(input.now),
      '',
      messageType,
      hl7Field(input.controlId, d),
      hl7Field(input.processingId, d),
      hl7Field(input.version, d),
    ],
    [
      'MSA',
      input.code,
      hl7Field(input.originalControlId, d),
      input.text === undefined ? '' : hl7Field(input.text, d),
    ],
  ];

  if (input.code !== 'AA' && input.errorCode !== undefined) {
    // ERR-3 is the coded error; ERR-4 the severity. `E` for both AE and AR: a
    // rejected message is an error to the sender either way, and `W` would let
    // an analyzer treat a refusal as advisory.
    segments.push([
      'ERR',
      '',
      '',
      `${hl7Field(input.errorCode, d)}${d.component}${hl7Field(input.text ?? input.errorCode, d)}${d.component}HL70357`,
      'E',
    ]);
  }

  return buildHl7(segments, d);
}
