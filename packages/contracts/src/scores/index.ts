/**
 * Clinical scores as pure functions.
 *
 * `phase-06`: "Scores are code, not opinion. RTS/ISS/NISS/TRISS/GCS live as pure
 * functions in `packages/contracts/scores` with property-based tests and worked
 * examples from the literature; the same function runs on client and server.
 * Never let a UI compute a score the server does not agree with."
 *
 * Nothing here touches a database, a clock or a random number. Given the same
 * observations they return the same number on a tablet in a resus bay, in the
 * API, and in a registry export three years later.
 */
export * from './esi.js';
export * from './gcs.js';
export * from './trauma.js';
