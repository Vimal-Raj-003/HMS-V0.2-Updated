'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  ConfirmWithReasonDialog,
  EmptyState,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@vims/ui';
import { EyeOff, Settings2, SlidersHorizontal } from '@/lib/icons';
import { useMemo, useState } from 'react';
import { useSession } from '@/lib/session-context';
import { listSettings, putSetting } from '../api/client';
import { adminKeys } from '../api/keys';
import type { EffectiveSetting } from '../api/types';
import { formatCount, formatTimestamp } from '../lib/format';
import { AsyncPanel } from './async-panel';
import { PageHeader } from './page-header';
import { ProblemCard } from './problem-card';

/**
 * Settings (EN-007 §3.1.2).
 *
 * Settings are declared in code (`packages/contracts/settings.ts`), which is what
 * lets this screen show a label, a description, the value's provenance and the
 * governance attached to the key — rather than a bag of free-form rows an
 * administrator has to guess at.
 *
 * A `secret` key arrives masked from the API and is rendered as masked here. The
 * masking happens server-side, before the value reaches a response body, an audit
 * diff or a log line (EN-007 §5): a UI that masked it would leak the value to
 * anyone who opened the network tab.
 */
export function SettingsScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = adminKeys(hospitalId);
  const queryClient = useQueryClient();
  const canConfigure = granted.has('admin.settings.configure');

  const [search, setSearch] = useState('');
  const [module, setModule] = useState<string | null>(null);
  const [editing, setEditing] = useState<EffectiveSetting | null>(null);

  const query = useQuery({
    queryKey: keys.settings(module, search),
    queryFn: ({ signal }) =>
      listSettings(
        { ...(module === null ? {} : { module }), ...(search.trim() === '' ? {} : { q: search.trim() }) },
        { signal },
      ),
  });

  const items = useMemo(() => query.data?.items ?? [], [query.data]);
  const modules = useMemo(() => [...new Set(items.map((item) => item.module))].sort(), [items]);

  const save = useMutation({
    mutationFn: putSetting,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...keys.root, 'settings'] });
      setEditing(null);
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="EN-007"
        title="Settings"
        description="Typed configuration declared by each module. Every change records its before and after in the audit log; keys marked for approval or dual control route through the approval engine rather than landing directly."
        meta={
          <Badge tone="neutral" icon={<SlidersHorizontal aria-hidden="true" />}>
            {formatCount(items.length)} keys
          </Badge>
        }
      />

      {save.isError ? <ProblemCard error={save.error} /> : null}

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-default bg-layer-1 p-3">
        <div className="min-w-60 flex-1">
          <Label htmlFor="settings-search">Search</Label>
          <Input
            id="settings-search"
            type="search"
            value={search}
            placeholder="key, label or description"
            data-testid="settings-search"
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="w-56">
          <Label htmlFor="settings-module">Module</Label>
          <Select
            value={module ?? 'all'}
            onValueChange={(value) => {
              setModule(value === 'all' ? null : value);
            }}
          >
            <SelectTrigger id="settings-module">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All modules</SelectItem>
              {modules.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <AsyncPanel
        loading={query.isPending}
        error={query.error}
        isEmpty={items.length === 0}
        onRetry={() => void query.refetch()}
        skeletonLabel="Loading settings"
        skeletonRows={10}
        skeletonColumns={[4, 2, 1]}
        empty={
          <EmptyState
            icon={<Settings2 />}
            cause="No setting matches this search."
            nextAction="Clear the search — every module declares its keys in code, so the catalogue is never empty."
            action={{
              label: 'Clear search',
              onSelect: () => {
                setSearch('');
                setModule(null);
              },
            }}
          />
        }
      >
        <ul className="flex flex-col gap-2" data-testid="settings-list">
          {items.map((setting) => (
            <li
              key={setting.key}
              className="flex flex-wrap items-start gap-3 rounded-lg border border-default bg-layer-1 p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="text-md font-medium text-fg-default">{setting.label}</span>
                  <Badge tone="neutral" size="sm">
                    {setting.module}
                  </Badge>
                  {setting.masked ? (
                    <Badge tone="violet" size="sm" icon={<EyeOff aria-hidden="true" />}>
                      secret
                    </Badge>
                  ) : null}
                  {setting.requiresApproval ? (
                    <Badge tone="warning" size="sm">
                      needs approval
                    </Badge>
                  ) : null}
                  {setting.dualControl ? (
                    <Badge tone="danger" size="sm">
                      dual control
                    </Badge>
                  ) : null}
                </p>
                <p className="font-mono text-xs text-fg-muted">{setting.key}</p>
                <p className="mt-1 max-w-[72ch] text-sm text-fg-muted">{setting.description}</p>
                <p className="mt-1 text-xs text-fg-subtle">
                  Set at: {setting.source}
                  {setting.updatedAt === null ? '' : ` · changed ${formatTimestamp(setting.updatedAt)}`}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-3">
                <output className="max-w-56 truncate rounded-md bg-sunken px-2 py-1 font-mono text-xs">
                  {renderValue(setting.value)}
                </output>
                {canConfigure && !setting.masked ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setEditing(setting);
                    }}
                  >
                    Change
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </AsyncPanel>

      {editing === null ? null : (
        <EditSettingDialog
          setting={editing}
          saving={save.isPending}
          onCancel={() => {
            setEditing(null);
          }}
          onSave={(value, reason) => {
            save.mutate({ key: editing.key, scope: 'hospital', scopeId: null, value, reason });
          }}
        />
      )}
    </div>
  );
}

export function renderValue(value: unknown): string {
  if (value === null || value === undefined) return 'not set';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * The editor picks its control from the value's type rather than offering a JSON
 * box for everything. A boolean setting edited as the text `"false"` is a
 * classic configuration outage — the string is truthy — and the type is already
 * known from the declared default.
 */
function EditSettingDialog({
  setting,
  saving,
  onCancel,
  onSave,
}: {
  readonly setting: EffectiveSetting;
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly onSave: (value: unknown, reason: string) => void;
}): React.JSX.Element {
  const current = setting.value ?? setting.defaultValue;
  const kind = typeof current === 'boolean' ? 'boolean' : typeof current === 'number' ? 'number' : 'json';

  const [booleanValue, setBooleanValue] = useState(current === true);
  const [textValue, setTextValue] = useState(
    typeof current === 'string' ? current : JSON.stringify(current ?? null, null, 2),
  );
  const [confirmOpen, setConfirmOpen] = useState(false);

  const parsed = parseValue(kind, booleanValue, textValue);

  return (
    <div
      className="rounded-lg border border-accent-border bg-accent-surface p-3"
      role="region"
      aria-label={`Change ${setting.label}`}
    >
      <h2 className="text-md font-medium text-accent-on-surface">Change {setting.label}</h2>
      <p className="font-mono text-xs text-fg-muted">{setting.key}</p>

      <div className="mt-3 flex flex-col gap-2">
        {kind === 'boolean' ? (
          <span className="flex items-center gap-2">
            <Switch
              id="setting-boolean"
              checked={booleanValue}
              onCheckedChange={setBooleanValue}
              aria-describedby="setting-hint"
            />
            <Label htmlFor="setting-boolean">{booleanValue ? 'On' : 'Off'}</Label>
          </span>
        ) : kind === 'number' ? (
          <>
            <Label htmlFor="setting-number">Value</Label>
            <Input
              id="setting-number"
              type="number"
              value={textValue}
              aria-describedby="setting-hint"
              onChange={(event) => {
                setTextValue(event.target.value);
              }}
            />
          </>
        ) : (
          <>
            <Label htmlFor="setting-json">Value (JSON)</Label>
            <Textarea
              id="setting-json"
              value={textValue}
              aria-invalid={parsed.ok ? undefined : true}
              aria-describedby="setting-hint"
              data-testid="setting-json"
              onChange={(event) => {
                setTextValue(event.target.value);
              }}
            />
          </>
        )}
        <p id="setting-hint" className="text-xs text-fg-muted">
          Default: <span className="font-mono">{renderValue(setting.defaultValue)}</span>. The API validates
          the value against the schema the owning module declared, so an invalid value is refused rather than
          stored.
        </p>
        {parsed.ok ? null : (
          <p role="alert" className="text-xs text-danger-fg">
            That is not valid JSON, so it cannot be saved yet.
          </p>
        )}
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!parsed.ok || saving}
          aria-busy={saving}
          data-testid="setting-save"
          onClick={() => {
            setConfirmOpen(true);
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      <ConfirmWithReasonDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        labels={{
          title: `Change ${setting.label}`,
          description: setting.requiresApproval
            ? 'This key needs approval, so the change is raised as a request rather than applied now. Your reason is what the approver reads.'
            : 'The change applies to the whole hospital and its before and after values are written to the audit log.',
          reasonLabel: 'Reason',
          reasonPlaceholder: 'Choose a reason',
          notePlaceholder: 'e.g. NABH audit finding 12 — shorten the idle timeout on clinical screens',
          confirm: 'Save the setting',
          cancel: 'Keep editing',
          typedValuePrompt: (expected) => `Type ${expected} to confirm`,
          reasonRequired: 'A reason is required for a configuration change.',
          typedValueMismatch: 'The value must match exactly.',
        }}
        onConfirm={(result) => {
          setConfirmOpen(false);
          if (parsed.ok) onSave(parsed.value, result.reasonText);
        }}
      />
    </div>
  );
}

type ParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

export function parseValue(
  kind: 'boolean' | 'number' | 'json',
  booleanValue: boolean,
  textValue: string,
): ParseResult {
  if (kind === 'boolean') return { ok: true, value: booleanValue };
  if (kind === 'number') {
    const numeric = Number(textValue);
    return Number.isFinite(numeric) ? { ok: true, value: numeric } : { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(textValue) as unknown };
  } catch {
    // A string setting is the common case where the JSON box holds bare text.
    return textValue.trim() === '' ? { ok: false } : { ok: true, value: textValue };
  }
}
