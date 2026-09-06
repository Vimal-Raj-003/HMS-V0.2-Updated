'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { CONSOLE_COMPONENT_CATALOGUE, validateConsoleTabs, type ConsoleTab } from '@vims/contracts';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { getConsoles, registerConsole, updateConsole } from '../api/client';
import { specialtyKeys } from '../api/keys';
import type { ConsoleRow } from '../api/types';

const inputClass = 'h-10 w-full rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

/**
 * Composing a specialty console (OP-025 §0.1).
 *
 * ── The palette is the catalogue ────────────────────────────────────────────
 *
 * A tab is chosen from what this build ships, never typed. F1 makes registering
 * a console a data change with no deploy, and the only thing standing between
 * that freedom and a department opening a blank workspace is that the registry
 * cannot name a component nobody wrote. The database enforces it; this screen
 * simply never offers the chance.
 *
 * ── Every console can be switched off ───────────────────────────────────────
 *
 * The licence key is a required field, not a nicety: `phase-08` gate 11 says
 * every console must be invisible when off, and a console with no key could not
 * be.
 */
export function ConsoleRegistryScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = specialtyKeys(hospitalId);
  const client = useQueryClient();

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [moduleKey, setModuleKey] = useState('');
  const [tabs, setTabs] = useState<ConsoleTab[]>([]);

  const consoles = useQuery({
    queryKey: keys.consoles('all'),
    queryFn: ({ signal }) => getConsoles({ activeOnly: false }, { signal }),
  });

  function invalidate(): void {
    void client.invalidateQueries({ queryKey: keys.consolesRoot() });
  }

  const create = useMutation({
    mutationFn: () => registerConsole({ code, name, moduleKey, tabs, departmentIds: [] }),
    onSuccess: () => {
      setCode('');
      setName('');
      setModuleKey('');
      setTabs([]);
      invalidate();
    },
  });

  const toggle = useMutation({
    mutationFn: (input: { readonly id: string; readonly isActive: boolean }) =>
      updateConsole(input.id, { isActive: input.isActive }),
    onSuccess: invalidate,
  });

  const rows: readonly ConsoleRow[] = consoles.data ?? [];
  const problems = tabs.length === 0 ? [] : validateConsoleTabs(tabs);
  const canSave =
    code.trim() !== '' &&
    name.trim() !== '' &&
    moduleKey.trim() !== '' &&
    tabs.length > 0 &&
    problems.length === 0;

  function addTab(componentKey: string): void {
    const found = CONSOLE_COMPONENT_CATALOGUE.find((c) => c.key === componentKey);
    if (found === undefined || tabs.some((t) => t.key === componentKey)) return;
    setTabs([
      ...tabs,
      found.kind === 'form_template'
        ? { key: componentKey, label: found.label, formTemplateKey: componentKey }
        : { key: componentKey, label: found.label, component: componentKey },
    ]);
  }

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Specialty consoles"
        description="Which specialties have a workspace of their own, what is on it, and which departments open it."
      />

      {granted.has('console.registry.configure') ? (
        <div className="flex flex-col gap-4 rounded-lg border border-strong bg-layer-1 p-4">
          <h2 className="text-base font-semibold text-fg-default">Register a console</h2>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="cn-code">
                Code
              </label>
              <input
                id="cn-code"
                className={inputClass}
                placeholder="OPHTHA"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.toUpperCase());
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="cn-name">
                Name
              </label>
              <input
                id="cn-name"
                className={inputClass}
                placeholder="Ophthalmology"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="cn-module">
                Licence key
              </label>
              <input
                id="cn-module"
                className={inputClass}
                placeholder="module.ophthalmology.enabled"
                value={moduleKey}
                onChange={(e) => {
                  setModuleKey(e.target.value);
                }}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-2xs uppercase tracking-[0.08em] text-fg-subtle">
              Tabs — chosen from what this build ships
            </span>
            <div className="flex flex-wrap gap-1">
              {CONSOLE_COMPONENT_CATALOGUE.filter((c) => c.deprecated !== true).map((c) => (
                <Button
                  key={c.key}
                  size="sm"
                  variant={tabs.some((t) => t.key === c.key) ? 'primary' : 'secondary'}
                  onClick={() => {
                    if (tabs.some((t) => t.key === c.key)) {
                      setTabs(tabs.filter((t) => t.key !== c.key));
                    } else {
                      addTab(c.key);
                    }
                  }}
                >
                  {c.label}
                </Button>
              ))}
            </div>
            {tabs.length > 0 ? (
              <p className="text-2xs text-fg-muted">{`In order: ${tabs.map((t) => t.label).join(' · ')}`}</p>
            ) : null}
            {problems.length > 0 ? (
              <ul className="flex flex-col gap-1 text-2xs text-fg-warning">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
          </div>

          <div>
            <Button
              size="sm"
              disabled={!canSave || create.isPending}
              onClick={() => {
                create.mutate();
              }}
            >
              Register
            </Button>
          </div>
          {create.error === null ? null : <ProblemCard error={create.error} />}
        </div>
      ) : null}

      <AsyncPanel
        loading={consoles.isPending}
        error={consoles.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading consoles"
        skeletonRows={5}
        onRetry={() => {
          void consoles.refetch();
        }}
        empty={
          <EmptyState
            cause="No specialty console is registered."
            nextAction="Register one from the components above; it appears for its departments on their next patient."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="console-registry">
            <caption className="sr-only">Registered specialty consoles</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['Code', 'Name', 'Licence key', 'Tabs', 'Departments', 'State', ''].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 text-start">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.id}
                  className="border-b border-default last:border-0"
                  data-testid={`console-${c.code}`}
                >
                  <td className="px-3 py-2 font-mono text-2xs">{c.code}</td>
                  <td className="px-3 py-2 font-medium">{c.name}</td>
                  <td className="px-3 py-2 font-mono text-2xs text-fg-muted">{c.moduleKey}</td>
                  <td className="px-3 py-2 text-2xs">{c.tabs.map((t) => t.label).join(' · ')}</td>
                  <td className="px-3 py-2 text-2xs">
                    {c.departmentIds.length === 0 ? 'none yet' : String(c.departmentIds.length)}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={c.isActive ? 'success' : 'neutral'}>{c.isActive ? 'on' : 'off'}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    {granted.has('console.registry.configure') ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={toggle.isPending}
                        onClick={() => {
                          toggle.mutate({ id: c.id, isActive: !c.isActive });
                        }}
                      >
                        {c.isActive ? 'Switch off' : 'Switch on'}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      {toggle.error === null ? null : <ProblemCard error={toggle.error} />}

      <p className="text-2xs text-fg-subtle">
        A tab can only point at a component this build ships — the database refuses anything else, because a
        tab pointing at nothing is a blank workspace for a whole department. Switching a console off hides it
        everywhere: navigation, search and the command palette.
      </p>
    </section>
  );
}
