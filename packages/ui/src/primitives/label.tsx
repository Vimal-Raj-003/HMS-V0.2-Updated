import * as LabelPrimitive from '@radix-ui/react-label';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';

export interface LabelProps extends ComponentProps<typeof LabelPrimitive.Root> {
  /**
   * docs/06 §6.4 — "Required fields marked with a red asterisk **and**
   * `aria-required`". The asterisk carries an accessible name so a screen reader does
   * not read a bare star.
   */
  readonly required?: boolean;
  /** Label for the required marker, from the caller's i18n catalogue. */
  readonly requiredLabel?: string;
}

export function Label({
  className,
  required = false,
  requiredLabel = 'required',
  children,
  ...props
}: LabelProps): React.JSX.Element {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'inline-flex items-center gap-1 text-md font-medium text-fg-default',
        'peer-disabled:text-fg-disabled',
        className,
      )}
      {...props}
    >
      {children}
      {required ? (
        <span className="text-danger-fg" aria-label={requiredLabel} role="img">
          *
        </span>
      ) : null}
    </LabelPrimitive.Root>
  );
}
