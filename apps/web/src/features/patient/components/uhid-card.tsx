'use client';

import type { PatientDetail } from '../api/types';
import { formatAge, formatBloodGroup, formatDate } from '../lib/format';

/**
 * The UHID card, at the size it prints (OP-001 §14 AC-1, AC-16).
 *
 * Two rules from the specification are visible in the markup and are the reason
 * this is a component rather than a `<div>` inside the desk:
 *
 *  - **NABH's two-identifier rule** (§5): every printed label carries name **and**
 *    UHID, plus age/sex. All three are here, and none of them is optional.
 *  - **§14 AC-16**: the card contains "no Aadhaar/ABHA number". Neither is
 *    rendered, and there is no prop that could carry one.
 *
 * What is missing and is knowingly missing: the QR code. EN-013 owns barcode
 * rendering, `packages/ui` has a scanner input but no encoder, and a fake QR on a
 * card that scanners are meant to read would be worse than none. The UHID is
 * printed in the display face at size so it can be keyed reliably in the meantime.
 */
export function UhidCard({ patient }: { readonly patient: PatientDetail }): React.JSX.Element {
  return (
    <div
      data-testid="uhid-card"
      className="flex h-full w-full flex-col justify-between gap-1 p-2 text-fg-default"
    >
      <div>
        <p className="font-display text-2xs uppercase tracking-[0.08em] text-fg-subtle">
          Patient identity card
        </p>
        <p className="mt-1 text-md font-semibold leading-tight">{patient.full_name}</p>
      </div>

      <div>
        <p className="font-display text-lg leading-none" data-testid="uhid-card-uhid">
          {patient.uhid}
        </p>
        <p className="mt-1 text-2xs text-fg-muted">
          {formatAge(patient)} · {patient.gender}
          {patient.blood_group === 'unknown' ? '' : ` · ${formatBloodGroup(patient.blood_group)}`}
        </p>
        <p className="text-2xs text-fg-muted">Registered {formatDate(patient.registered_at)}</p>
      </div>
    </div>
  );
}
