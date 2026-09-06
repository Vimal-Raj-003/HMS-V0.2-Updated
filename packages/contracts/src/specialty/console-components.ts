/**
 * What a specialty console tab may point at — the catalogue this build ships.
 *
 * OP-025 §0.9 F1: registering a console in `mdm.specialty_consoles` makes its
 * tabs appear for the mapped departments **with no code deploy**. That is a real
 * freedom and it has one price: the registry may compose what exists, it may not
 * invent. A tab naming a component nobody wrote renders as a blank panel for a
 * whole department, and the person who discovers it is a clinician with a
 * patient in the chair.
 *
 * So this file is to `mdm.console_components` exactly what `PERMISSION_CATALOGUE`
 * is to `core.permissions`: the seed writes it as `hms_migrator`, the running
 * service verifies it at boot, and a database trigger refuses any console whose
 * tabs name something absent from it. The application role can neither write the
 * catalogue nor register a console that outruns it.
 *
 * ── Adding a component ──────────────────────────────────────────────────────
 *
 * Write the component, add its key here, re-run the seed. Removing one is
 * `deprecated: true`, never a deletion — consoles already registered against it
 * must keep resolving to something explicable, and the trigger refuses only
 * *new* registrations that name it.
 */

export type ConsoleComponentKind = 'tab_component' | 'form_template';

export interface ConsoleComponentDefinition {
  /** `<console>.<tab>` for a component; the template key for a form. */
  readonly key: string;
  readonly kind: ConsoleComponentKind;
  readonly label: string;
  /** What a hospital admin composing a console needs to know about this tab. */
  readonly description: string;
  /**
   * Present in the database, absent from this build. Existing consoles still
   * resolve it; new registrations naming it are refused.
   */
  readonly deprecated?: boolean;
}

function component(key: string, label: string, description: string): ConsoleComponentDefinition {
  return { key, kind: 'tab_component', label, description };
}

/**
 * The generic tabs, available to every console.
 *
 * OP-025 §0.1: "generic tabs (history, Rx, orders, timeline, notes) remain
 * reachable at all times." A console that hides the rest of the chart is how a
 * specialist misses the allergy, so these are not optional furniture — they are
 * the reason a console is an overlay and not a separate application.
 */
const GENERIC: readonly ConsoleComponentDefinition[] = [
  component('generic.history', 'History', 'Problems, past encounters, allergies and the patient banner.'),
  component('generic.prescription', 'Prescription', 'The OP-002 e-prescribing pane, with the CDSS floor.'),
  component('generic.orders', 'Orders', 'Diagnostics and procedures ordered from this encounter.'),
  component('generic.timeline', 'Timeline', 'Everything that has happened to this patient, newest first.'),
  component('generic.notes', 'Notes', 'Free clinical narrative, versioned and signed like any document.'),
  component(
    'generic.investigations',
    'Investigations',
    'The shared device-result pane: ordered, performed, attached, reviewed — with prior comparison.',
  ),
];

export const CONSOLE_COMPONENT_CATALOGUE: readonly ConsoleComponentDefinition[] = Object.freeze([...GENERIC]);

const byKey = new Map(CONSOLE_COMPONENT_CATALOGUE.map((c) => [c.key, c]));

// A duplicate key would mean two components claiming one tab, and the registry
// trigger would happily accept whichever the seed wrote last.
if (byKey.size !== CONSOLE_COMPONENT_CATALOGUE.length) {
  const seen = new Set<string>();
  const dupes = CONSOLE_COMPONENT_CATALOGUE.map((c) => c.key).filter((k) =>
    seen.has(k) ? true : (seen.add(k), false),
  );
  throw new Error(`Duplicate console component keys: ${[...new Set(dupes)].join(', ')}`);
}

export function getConsoleComponent(key: string): ConsoleComponentDefinition | undefined {
  return byKey.get(key);
}

/**
 * A console tab, as stored in `mdm.specialty_consoles.tabs`.
 *
 * Exactly one of `component` and `formTemplateKey`. Neither is a blank panel;
 * both is two things claiming one pane with no way to say which wins — and the
 * database refuses both cases rather than picking.
 */
export interface ConsoleTab {
  readonly key: string;
  readonly label: string;
  readonly component?: string | undefined;
  readonly formTemplateKey?: string | undefined;
  /** Roles that see this tab. Empty or absent means every role on the console. */
  readonly roles?: readonly string[] | undefined;
}

/**
 * Checks a set of tabs the way the database trigger does.
 *
 * Used by the admin screen so a hospital admin composing a console is told what
 * is wrong before they save, and by tests. It is *not* the enforcement: the
 * trigger is, because a console can be written by anything holding the
 * connection.
 */
export function validateConsoleTabs(tabs: readonly ConsoleTab[]): readonly string[] {
  const problems: string[] = [];
  if (tabs.length === 0) {
    return ['A console with no tabs is a department with a broken workspace.'];
  }

  const seen = new Set<string>();
  for (const tab of tabs) {
    if (tab.key.trim() === '' || tab.label.trim() === '') {
      problems.push('Every tab needs a key and a label.');
      continue;
    }
    if (seen.has(tab.key)) problems.push(`Two tabs share the key "${tab.key}".`);
    seen.add(tab.key);

    const hasComponent = tab.component !== undefined;
    const hasForm = tab.formTemplateKey !== undefined;
    if (hasComponent === hasForm) {
      problems.push(
        `Tab "${tab.key}" names ${hasComponent ? 'both a component and a form template' : 'neither a component nor a form template'}.`,
      );
      continue;
    }

    const key = hasComponent ? (tab.component ?? '') : (tab.formTemplateKey ?? '');
    const found = byKey.get(key);
    if (found === undefined) {
      problems.push(`Tab "${tab.key}" names ${key}, which this build does not ship.`);
    } else if (found.deprecated === true) {
      problems.push(`Tab "${tab.key}" names ${key}, which is deprecated.`);
    } else if (found.kind !== (hasComponent ? 'tab_component' : 'form_template')) {
      problems.push(
        `Tab "${tab.key}" names ${key} as a ${hasComponent ? 'component' : 'form template'}, and it is a ${found.kind.replace('_', ' ')}.`,
      );
    }
  }

  return problems;
}
