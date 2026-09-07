import { CONSOLE_COMPONENT_CATALOGUE } from '@vims/contracts';
import type { SeedContext } from './context.js';
import type { SeededTenancy } from './tenancy.js';
import { SEED_EPOCH, seedId } from './ids.js';
import { jsonb, type SeedRow } from './upsert.js';

/**
 * Phase 8 — the registered specialty consoles.
 *
 * A console is data (OP-025 §0.9 F1), so seeding one is exactly what a hospital
 * administrator would do on the registry screen: name it, map it to a
 * department, and compose its tabs from what the build ships. Nothing here is
 * privileged; it is a worked example that happens to arrive with the demo data.
 *
 * The tab list is checked against `mdm.console_components` by a database
 * trigger, so a component renamed in code and forgotten here fails the seed
 * rather than shipping a department a blank workspace.
 */
export async function seedSpecialtyConsoles(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const generic = new Set(CONSOLE_COMPONENT_CATALOGUE.map((c) => c.key));
  const tabs = [
    { key: 'history', label: 'History', component: 'generic.history' },
    { key: 'investigations', label: 'Investigations', component: 'generic.investigations' },
    { key: 'prescription', label: 'Prescription', component: 'generic.prescription' },
    { key: 'notes', label: 'Notes', component: 'generic.notes' },
  ].filter((tab) => generic.has(tab.component));

  const consoles: SeedRow[] = [];
  const deviceTypes: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    const consoleId = seedId('specialty-console', h.code, 'OPHTHA');
    const department = seedId('mdm-department', h.code, 'OPHTH', 'v1');

    consoles.push({
      id: consoleId,
      hospital_id: h.id,
      code: 'OPHTHA',
      name: 'Ophthalmology',
      module_key: 'module.ophthalmology.enabled',
      department_ids: [department],
      tabs: jsonb(tabs),
      worklist_config: jsonb({
        lanes: ['refraction', 'dilating', 'doctor', 'imaging', 'counselling'],
      }),
      billing_links: jsonb({ consultation: 'OPH-CONS' }),
      is_active: true,
      sort_order: 10,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
    });

    // What the eye clinic can order from a device. `side_required` is the field
    // that stops an OCT being ordered without an eye — the commonest way an
    // imaging request reaches the technician meaning nothing.
    for (const [code, name, transport, sideRequired, service] of [
      ['OCT_MACULA', 'OCT macula', 'dicom', true, 'OPH-OCT'],
      ['OCT_RNFL', 'OCT retinal nerve fibre layer', 'dicom', true, 'OPH-OCT'],
      ['FUNDUS_PHOTO', 'Fundus photograph', 'dicom', true, 'OPH-FUNDUS'],
      ['HFA_24_2', 'Humphrey visual field 24-2', 'file', true, 'OPH-HFA'],
      ['BIOMETRY', 'Optical biometry', 'file', true, 'OPH-BIO'],
    ] as const) {
      deviceTypes.push({
        id: seedId('specialty-device-type', h.code, code),
        hospital_id: h.id,
        code,
        name,
        console_id: consoleId,
        transport,
        mime_types: transport === 'file' ? ['application/pdf', 'text/xml'] : [],
        parser_key: null,
        report_template_key: null,
        billing_service_code: service,
        review_due_hours: 4,
        side_required: sideRequired,
        active: true,
        created_at: SEED_EPOCH,
        updated_at: SEED_EPOCH,
      });
    }
  }

  await ctx.write({ table: 'mdm.specialty_consoles', conflict: ['id'] }, consoles);
  await ctx.write({ table: 'mdm.device_result_types', conflict: ['id'] }, deviceTypes);
}
