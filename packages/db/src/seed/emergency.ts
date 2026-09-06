import type { SeedContext } from './context.js';
import { SEED_EPOCH, seedId } from './ids.js';
import type { SeededTenancy } from './tenancy.js';
import type { SeedRow } from './upsert.js';

/**
 * OP-006 — an ER floor that can actually take a patient.
 *
 * The zones are the ones `phase-06` §6.1 names, in the order a department is
 * usually laid out: triage at the door, resus nearest it, then acute, then
 * everything that can wait. `sort_order` is the board's left-to-right, so it is
 * the physical walk rather than an alphabet.
 *
 * Bay counts are deliberately small — two resus bays, four acute, four
 * fast-track. A demo tenancy with forty bays looks impressive and hides every
 * capacity behaviour worth seeing; with ten, a surge fills the department and
 * the board does what it is supposed to do.
 */

interface ZoneSpec {
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly sortOrder: number;
  readonly bays: ReadonlyArray<{
    readonly code: string;
    readonly name: string;
    readonly kind: string;
    readonly monitor?: boolean;
    readonly ventilator?: boolean;
  }>;
}

const ZONES: readonly ZoneSpec[] = [
  {
    code: 'TRIAGE',
    name: 'Triage',
    kind: 'triage',
    sortOrder: 10,
    bays: [{ code: 'T1', name: 'Triage desk', kind: 'chair' }],
  },
  {
    code: 'RESUS',
    name: 'Resuscitation',
    kind: 'resus',
    sortOrder: 20,
    bays: [
      { code: 'R1', name: 'Resus 1', kind: 'resus_bay', monitor: true, ventilator: true },
      { code: 'R2', name: 'Resus 2', kind: 'resus_bay', monitor: true, ventilator: true },
    ],
  },
  {
    code: 'ACUTE',
    name: 'Acute',
    kind: 'acute',
    sortOrder: 30,
    bays: [
      { code: 'A1', name: 'Acute 1', kind: 'trolley', monitor: true },
      { code: 'A2', name: 'Acute 2', kind: 'trolley', monitor: true },
      { code: 'A3', name: 'Acute 3', kind: 'trolley' },
      { code: 'A4', name: 'Acute 4', kind: 'trolley' },
    ],
  },
  {
    code: 'FAST',
    name: 'Fast track',
    kind: 'fast_track',
    sortOrder: 40,
    bays: [
      { code: 'F1', name: 'Fast track 1', kind: 'chair' },
      { code: 'F2', name: 'Fast track 2', kind: 'chair' },
    ],
  },
  {
    code: 'OBS',
    name: 'Observation',
    kind: 'observation',
    sortOrder: 50,
    bays: [
      { code: 'O1', name: 'Observation 1', kind: 'trolley' },
      { code: 'O2', name: 'Observation 2', kind: 'trolley' },
    ],
  },
  {
    code: 'ISO',
    name: 'Isolation',
    kind: 'isolation',
    sortOrder: 60,
    bays: [{ code: 'I1', name: 'Isolation room', kind: 'isolation_room', monitor: true }],
  },
];

export async function seedEmergency(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  for (const hospital of tenancy.hospitals) {
    for (const branch of hospital.branches) {
      const zones: SeedRow[] = ZONES.map((zone) => ({
        id: seedId('er-zone', hospital.code, branch.code, zone.code),
        hospital_id: hospital.id,
        branch_id: branch.id,
        code: zone.code,
        name: zone.name,
        kind: zone.kind,
        sort_order: zone.sortOrder,
        is_active: true,
        created_at: SEED_EPOCH,
        updated_at: SEED_EPOCH,
      }));
      await ctx.write({ table: 'clinical.er_zones', conflict: ['id'] }, zones);

      const bays: SeedRow[] = ZONES.flatMap((zone) =>
        zone.bays.map((bay) => ({
          id: seedId('er-bay', hospital.code, branch.code, bay.code),
          hospital_id: hospital.id,
          branch_id: branch.id,
          zone_id: seedId('er-zone', hospital.code, branch.code, zone.code),
          code: bay.code,
          name: bay.name,
          kind: bay.kind,
          // Scanned to assign without typing (§6.1). Deterministic so a printed
          // demo barcode keeps working across re-seeds.
          barcode: `ERBAY-${branch.code}-${bay.code}`,
          status: 'free',
          current_visit_id: null,
          has_monitor: bay.monitor ?? false,
          has_ventilator: bay.ventilator ?? false,
          has_oxygen: true,
          vacated_at: null,
          is_active: true,
          created_at: SEED_EPOCH,
          updated_at: SEED_EPOCH,
        })),
      );
      await ctx.write({ table: 'clinical.er_bays', conflict: ['id'] }, bays);
    }
  }
}
