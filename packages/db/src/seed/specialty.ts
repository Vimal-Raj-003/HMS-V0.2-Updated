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

  /**
   * The six consoles that ship with the demo data, and what each can order from
   * a device.
   *
   * `sideRequired` is the field that stops an OCT being ordered without an eye
   * or an audiogram without an ear — the commonest way an imaging or testing
   * request reaches a technician meaning nothing. It is false for the studies
   * that genuinely have no side: an ECG, a spirometry manoeuvre, a sleep night,
   * a panoramic radiograph of the whole jaw.
   */
  const CONSOLES: readonly {
    readonly code: string;
    readonly name: string;
    readonly moduleKey: string;
    readonly department: string;
    readonly sortOrder: number;
    readonly worklist: Record<string, unknown>;
    readonly billing: Record<string, unknown>;
    readonly devices: readonly (readonly [string, string, string, boolean, string])[];
  }[] = [
    {
      code: 'OPHTHA',
      name: 'Ophthalmology',
      moduleKey: 'module.ophthalmology.enabled',
      department: 'OPHTH',
      sortOrder: 10,
      worklist: { lanes: ['refraction', 'dilating', 'doctor', 'imaging', 'counselling'] },
      billing: { consultation: 'OPH-CONS' },
      devices: [
        ['OCT_MACULA', 'OCT macula', 'dicom', true, 'OPH-OCT'],
        ['OCT_RNFL', 'OCT retinal nerve fibre layer', 'dicom', true, 'OPH-OCT'],
        ['FUNDUS_PHOTO', 'Fundus photograph', 'dicom', true, 'OPH-FUNDUS'],
        ['HFA_24_2', 'Humphrey visual field 24-2', 'file', true, 'OPH-HFA'],
        ['BIOMETRY', 'Optical biometry', 'file', true, 'OPH-BIO'],
      ],
    },
    {
      code: 'CARDIO',
      name: 'Cardiology',
      moduleKey: 'module.cardiology.enabled',
      department: 'CARDIO',
      sortOrder: 20,
      worklist: { lanes: ['triage', 'ecg', 'doctor', 'echo', 'counselling'] },
      billing: { consultation: 'CAR-CONS' },
      devices: [
        ['ECG_12L', 'ECG, twelve lead', 'structured', false, 'CAR-ECG'],
        ['ECHO_TTE', 'Transthoracic echocardiogram', 'dicom', false, 'CAR-TTE'],
        ['TMT', 'Treadmill stress test', 'file', false, 'CAR-TMT'],
        ['HOLTER_24', 'Ambulatory ECG, 24 hours', 'file', false, 'CAR-HOLTER'],
        ['ABPM', 'Ambulatory blood pressure, 24 hours', 'file', false, 'CAR-ABPM'],
      ],
    },
    {
      code: 'PULMO',
      name: 'Pulmonology',
      moduleKey: 'module.pulmonology.enabled',
      department: 'PULMO',
      sortOrder: 30,
      worklist: { lanes: ['triage', 'pft', 'doctor', 'bronchoscopy', 'counselling'] },
      billing: { consultation: 'PUL-CONS' },
      devices: [
        ['SPIRO', 'Spirometry, pre and post bronchodilator', 'structured', false, 'PUL-SPIRO'],
        ['DLCO', 'Diffusing capacity', 'structured', false, 'PUL-DLCO'],
        ['FENO', 'Exhaled nitric oxide', 'structured', false, 'PUL-FENO'],
        ['PSG', 'Polysomnography', 'file', false, 'PUL-PSG'],
        ['HST', 'Home sleep apnoea test', 'file', false, 'PUL-HST'],
      ],
    },
    {
      code: 'ENT',
      name: 'ENT & Audiology',
      moduleKey: 'module.ent.enabled',
      department: 'ENT',
      sortOrder: 40,
      worklist: { lanes: ['triage', 'audiology', 'doctor', 'endoscopy', 'counselling'] },
      billing: { consultation: 'ENT-CONS' },
      devices: [
        // The audiogram names an ear. Every one of these does, except the
        // endoscopy of a nose that has only one of.
        ['AUDIO_PTA', 'Pure-tone audiometry', 'structured', true, 'ENT-PTA'],
        ['TYMP', 'Tympanometry', 'structured', true, 'ENT-TYMP'],
        ['OAE', 'Otoacoustic emissions', 'structured', true, 'ENT-OAE'],
        ['BERA', 'Brainstem evoked response audiometry', 'file', true, 'ENT-BERA'],
        ['DNE', 'Diagnostic nasal endoscopy', 'file', false, 'ENT-DNE'],
      ],
    },
    {
      code: 'DENTAL',
      name: 'Dentistry',
      moduleKey: 'module.dental.enabled',
      department: 'DENTAL',
      sortOrder: 50,
      worklist: { lanes: ['triage', 'chair', 'radiograph', 'hygiene', 'counselling'] },
      billing: { consultation: 'DEN-CONS' },
      devices: [
        // An intraoral film is of one tooth and names its side; a panoramic
        // radiograph is of the whole jaw and does not.
        ['IOPA', 'Intraoral periapical radiograph', 'dicom', true, 'DEN-IOPA'],
        ['BITEWING', 'Bitewing radiograph', 'dicom', true, 'DEN-BW'],
        ['OPG', 'Orthopantomogram', 'dicom', false, 'DEN-OPG'],
        ['CBCT_DENTAL', 'Dental cone-beam CT', 'dicom', false, 'DEN-CBCT'],
        ['LATERAL_CEPH', 'Lateral cephalogram', 'dicom', false, 'DEN-CEPH'],
      ],
    },
    {
      code: 'PAIN',
      name: 'Pain Management',
      moduleKey: 'module.pain_clinic.enabled',
      department: 'PAIN',
      sortOrder: 70,
      worklist: { lanes: ['triage', 'doctor', 'intervention', 'review', 'counselling'] },
      billing: { consultation: 'PAI-CONS' },
      devices: [
        // Everything a pain clinic images is guidance for a needle, and every
        // one of them names a side.
        ['FLUORO_SPINE', 'Fluoroscopic spinal imaging', 'dicom', true, 'PAI-FLUORO'],
        ['USG_BLOCK', 'Ultrasound-guided block imaging', 'file', true, 'PAI-USG'],
        ['MRI_SPINE_REVIEW', 'MRI spine, review copy', 'dicom', false, 'PAI-MRI'],
        ['EMG_NCS', 'Electromyography and nerve conduction', 'file', true, 'PAI-EMG'],
        ['THERMOGRAPHY', 'Infrared thermography', 'file', true, 'PAI-THERMO'],
      ],
    },
    {
      code: 'DERM',
      name: 'Dermatology',
      moduleKey: 'module.dermatology.enabled',
      department: 'DERM',
      sortOrder: 60,
      worklist: { lanes: ['triage', 'doctor', 'procedure', 'phototherapy', 'counselling'] },
      billing: { consultation: 'DER-CONS' },
      devices: [
        ['DERMOSCOPY', 'Dermoscopy image', 'file', true, 'DER-DERMO'],
        ['CLINICAL_PHOTO', 'Clinical photograph series', 'file', true, 'DER-PHOTO'],
        ['WOODS_LAMP', "Wood's lamp examination", 'manual', true, 'DER-WOODS'],
        ['PATCH_TEST', 'Patch test reading', 'file', false, 'DER-PATCH'],
        ['TRICHOSCOPY', 'Trichoscopy', 'file', false, 'DER-TRICHO'],
      ],
    },
  ];

  for (const h of tenancy.hospitals) {
    for (const c of CONSOLES) {
      const consoleId = seedId('specialty-console', h.code, c.code);

      consoles.push({
        id: consoleId,
        hospital_id: h.id,
        code: c.code,
        name: c.name,
        module_key: c.moduleKey,
        department_ids: [seedId('mdm-department', h.code, c.department, 'v1')],
        tabs: jsonb(tabs),
        worklist_config: jsonb(c.worklist),
        billing_links: jsonb(c.billing),
        is_active: true,
        sort_order: c.sortOrder,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });

      for (const [code, name, transport, sideRequired, service] of c.devices) {
        deviceTypes.push({
          id: seedId('specialty-device-type', h.code, code),
          hospital_id: h.id,
          code,
          name,
          console_id: consoleId,
          transport,
          mime_types: transport === 'file' ? ['application/pdf', 'text/xml', 'image/jpeg'] : [],
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
  }

  await ctx.write({ table: 'mdm.specialty_consoles', conflict: ['id'] }, consoles);
  await ctx.write({ table: 'mdm.device_result_types', conflict: ['id'] }, deviceTypes);
}
