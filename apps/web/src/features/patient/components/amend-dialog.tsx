'use client';

import {
  AddressForm,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@vims/ui';
import { useId, useState } from 'react';
import { TriangleAlert } from '@/lib/icons';
import type { Gender, PatientDetail } from '../api/types';
import {
  amendChanges,
  amendFormFrom,
  changedFieldLabels,
  hasChanges,
  touchesIdentity,
  type AmendChanges,
  type AmendFormState,
} from '../lib/amend';
import { isUsableReason, MIN_REASON_LENGTH } from '../lib/duplicates';
import {
  ADDRESS_LABELS,
  BLOOD_GROUPS,
  CATEGORIES,
  GENDERS,
  INDIAN_STATES,
  LANGUAGES,
  PAYER_TYPES,
} from '../lib/reference';

/**
 * A demographic amendment (OP-001 §3.2.2, §14 AC-14).
 *
 * **The reason is required twice, and both are the same string.**
 * `patient.record.update` is `requiresReason` in the permission catalogue, so the
 * policy engine refuses the request outright unless the `x-reason` header is
 * present — that is the first. The body carries a `reason` as well, and that is
 * the one written to `patient.demographic_history` and read by whoever asks, a
 * year later, why this patient's date of birth changed. `updatePatient` in
 * `api/client.ts` sends both from one field; this dialog collects it once, because
 * asking a clerk to type the same sentence twice would get "asdfasdf" typed twice.
 * The pattern is `features/admin`'s, unchanged.
 *
 * Friction level 4 (`docs/06` §6.9): confirm plus reason. Not level 5 — an
 * amendment is versioned, not destructive, and the previous value is recoverable
 * from the history. The four identity fields get a louder warning rather than a
 * typed value, because a clerk correcting a misspelled surname does that fifty
 * times a day and a typed confirmation would be muscle memory within a week.
 */
export function AmendDialog({
  patient,
  open,
  onOpenChange,
  onSubmit,
  saving,
}: {
  readonly patient: PatientDetail;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (changes: AmendChanges, reason: string) => void;
  readonly saving: boolean;
}): React.JSX.Element {
  const id = useId();
  const [draft, setDraft] = useState<AmendFormState>(() => amendFormFrom(patient));
  const [reason, setReason] = useState('');

  const changes = amendChanges(patient, draft);
  const changed = hasChanges(changes);
  const labels = changedFieldLabels(changes);
  const identity = touchesIdentity(changes);
  const canSubmit = changed && isUsableReason(reason) && !saving;

  const set = (patch: Partial<AmendFormState>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel="Close without changing anything" className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Amend {patient.full_name}</DialogTitle>
          <DialogDescription>
            Every change is versioned with your name and your reason. Nothing is overwritten — the previous
            values stay readable in the record&rsquo;s history.
          </DialogDescription>
        </DialogHeader>

        {/* Same reason as the hard stop: the reason field and Save must stay
            reachable however long the form gets. */}
        <DialogBody className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto">
          <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <Pair id={`${id}-title`} label="Title">
              <Input
                id={`${id}-title`}
                value={draft.titleCode}
                onChange={(event) => {
                  set({ titleCode: event.target.value });
                }}
              />
            </Pair>
            <Pair id={`${id}-first`} label="First name">
              <Input
                id={`${id}-first`}
                value={draft.firstName}
                data-testid="amend-first-name"
                onChange={(event) => {
                  set({ firstName: event.target.value });
                }}
              />
            </Pair>
            <Pair id={`${id}-middle`} label="Middle name">
              <Input
                id={`${id}-middle`}
                value={draft.middleName}
                onChange={(event) => {
                  set({ middleName: event.target.value });
                }}
              />
            </Pair>
            <Pair id={`${id}-last`} label="Last name">
              <Input
                id={`${id}-last`}
                value={draft.lastName}
                data-testid="amend-last-name"
                onChange={(event) => {
                  set({ lastName: event.target.value });
                }}
              />
            </Pair>
          </section>

          <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <Pair id={`${id}-gender`} label="Sex">
              <Select
                value={draft.gender}
                onValueChange={(value) => {
                  set({ gender: value as Gender });
                }}
              >
                <SelectTrigger id={`${id}-gender`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GENDERS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Pair>
            <Pair id={`${id}-dob`} label="Date of birth">
              <Input
                id={`${id}-dob`}
                type="date"
                value={draft.dob}
                data-testid="amend-dob"
                onChange={(event) => {
                  set({ dob: event.target.value });
                }}
              />
            </Pair>
            <Pair id={`${id}-mobile`} label="Mobile">
              <Input
                id={`${id}-mobile`}
                type="tel"
                dir="ltr"
                value={draft.mobile}
                data-testid="amend-mobile"
                onChange={(event) => {
                  set({ mobile: event.target.value });
                }}
              />
            </Pair>
            <Pair id={`${id}-alt`} label="Alternate phone">
              <Input
                id={`${id}-alt`}
                type="tel"
                dir="ltr"
                value={draft.altPhone}
                onChange={(event) => {
                  set({ altPhone: event.target.value });
                }}
              />
            </Pair>
          </section>

          <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <Pair id={`${id}-email`} label="Email">
              <Input
                id={`${id}-email`}
                type="email"
                dir="ltr"
                value={draft.email}
                onChange={(event) => {
                  set({ email: event.target.value });
                }}
              />
            </Pair>
            <Pair id={`${id}-blood`} label="Blood group">
              <Select
                value={draft.bloodGroup}
                onValueChange={(value) => {
                  set({ bloodGroup: value });
                }}
              >
                <SelectTrigger id={`${id}-blood`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BLOOD_GROUPS.map((group) => (
                    <SelectItem key={group.code} value={group.code}>
                      {group.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Pair>
            <Pair id={`${id}-language`} label="Preferred language">
              <Select
                value={draft.preferredLanguage}
                onValueChange={(value) => {
                  set({ preferredLanguage: value });
                }}
              >
                <SelectTrigger id={`${id}-language`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGES.map((language) => (
                    <SelectItem key={language.code} value={language.code}>
                      {language.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Pair>
            <Pair id={`${id}-marital`} label="Marital status">
              <Input
                id={`${id}-marital`}
                value={draft.maritalStatus}
                onChange={(event) => {
                  set({ maritalStatus: event.target.value });
                }}
              />
            </Pair>
          </section>

          <section>
            <h3 className="mb-2 text-md font-semibold text-fg-default">Address</h3>
            <AddressForm
              value={draft.address}
              labels={ADDRESS_LABELS}
              states={INDIAN_STATES}
              onChange={(address) => {
                set({ address });
              }}
            />
          </section>

          <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Pair id={`${id}-category`} label="Patient category">
              <Select
                value={draft.category}
                onValueChange={(value) => {
                  set({ category: value });
                }}
              >
                <SelectTrigger id={`${id}-category`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((category) => (
                    <SelectItem key={category.code} value={category.code}>
                      {category.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Pair>
            <Pair id={`${id}-payer`} label="Who pays">
              <Select
                value={draft.payerType}
                onValueChange={(value) => {
                  set({ payerType: value });
                }}
              >
                <SelectTrigger id={`${id}-payer`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYER_TYPES.map((payer) => (
                    <SelectItem key={payer.code} value={payer.code}>
                      {payer.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Pair>
            <Pair id={`${id}-payer-ref`} label="Employee, policy or card number">
              <Input
                id={`${id}-payer-ref`}
                value={draft.payerRef}
                onChange={(event) => {
                  set({ payerRef: event.target.value });
                }}
              />
            </Pair>
          </section>

          <fieldset className="flex flex-wrap gap-x-6 gap-y-2">
            <legend className="text-sm text-fg-muted">Flags</legend>
            <Toggle
              id={`${id}-whatsapp`}
              label="Agrees to WhatsApp messages"
              checked={draft.whatsappOptIn}
              onChange={(checked) => {
                set({ whatsappOptIn: checked });
              }}
            />
            <Toggle
              id={`${id}-abled`}
              label="Differently abled"
              checked={draft.isDifferentlyAbled}
              onChange={(checked) => {
                set({ isDifferentlyAbled: checked });
              }}
            />
            <Toggle
              id={`${id}-pregnant`}
              label="Pregnant"
              checked={draft.isPregnant}
              onChange={(checked) => {
                set({ isPregnant: checked });
              }}
            />
            <Toggle
              id={`${id}-vip`}
              label="VIP"
              checked={draft.isVip}
              onChange={(checked) => {
                set({ isVip: checked });
              }}
            />
          </fieldset>

          <section
            aria-labelledby={`${id}-reason-heading`}
            className="rounded-md border border-strong bg-layer-3 p-3"
          >
            <h3 id={`${id}-reason-heading`} className="text-md font-semibold text-fg-default">
              Why
            </h3>

            {changed ? (
              <p className="mt-1 text-sm text-fg-muted" data-testid="amend-changed-fields">
                This will change: {labels.join(', ')}.
              </p>
            ) : (
              <p className="mt-1 text-sm text-fg-muted" data-testid="amend-no-changes">
                Nothing has been changed yet.
              </p>
            )}

            {identity ? (
              <p
                className="mt-2 flex items-start gap-2 rounded-md border border-warning-border bg-warning-surface p-2 text-sm text-warning-on-surface"
                data-testid="amend-identity-warning"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  You are changing a field that decides whether two records are the same person. It also
                  changes what the duplicate check will match on from now on.
                </span>
              </p>
            ) : null}

            <div className="mt-3">
              <Label htmlFor={`${id}-reason`} required>
                Reason
              </Label>
              <Textarea
                id={`${id}-reason`}
                rows={2}
                value={reason}
                data-testid="amend-reason"
                aria-required="true"
                aria-describedby={`${id}-reason-hint`}
                placeholder="e.g. Surname misspelled at registration; corrected against the passport shown at the desk"
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
              <p id={`${id}-reason-hint`} className="mt-1 text-xs text-fg-muted">
                At least {MIN_REASON_LENGTH} characters. It is stored in this record&rsquo;s history and in
                the audit register, and it is sent with the request as the authority for making it.
              </p>
            </div>
          </section>
        </DialogBody>

        <DialogFooter>
          <Badge tone="neutral" size="sm">
            Record version {patient.version}
          </Badge>
          <Button
            variant="primary"
            disabled={!canSubmit}
            aria-busy={saving}
            data-testid="amend-save"
            onClick={() => {
              if (!canSubmit) return;
              onSubmit(changes, reason.trim());
            }}
          >
            {saving ? 'Saving…' : 'Save the amendment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Pair({
  id,
  label,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(next) => {
          onChange(next === true);
        }}
      />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
    </span>
  );
}
