/**
 * `@vims/integration-hub/messaging` — EN-009, assembled.
 *
 * Everything a service needs to send an SMS or a WhatsApp template through the
 * hub: the DLT registry that refuses an unregistered or drifted template, the
 * multi-language template catalogue, the consent/DND ledger, the cost ledger,
 * the normalised delivery model and the send pipeline that sequences them.
 */
export * from './locales.js';
export * from './types.js';
export * from './phone.js';
export * from './segments.js';
export * from './content-lint.js';
export * from './template-catalogue.js';
export * from './dlt-registry.js';
export * from './consent-ledger.js';
export * from './cost-ledger.js';
export * from './directory.js';
export * from './payload-schemas.js';
export * from './messaging-service.js';
export * from './http/transport.js';
export * from './http/errors.js';
export * from './http/signature.js';
