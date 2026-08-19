/**
 * A print context for tests and for the admin console's "preview with sample
 * data" screen (`EN-005 §14.11`). Deliberately synthetic — `docs/09 §11`: no
 * production PHI ever reaches a lower environment.
 */

import type { PrintContext } from './types.js';

export function sampleContext(overrides: Partial<PrintContext> = {}): PrintContext {
  return {
    hospital: {
      name: "Vim's Trauma & Multispeciality Hospital",
      legalName: 'VIMS Healthcare Private Limited',
      addressLines: ['Plot 14, Ring Road', 'Coimbatore 641004, Tamil Nadu'],
      phone: '+91 422 400 1200',
      email: 'care@example.invalid',
      gstin: '33AABCV1234F1Z5',
      accreditationLine: 'NABH accredited · NABL M-0000',
    },
    branch: {
      name: 'Main Campus',
      addressLines: ['Block A, Ground Floor'],
      phone: '+91 422 400 1210',
    },
    locale: 'en-IN',
    direction: 'ltr',
    printedAtLabel: '20-Aug-2026 09:14',
    printedBy: 'R. Devi (Front Office)',
    documentRef: 'OPB-2026-000481',
    duplicate: false,
    ...overrides,
  };
}
