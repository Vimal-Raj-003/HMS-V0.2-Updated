'use client';

import { Input, Label } from '@vims/ui';
import { useId } from 'react';

/**
 * The identifier a screen needs before it can ask the API anything: which
 * doctor's book, which queue, which drawer.
 *
 * This is a text field rather than a picker for one reason, and it is worth
 * writing down rather than hiding: **Phase 1's API exposes no master-data
 * listing**. There is no `GET /doctors`, no `GET /queues` and no
 * `GET /cash/counters`, so there is nothing to populate a picker from. The field
 * remembers the last value per hospital (see `lib/remembered.ts`), so in practice
 * a desk types it once and never again — but it is a workaround, not a design,
 * and it should be replaced by a real combobox the moment those endpoints exist.
 *
 * The field validates the shape locally so a typo produces a message here rather
 * than a 400 with a stack of nothing useful in it.
 */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export function isIdentifier(value: string): boolean {
  return UUID.test(value.trim());
}

export function ContextField({
  label,
  hint,
  value,
  onChange,
  testId,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly testId: string;
}): React.JSX.Element {
  const id = useId();
  const invalid = value.trim() !== '' && !isIdentifier(value);

  return (
    <div className="flex min-w-64 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        data-testid={testId}
        value={value}
        spellCheck={false}
        autoComplete="off"
        aria-describedby={`${id}-hint`}
        aria-invalid={invalid}
        placeholder="00000000-0000-0000-0000-000000000000"
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="font-mono text-xs"
      />
      <p id={`${id}-hint`} className="text-2xs text-fg-muted">
        {invalid ? 'That is not a valid identifier — it should look like the placeholder.' : hint}
      </p>
    </div>
  );
}
