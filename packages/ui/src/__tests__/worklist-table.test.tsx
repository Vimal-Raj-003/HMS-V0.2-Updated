import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  WorklistTable,
  type WorklistColumn,
  type WorklistSort,
  type WorklistTableLabels,
} from '../clinical/worklist-table.js';
import { findAccessibilityViolations } from './axe.js';

interface BenchRow {
  readonly id: string;
  readonly accession: string;
  readonly patient: string;
  readonly test: string;
  readonly priority: string;
  readonly receivedAt: string;
}

const labels: WorklistTableLabels = {
  caption: 'Bench worklist — Biochemistry',
  scrollRegion: 'Worklist rows',
  selectAll: 'Select all rows',
  selectRow: 'Select row',
  sortAscending: 'sorted ascending',
  sortDescending: 'sorted descending',
  notSorted: 'not sorted',
  density: 'Row density',
  densityOption: { compact: 'Compact', default: 'Default', touch: 'Touch' },
  columns: 'Columns',
  savedView: 'Saved view',
  savedViewPlaceholder: 'Choose a view',
  saveView: 'Save view',
  loadMore: 'Load more',
  loading: 'Loading the worklist',
  selectedCount: (count) => `${String(count)} selected`,
  clearSelection: 'Clear selection',
  rowCount: (count) => `${String(count)} items`,
  expandRow: 'More fields',
  rowActions: 'Row actions',
};

const columns: readonly WorklistColumn<BenchRow>[] = [
  { key: 'accession', header: 'Acc no', render: (row) => row.accession, sortable: true, hideable: false },
  { key: 'patient', header: 'Patient', render: (row) => row.patient },
  { key: 'test', header: 'Test', render: (row) => row.test },
  { key: 'priority', header: 'Pri', render: (row) => row.priority, sortable: true },
  { key: 'receivedAt', header: 'Received', render: (row) => row.receivedAt, importance: 'secondary' },
];

function makeRows(count: number): BenchRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `L-${String(4471 + index)}`,
    accession: `L-${String(4471 + index)}`,
    patient: `RS ·${String(8471 + index)} 45/M`,
    test: index % 2 === 0 ? 'Sr K+' : 'CBC',
    priority: index % 3 === 0 ? 'STAT' : 'Routine',
    receivedAt: '14:02',
  }));
}

const empty = {
  cause: 'No samples on this bench',
  nextAction: 'The next collection round reaches the lab at 10:30.',
};

describe('WorklistTable — docs/06 §5.2 #41 / §9.A', () => {
  it('renders the rows, the header and a real count', () => {
    render(
      <WorklistTable
        rows={makeRows(3)}
        getRowId={(row) => row.id}
        columns={columns}
        labels={labels}
        empty={empty}
      />,
    );
    expect(screen.getByText('3 items')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Acc no/ })).toBeInTheDocument();
    expect(screen.getByText('L-4471')).toBeInTheDocument();
  });

  it('drives sorting from the server and reflects it in aria-sort', () => {
    function Harness(): React.JSX.Element {
      const [sort, setSort] = useState<WorklistSort | undefined>(undefined);
      return (
        <WorklistTable
          rows={makeRows(2)}
          getRowId={(row) => row.id}
          columns={columns}
          labels={labels}
          empty={empty}
          {...(sort === undefined ? {} : { sort })}
          onSortChange={setSort}
        />
      );
    }
    render(<Harness />);
    const header = screen.getByRole('columnheader', { name: /Acc no/ });
    expect(header).toHaveAttribute('aria-sort', 'none');
    fireEvent.click(screen.getByRole('button', { name: /Acc no/ }));
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(screen.getByRole('button', { name: /Acc no/ }));
    expect(header).toHaveAttribute('aria-sort', 'descending');
  });

  it('navigates rows with the arrow keys on one tab stop', () => {
    const { container } = render(
      <WorklistTable
        rows={makeRows(4)}
        getRowId={(row) => row.id}
        columns={columns}
        labels={labels}
        empty={empty}
      />,
    );
    const rows = container.querySelectorAll<HTMLTableRowElement>('[data-row-index]');
    expect(rows[0]).toHaveAttribute('tabindex', '0');
    expect(rows[1]).toHaveAttribute('tabindex', '-1');
    rows[0]?.focus();
    fireEvent.keyDown(rows[0] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1] as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(rows[3]);
    fireEvent.keyDown(rows[3] as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(rows[0]);
  });

  it('opens a row with Enter and its action menu with "."', () => {
    const onRowOpen = vi.fn<(row: BenchRow) => void>();
    const onRowActions = vi.fn<(row: BenchRow) => void>();
    const { container } = render(
      <WorklistTable
        rows={makeRows(2)}
        getRowId={(row) => row.id}
        columns={columns}
        labels={labels}
        empty={empty}
        onRowOpen={onRowOpen}
        onRowActions={onRowActions}
      />,
    );
    const row = container.querySelector<HTMLTableRowElement>('[data-row-index="0"]');
    row?.focus();
    fireEvent.keyDown(row as HTMLElement, { key: 'Enter' });
    fireEvent.keyDown(row as HTMLElement, { key: '.' });
    expect(onRowOpen).toHaveBeenCalledTimes(1);
    expect(onRowActions).toHaveBeenCalledTimes(1);
  });

  it('selects with Space and surfaces a bulk bar that states the count', () => {
    const onBulk = vi.fn<(rows: readonly BenchRow[]) => void>();
    function Harness(): React.JSX.Element {
      const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
      return (
        <WorklistTable
          rows={makeRows(3)}
          getRowId={(row) => row.id}
          columns={columns}
          labels={labels}
          empty={empty}
          selectedIds={selected}
          onSelectionChange={setSelected}
          bulkActions={[{ id: 'validate', label: 'Validate', onSelect: onBulk }]}
        />
      );
    }
    const { container } = render(<Harness />);
    const row = container.querySelector<HTMLTableRowElement>('[data-row-index="1"]');
    row?.focus();
    fireEvent.keyDown(row as HTMLElement, { key: ' ' });
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    expect(onBulk).toHaveBeenCalledWith([expect.objectContaining({ id: 'L-4472' })]);
  });

  it('selects every row from the header checkbox and clears again', () => {
    function Harness(): React.JSX.Element {
      const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
      return (
        <WorklistTable
          rows={makeRows(3)}
          getRowId={(row) => row.id}
          columns={columns}
          labels={labels}
          empty={empty}
          selectedIds={selected}
          onSelectionChange={setSelected}
          bulkActions={[{ id: 'print', label: 'Print', onSelect: () => undefined }]}
        />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByText('3 selected')).toBeNull();
  });

  it('switches density and reports it with aria-pressed', () => {
    const onDensityChange = vi.fn<(density: string) => void>();
    render(
      <WorklistTable
        rows={makeRows(2)}
        getRowId={(row) => row.id}
        columns={columns}
        labels={labels}
        empty={empty}
        density="compact"
        onDensityChange={onDensityChange}
      />,
    );
    expect(screen.getByRole('button', { name: 'Compact' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Touch' }));
    expect(onDensityChange).toHaveBeenCalledWith('touch');
  });

  it('hides a chosen column and keeps safety-critical ones unhideable', () => {
    render(
      <WorklistTable
        rows={makeRows(2)}
        getRowId={(row) => row.id}
        columns={columns}
        labels={labels}
        empty={empty}
        hiddenColumnKeys={new Set(['test'])}
        onHiddenColumnsChange={() => undefined}
      />,
    );
    expect(screen.queryByRole('columnheader', { name: 'Test' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: /Acc no/ })).toBeInTheDocument();
    expect(columns.find((column) => column.key === 'accession')?.hideable).toBe(false);
  });

  it('windows the body above the virtualisation threshold and still reports the true row count', () => {
    const { container } = render(
      <WorklistTable
        rows={makeRows(500)}
        getRowId={(row) => row.id}
        columns={columns}
        labels={labels}
        empty={empty}
      />,
    );
    const table = container.querySelector('[data-slot="worklist"]');
    expect(table).toHaveAttribute('data-virtualised', 'true');
    expect(table).toHaveAttribute('aria-rowcount', '500');
    const rendered = container.querySelectorAll('[data-row-index]');
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(500);
    expect(container.querySelector('[data-spacer="bottom"]')).not.toBeNull();
  });

  it('does not window a short list', () => {
    const { container } = render(
      <WorklistTable
        rows={makeRows(20)}
        getRowId={(row) => row.id}
        columns={columns}
        labels={labels}
        empty={empty}
      />,
    );
    expect(container.querySelector('[data-slot="worklist"]')).toHaveAttribute('data-virtualised', 'false');
    expect(container.querySelectorAll('[data-row-index]')).toHaveLength(20);
  });

  it('pages with a cursor, never with an offset', () => {
    const onLoadMore = vi.fn();
    render(
      <WorklistTable
        rows={makeRows(2)}
        getRowId={(row) => row.id}
        columns={columns}
        labels={labels}
        empty={empty}
        hasMore
        onLoadMore={onLoadMore}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('renders a specific empty state, never "No data"', () => {
    const onSelect = vi.fn();
    render(
      <WorklistTable
        rows={[]}
        getRowId={(row: BenchRow) => row.id}
        columns={columns}
        labels={labels}
        empty={{ ...empty, action: { label: 'Open the collection round', onSelect } }}
      />,
    );
    expect(screen.getByText('No samples on this bench')).toBeInTheDocument();
    expect(screen.getByText('The next collection round reaches the lab at 10:30.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open the collection round' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('marks a critical row with a left rule rather than a row background', () => {
    const { container } = render(
      <WorklistTable
        rows={makeRows(2)}
        getRowId={(row) => row.id}
        columns={columns}
        labels={labels}
        empty={empty}
        criticalRowIds={new Set(['L-4471'])}
      />,
    );
    const critical = container.querySelector('[data-row-id="L-4471"]');
    expect(critical).toHaveAttribute('data-critical', 'true');
    expect(critical?.className).toContain('border-s-danger-border');
  });

  it('has no axe violations', async () => {
    function Harness(): React.JSX.Element {
      const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(['L-4471']));
      return (
        <WorklistTable
          rows={makeRows(5)}
          getRowId={(row) => row.id}
          columns={columns}
          labels={labels}
          empty={empty}
          selectedIds={selected}
          onSelectionChange={setSelected}
          bulkActions={[{ id: 'validate', label: 'Validate', onSelect: () => undefined }]}
          onDensityChange={() => undefined}
          onHiddenColumnsChange={() => undefined}
          onSortChange={() => undefined}
          sort={{ columnKey: 'accession', direction: 'asc' }}
          hasMore
          onLoadMore={() => undefined}
        />
      );
    }
    const { container } = render(<Harness />);
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});
