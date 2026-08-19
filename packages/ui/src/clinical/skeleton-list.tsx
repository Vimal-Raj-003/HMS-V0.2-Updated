import { cn } from '../lib/cn.js';
import { Skeleton } from '../primitives/skeleton.js';

/**
 * `SkeletonList` — docs/06 §5.2 #37: "Match final layout metrics exactly (no layout
 * shift, CLS 0). Shown only after 200 ms of loading; below 200 ms show nothing."
 *
 * Row height is a required prop because a skeleton that does not match the real row
 * height *is* the layout shift it exists to prevent. Pair with `useDelayedFlag(loading)`
 * for the 200 ms rule.
 */
export interface SkeletonListProps {
  readonly rows?: number;
  /** Must equal the real row height for the current density (§6.3: 32/40/52 px). */
  readonly rowHeight?: 'compact' | 'default' | 'touch';
  /** Relative widths of the columns in each row, e.g. `[3, 2, 1]`. */
  readonly columns?: readonly number[];
  /** Announced by the region while loading, from the caller's i18n catalogue. */
  readonly label: string;
  readonly className?: string;
}

const ROW_HEIGHTS: Readonly<Record<'compact' | 'default' | 'touch', string>> = {
  compact: 'h-8',
  default: 'h-10',
  touch: 'h-13',
};

export function SkeletonList({
  rows = 6,
  rowHeight = 'default',
  columns = [3, 2, 1],
  label,
  className,
}: SkeletonListProps): React.JSX.Element {
  return (
    <div
      data-slot="skeleton-list"
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn('flex flex-col gap-1', className)}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className={cn('flex items-center gap-3', ROW_HEIGHTS[rowHeight])}>
          {columns.map((weight, columnIndex) => (
            <Skeleton key={columnIndex} className="h-4" style={{ flexGrow: weight, flexBasis: 0 }} />
          ))}
        </div>
      ))}
    </div>
  );
}
