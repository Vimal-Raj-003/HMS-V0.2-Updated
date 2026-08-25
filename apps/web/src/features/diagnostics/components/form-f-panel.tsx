'use client';

import { useMutation } from '@tanstack/react-query';
import { Button, Checkbox, Input, Label, Textarea, useToast } from '@vims/ui';
import { useState } from 'react';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { recordFormF } from '../api/client';
import type { FormFRequest } from '../api/types';
import {
  EMPTY_FORM_F,
  FORM_F_INDICATIONS,
  canRecordFormF,
  formFProblems,
  type FormFState,
} from '../lib/pcpndt';

/**
 * PC-PNDT Form F, for an obstetric ultrasound (OP-008 §4, §5 bullet 1, AC §14.9).
 *
 * ## What is here
 *
 * Exactly the Form: the woman, her husband or father, the address, the identity
 * document by masked reference, obstetric history, the **lawful indication
 * chosen from the prescribed list**, the procedures performed, the centre's and
 * the machine's registration numbers, the performing doctor and their
 * registration number, and the two declarations. The machine and doctor
 * registration numbers are mandatory because both print on the report, and an
 * unregistered machine performing a prenatal scan is itself an offence.
 *
 * ## What is not here, and can never be
 *
 * There is **no field for the sex of the foetus**, and no lawful configuration
 * that adds one. Section 5 of the Act prohibits communicating it in any manner;
 * `formFSchema` on the API is `.strict()` so such a key is a 400 that names it;
 * the migration's `information_schema` assertion refuses to apply if such a
 * column ever appears; and `lib/pcpndt.spec.ts` reads every source file in this
 * feature and fails the build if a field named for sex or gender appears in one.
 * Four independent statements of the same promise, because a promise kept in one
 * place is one refactor from being broken.
 *
 * ## Friction is the point
 *
 * `rad.pnpdt.manage` is `sensitiveGrant`, `requiresReason` **and**
 * `requiresStepUp`. Three kinds of friction on one key, and the catalogue is
 * right to put them there: the Act makes the recording clinician personally
 * liable, and a form this consequential should not be one click from a worklist.
 */
export function FormFPanel({
  orderItemId,
  onRecorded,
}: {
  readonly orderItemId: string;
  readonly onRecorded?: (formSerialNo: string) => void;
}): React.JSX.Element {
  const { publish } = useToast();
  const [form, setForm] = useState<FormFState>(EMPTY_FORM_F);
  const [procedure, setProcedure] = useState('');

  const problems = formFProblems(form);

  const record = useMutation({
    mutationFn: () =>
      recordFormF(
        orderItemId,
        toRequest(form),
        'PC-PNDT Form F recorded for a prenatal diagnostic procedure under Rule 9.',
      ),
    onSuccess: (result) => {
      publish({
        title: `Form F ${result.formSerialNo} recorded`,
        description:
          'It enters this month’s return. The machine and doctor registration numbers print on the report.',
        severity: 'success',
      });
      onRecorded?.(result.formSerialNo);
    },
  });

  function set<K extends keyof FormFState>(key: K, next: FormFState[K]): void {
    setForm((current) => ({ ...current, [key]: next }));
  }

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-violet-border bg-violet-surface p-4"
      data-testid="form-f-panel"
    >
      <header className="flex flex-col gap-1">
        <h3 className="text-md font-medium text-violet-on-surface">PC-PNDT Form F</h3>
        <p className="text-sm text-violet-on-surface">
          This is a prenatal diagnostic procedure. The Form must be completed and signed before the study can
          be marked complete, and it is retained for the statutory period.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <Text
          id="ff-name"
          label="Name of the pregnant woman"
          value={form.patientName}
          onChange={(v) => {
            set('patientName', v);
          }}
        />
        <Text
          id="ff-age"
          label="Age in completed years"
          value={form.patientAgeYears}
          onChange={(v) => {
            set('patientAgeYears', v);
          }}
        />
        <Text
          id="ff-husband"
          label="Husband’s or father’s name"
          value={form.husbandOrFatherName}
          onChange={(v) => {
            set('husbandOrFatherName', v);
          }}
        />
        <Text
          id="ff-idtype"
          label="Identity document produced"
          value={form.identityDocumentType}
          onChange={(v) => {
            set('identityDocumentType', v);
          }}
        />
        <Text
          id="ff-idref"
          label="Masked document reference"
          value={form.identityDocumentRefMasked}
          onChange={(v) => {
            set('identityDocumentRefMasked', v);
          }}
        />
        <Text
          id="ff-referrer"
          label="Referring doctor"
          value={form.referringDoctorName}
          onChange={(v) => {
            set('referringDoctorName', v);
          }}
        />
        <Text
          id="ff-referrer-reg"
          label="Referring doctor registration no."
          value={form.referringDoctorRegistrationNo}
          onChange={(v) => {
            set('referringDoctorRegistrationNo', v);
          }}
        />
        <Text
          id="ff-lmp"
          label="Last menstrual period"
          value={form.lastMenstrualPeriod}
          onChange={(v) => {
            set('lastMenstrualPeriod', v);
          }}
        />
        <Text
          id="ff-gravida"
          label="Gravida"
          value={form.gravida}
          onChange={(v) => {
            set('gravida', v);
          }}
        />
        <Text
          id="ff-para"
          label="Para"
          value={form.para}
          onChange={(v) => {
            set('para', v);
          }}
        />
        <Text
          id="ff-living"
          label="Living children"
          value={form.livingChildren}
          onChange={(v) => {
            set('livingChildren', v);
          }}
        />
        <Text
          id="ff-abortions"
          label="Previous abortions"
          value={form.previousAbortions}
          onChange={(v) => {
            set('previousAbortions', v);
          }}
        />
        <Text
          id="ff-gestation"
          label="Gestational age in weeks"
          value={form.gestationalAgeWeeks}
          onChange={(v) => {
            set('gestationalAgeWeeks', v);
          }}
        />
        <Text
          id="ff-facility"
          label="Centre registration no."
          value={form.facilityRegistrationNo}
          onChange={(v) => {
            set('facilityRegistrationNo', v);
          }}
        />
        <Text
          id="ff-machine"
          label="Machine registration no."
          value={form.machineRegistrationNo}
          onChange={(v) => {
            set('machineRegistrationNo', v);
          }}
        />
        <Text
          id="ff-performer"
          label="Performed by"
          value={form.performedByName}
          onChange={(v) => {
            set('performedByName', v);
          }}
        />
        <Text
          id="ff-performer-reg"
          label="Performing doctor registration no."
          value={form.performedByRegistrationNo}
          onChange={(v) => {
            set('performedByRegistrationNo', v);
          }}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="ff-address">Full address</Label>
        <Textarea
          id="ff-address"
          data-testid="ff-address"
          rows={2}
          value={form.fullAddress}
          onChange={(event) => {
            set('fullAddress', event.target.value);
          }}
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-violet-on-surface">
          Indication for the procedure — from the Form F list
        </legend>
        <p className="text-2xs text-violet-on-surface">
          Rule 10 prescribes the lawful indications. "Routine" is not one of them, which is why there is no
          option for it.
        </p>
        {FORM_F_INDICATIONS.map((indication) => (
          <div key={indication.code} className="flex items-start gap-2">
            <Checkbox
              id={`ff-ind-${indication.code}`}
              data-testid={`ff-ind-${indication.code}`}
              checked={form.indicationCodes.includes(indication.code)}
              onCheckedChange={(checked) => {
                set(
                  'indicationCodes',
                  checked === true
                    ? [...form.indicationCodes, indication.code]
                    : form.indicationCodes.filter((code) => code !== indication.code),
                );
              }}
            />
            <Label htmlFor={`ff-ind-${indication.code}`} className="font-normal">
              {indication.label}
            </Label>
          </div>
        ))}
      </fieldset>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-56 flex-col gap-1">
          <Label htmlFor="ff-procedure">Procedure performed</Label>
          <Input
            id="ff-procedure"
            data-testid="ff-procedure"
            value={procedure}
            onChange={(event) => {
              setProcedure(event.target.value);
            }}
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          data-testid="ff-add-procedure"
          disabled={procedure.trim() === ''}
          onClick={() => {
            set('proceduresPerformed', [...form.proceduresPerformed, procedure.trim()]);
            setProcedure('');
          }}
        >
          Add
        </Button>
        <ul className="flex flex-wrap gap-2 text-2xs text-violet-on-surface">
          {form.proceduresPerformed.map((one) => (
            <li key={one} className="rounded-full border border-violet-border px-2 py-0.5">
              {one}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <Checkbox
            id="ff-woman-decl"
            data-testid="ff-woman-decl"
            checked={form.womanDeclarationSigned}
            onCheckedChange={(checked) => {
              set('womanDeclarationSigned', checked === true);
            }}
          />
          <Label htmlFor="ff-woman-decl" className="font-normal">
            The woman’s declaration has been signed
          </Label>
        </div>
        {form.womanDeclarationSigned ? (
          <Text
            id="ff-woman-doc"
            label="Signed declaration document id"
            value={form.womanDeclarationDocId}
            onChange={(v) => {
              set('womanDeclarationDocId', v);
            }}
          />
        ) : null}
        <div className="flex items-start gap-2">
          <Checkbox
            id="ff-doctor-decl"
            data-testid="ff-doctor-decl"
            checked={form.doctorDeclarationSigned}
            onCheckedChange={(checked) => {
              set('doctorDeclarationSigned', checked === true);
            }}
          />
          <Label htmlFor="ff-doctor-decl" className="font-normal">
            The doctor’s declaration has been signed
          </Label>
        </div>
        {form.doctorDeclarationSigned ? (
          <Text
            id="ff-doctor-doc"
            label="Signed declaration document id"
            value={form.doctorDeclarationDocId}
            onChange={(v) => {
              set('doctorDeclarationDocId', v);
            }}
          />
        ) : null}
      </div>

      {problems.length === 0 ? null : (
        <ul data-testid="form-f-problems" className="flex flex-col gap-1 text-sm text-warning-fg">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <Button
        data-testid="record-form-f"
        className="self-start"
        disabled={!canRecordFormF(form) || record.isPending}
        onClick={() => {
          record.mutate();
        }}
      >
        {record.isPending ? 'Recording…' : 'Record Form F'}
      </Button>
      {record.error === null ? null : <ProblemCard error={record.error} />}
    </section>
  );
}

function toRequest(form: FormFState): FormFRequest {
  const number = (raw: string): number | undefined => {
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) ? parsed : undefined;
  };
  const gravida = number(form.gravida);
  const para = number(form.para);
  const living = number(form.livingChildren);
  const abortions = number(form.previousAbortions);
  const gestation = Number.parseFloat(form.gestationalAgeWeeks);
  const referrerReg = form.referringDoctorRegistrationNo.trim();
  const lmp = form.lastMenstrualPeriod.trim();

  return {
    patientName: form.patientName.trim(),
    patientAgeYears: number(form.patientAgeYears) ?? 0,
    husbandOrFatherName: form.husbandOrFatherName.trim(),
    fullAddress: form.fullAddress.trim(),
    identityDocumentType: form.identityDocumentType.trim(),
    identityDocumentRefMasked: form.identityDocumentRefMasked.trim(),
    ...(gravida === undefined ? {} : { gravida }),
    ...(para === undefined ? {} : { para }),
    ...(living === undefined ? {} : { livingChildren: living }),
    ...(abortions === undefined ? {} : { previousAbortions: abortions }),
    ...(Number.isFinite(gestation) ? { gestationalAgeWeeks: gestation } : {}),
    ...(lmp === '' ? {} : { lastMenstrualPeriod: lmp }),
    referringDoctorName: form.referringDoctorName.trim(),
    ...(referrerReg === '' ? {} : { referringDoctorRegistrationNo: referrerReg }),
    indicationCodes: form.indicationCodes,
    ...(form.indicationOther.trim() === '' ? {} : { indicationOther: form.indicationOther.trim() }),
    proceduresPerformed: form.proceduresPerformed,
    facilityRegistrationNo: form.facilityRegistrationNo.trim(),
    machineRegistrationNo: form.machineRegistrationNo.trim(),
    performedByName: form.performedByName.trim(),
    performedByRegistrationNo: form.performedByRegistrationNo.trim(),
    performedAt: new Date().toISOString(),
    womanDeclarationSigned: form.womanDeclarationSigned,
    ...(form.womanDeclarationDocId.trim() === ''
      ? {}
      : { womanDeclarationDocId: form.womanDeclarationDocId.trim() }),
    doctorDeclarationSigned: form.doctorDeclarationSigned,
    ...(form.doctorDeclarationDocId.trim() === ''
      ? {}
      : { doctorDeclarationDocId: form.doctorDeclarationDocId.trim() }),
  };
}

function Text({
  id,
  label,
  value,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        data-testid={id}
        autoComplete="off"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
}
