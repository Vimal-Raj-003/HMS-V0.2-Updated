'use client';

import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vims/ui';
import { useId, useState } from 'react';
import { ActionUnavailable } from '@/features/frontoffice/components/frontoffice-gate';
import {
  DIAGNOSIS_CERTAINTIES,
  DIAGNOSIS_RANKS,
  LATERALITIES,
  type DiagnosisCertainty,
  type DiagnosisInput,
  type DiagnosisRank,
  type DiagnosisRow,
  type Laterality,
} from '../api/types';

/**
 * Diagnoses — OP-002 §3.2, "diagnosis with ICD-10 search (primary/secondary,
 * provisional/final, severity, laterality)".
 *
 * ## The gap, stated plainly
 *
 * **There is no ICD-10 search endpoint in this build.** `GET /masters/{kind}`
 * covers eight demographic lookups and nothing clinical; there is no
 * `/terminology/icd10`, no `/diagnoses/search`, and the `terminology.read`
 * permission has no route behind it. `POST /encounters/{id}/diagnoses` accepts a
 * code system, a code and a description and validates the shape, not the code.
 *
 * So this panel takes the code and its description as typed fields. That is a
 * worse experience than a search box and it is a **reported gap**, not a design:
 * a doctor typing `J18.9` from memory is exactly the data-quality problem a
 * coded search exists to prevent. What the panel does instead is refuse to let
 * the two drift apart silently — both are required, and the description is what
 * prints and what MRD codes against.
 *
 * ## One primary, enforced here as well as there
 *
 * OP-002 §5: "primary diagnosis exactly one". A unique index enforces it, the
 * request schema refuses two, and this panel will not let a second be marked
 * primary — so the doctor is told which two clash before the round trip rather
 * than being handed a constraint name.
 */
export function DiagnosisPanel({
  diagnoses,
  onAdd,
  canEdit,
  saving,
  readOnly,
}: {
  readonly diagnoses: readonly DiagnosisRow[];
  readonly onAdd: (diagnosis: DiagnosisInput) => void;
  readonly canEdit: boolean;
  readonly saving: boolean;
  readonly readOnly: boolean;
}): React.JSX.Element {
  const codeId = useId();
  const descriptionId = useId();
  const rankId = useId();
  const certaintyId = useId();
  const lateralityId = useId();

  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [rank, setRank] = useState<DiagnosisRank>('secondary');
  const [certainty, setCertainty] = useState<DiagnosisCertainty>('provisional');
  const [laterality, setLaterality] = useState<Laterality>('not_applicable');

  const hasPrimary = diagnoses.some((diagnosis) => diagnosis.rank === 'primary');
  const clashesOnPrimary = rank === 'primary' && hasPrimary;
  const complete = code.trim() !== '' && description.trim() !== '';

  return (
    <section className="flex flex-col gap-3" data-testid="diagnosis-panel">
      <h2 className="text-md font-medium text-fg-default">Diagnoses</h2>

      {diagnoses.length === 0 ? (
        <p className="text-sm text-fg-muted" data-testid="diagnoses-empty">
          None recorded yet. A consultation can be completed without one, but only with a reason — and the
          reason goes on the record.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="diagnosis-list">
          {diagnoses.map((diagnosis) => (
            <li
              key={diagnosis.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-default bg-layer-1 p-2"
            >
              <Badge tone={diagnosis.rank === 'primary' ? 'accent' : 'neutral'}>
                {diagnosis.rank === 'primary' ? 'Primary' : 'Secondary'}
              </Badge>
              <span className="font-mono text-xs text-fg-default">{diagnosis.code}</span>
              <span className="text-sm text-fg-default">{diagnosis.description}</span>
              <Badge tone="neutral" size="sm">
                {diagnosis.certainty}
              </Badge>
              {diagnosis.laterality === 'not_applicable' ? null : (
                <Badge tone="neutral" size="sm">
                  {diagnosis.laterality}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}

      {readOnly ? (
        <p className="text-2xs text-fg-muted">
          The consultation is signed. Diagnoses recorded after signing belong to an amendment.
        </p>
      ) : canEdit ? (
        <div className="flex flex-col gap-3 rounded-md border border-default p-3">
          <p className="text-2xs text-fg-muted">
            There is no ICD-10 lookup in this build, so the code and its wording are both typed. Copy them
            from the coding sheet — the description is what prints and what medical records codes against.
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={codeId}>ICD-10 code</Label>
              <Input
                id={codeId}
                data-testid="diagnosis-code"
                value={code}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                onChange={(event) => {
                  setCode(event.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={descriptionId}>Description</Label>
              <Input
                id={descriptionId}
                data-testid="diagnosis-description"
                value={description}
                autoComplete="off"
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={rankId}>Rank</Label>
              <Select
                value={rank}
                onValueChange={(value) => {
                  setRank(value as DiagnosisRank);
                }}
              >
                <SelectTrigger id={rankId} data-testid="diagnosis-rank">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DIAGNOSIS_RANKS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option === 'primary' ? 'Primary' : 'Secondary'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={certaintyId}>Certainty</Label>
              <Select
                value={certainty}
                onValueChange={(value) => {
                  setCertainty(value as DiagnosisCertainty);
                }}
              >
                <SelectTrigger id={certaintyId} data-testid="diagnosis-certainty">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DIAGNOSIS_CERTAINTIES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option.replace('_', ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={lateralityId}>Laterality</Label>
              <Select
                value={laterality}
                onValueChange={(value) => {
                  setLaterality(value as Laterality);
                }}
              >
                <SelectTrigger id={lateralityId} data-testid="diagnosis-laterality">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LATERALITIES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option.replace('_', ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {clashesOnPrimary ? (
            <p role="alert" data-testid="primary-clash" className="text-sm text-danger-on-surface">
              This consultation already has a primary diagnosis. Exactly one may be primary — record this one
              as secondary, or change the existing one first.
            </p>
          ) : null}

          <div>
            <Button
              variant="secondary"
              data-testid="diagnosis-add"
              disabled={!complete || clashesOnPrimary || saving}
              onClick={() => {
                onAdd({
                  codeSystemKey: 'ICD10',
                  code: code.trim(),
                  description: description.trim(),
                  rank,
                  certainty,
                  laterality,
                });
                setCode('');
                setDescription('');
                setRank('secondary');
              }}
            >
              Add diagnosis
            </Button>
          </div>
        </div>
      ) : (
        <ActionUnavailable
          title="Recording a diagnosis is held by another role"
          because="Doctors record diagnoses on their own consultations; medical-records coders hold the same key so they can verify a code without holding the rest of a doctor's access."
          permission="opd.diagnosis.update"
        />
      )}
    </section>
  );
}
