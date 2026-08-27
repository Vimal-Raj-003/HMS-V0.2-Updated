import type { WorklistTableLabels } from '@vims/ui';

/**
 * The strings `WorklistTable` needs, in one place, for every Phase-4 list.
 *
 * `docs/06` §5.2 #41 makes every label a required prop rather than defaulting
 * them inside the component, which is right — a table whose caption says "Table"
 * is unusable to a screen-reader user moving by landmark. But a dozen worklists
 * each spelling out eighteen strings is a dozen chances to ship one that says
 * "Rows".
 *
 * `caption` is the only thing that differs per screen, so it is the only
 * parameter. When `next-intl` is actually mounted in this application (see the
 * note in `features/pharmacy/screens.ts`) this function becomes the single place
 * these strings are looked up.
 */
export function worklistLabels(caption: string): WorklistTableLabels {
  return {
    caption,
    scrollRegion: `${caption} — scrollable list`,
    selectAll: 'Select every row on this page',
    selectRow: 'Select this row',
    sortAscending: 'Sorted oldest first',
    sortDescending: 'Sorted newest first',
    notSorted: 'Not sorted by this column',
    density: 'Row height',
    densityOption: {
      compact: 'Compact — more rows on screen',
      default: 'Default',
      touch: 'Touch — larger targets for a tablet',
    },
    columns: 'Choose columns',
    savedView: 'Saved view',
    savedViewPlaceholder: 'No saved view',
    saveView: 'Save this view',
    loadMore: 'Load the next page',
    loading: 'Loading the next page…',
    selectedCount: (count: number) => `${count} selected`,
    clearSelection: 'Clear the selection',
    rowCount: (count: number) => `${count} on this page`,
    expandRow: 'Show the remaining columns for this row',
    rowActions: 'Actions for this row',
  };
}
