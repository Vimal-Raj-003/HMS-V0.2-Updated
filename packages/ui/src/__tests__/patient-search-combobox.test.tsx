import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PatientSearchCombobox,
  detectSearchMode,
  type PatientSearchLabels,
  type PatientSearchResult,
} from '../clinical/patient-search-combobox.js';
import { findAccessibilityViolations } from './axe.js';

const labels: PatientSearchLabels = {
  fieldLabel: 'Find patient',
  placeholder: 'Mobile, UHID, name, ABHA or ID — or scan',
  listLabel: 'Patient results',
  recentHeading: 'Recent',
  resultsHeading: 'Results',
  minCharsHint: (minChars) => `Type at least ${String(minChars)} characters`,
  searching: 'Searching…',
  noResults: (query) => `No patient matches "${query}".`,
  noResultsAction: 'Register a new patient.',
  error: 'Search is unavailable. Register from the paper slip and reconcile later.',
  scanning: 'Reading the scanned code…',
  scanUnresolved: (payload) => `Unrecognised code ${payload}. Search manually.`,
  uhidPrefix: 'UHID',
  mobilePrefix: 'Mobile',
  lastVisitPrefix: 'Last visit',
  duplicate: 'Possible duplicate',
  deceased: 'Deceased',
  breakGlassRequired: 'Break-glass',
  resultSummary: (result) => `${result.displayName}, ${result.age}, UHID ${result.uhid}`,
  modeHint: {
    mobile: 'Mobile',
    uhid: 'UHID',
    abha: 'ABHA',
    identifier: 'ID',
    name: 'Name',
  },
};

const ramesh: PatientSearchResult = {
  patientId: 'pat_1',
  uhid: '0021-45871',
  displayName: 'SHARMA, Ramesh Kumar',
  age: '45 y',
  sex: 'male',
  mobileLast4: '3210',
  lastVisitOn: '12-08-2026',
  careTeamMember: true,
};

const rameshOther: PatientSearchResult = {
  patientId: 'pat_2',
  uhid: '0019-22104',
  displayName: 'SHARMA, Ramesh Kumar',
  age: '62 y',
  sex: 'male',
  mobileLast4: '7788',
  lastVisitOn: '02-01-2024',
  careTeamMember: false,
  probableDuplicate: true,
};

function renderCombobox(overrides: {
  readonly search?: (query: string, mode: string) => Promise<readonly PatientSearchResult[]>;
  readonly onSelect?: (result: PatientSearchResult) => void;
  readonly onBreakGlassRequired?: (result: PatientSearchResult) => void;
  readonly onScanResolve?: (payload: string) => Promise<PatientSearchResult | null>;
  readonly recent?: readonly PatientSearchResult[];
}) {
  const onSearch = vi
    .fn<(query: string, mode: string) => Promise<readonly PatientSearchResult[]>>()
    .mockImplementation(overrides.search ?? (() => Promise.resolve([ramesh, rameshOther])));
  const onSelect = vi.fn<(result: PatientSearchResult) => void>(overrides.onSelect);
  const onBreakGlassRequired = vi.fn<(result: PatientSearchResult) => void>(overrides.onBreakGlassRequired);
  const view = render(
    <PatientSearchCombobox
      labels={labels}
      onSearch={onSearch}
      onSelect={onSelect}
      onBreakGlassRequired={onBreakGlassRequired}
      {...(overrides.onScanResolve === undefined ? {} : { onScanResolve: overrides.onScanResolve })}
      {...(overrides.recent === undefined ? {} : { recent: overrides.recent })}
    />,
  );
  return { ...view, onSearch, onSelect, onBreakGlassRequired };
}

/** A keyboard-wedge burst: fast keystrokes terminated by Enter (docs/06 §6.2). */
function burst(chars: string, intervalMs: number, target: EventTarget = document): void {
  let stamp = 1000;
  for (const char of chars) {
    const event = new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'timeStamp', { value: stamp });
    target.dispatchEvent(event);
    stamp += intervalMs;
  }
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  Object.defineProperty(enter, 'timeStamp', { value: stamp });
  target.dispatchEvent(enter);
}

describe('detectSearchMode — docs/06 §6.5', () => {
  it('routes each identifier shape to its index', () => {
    expect(detectSearchMode('9876543210')).toBe('mobile');
    expect(detectSearchMode('98765 43210')).toBe('mobile');
    expect(detectSearchMode('12345678901234')).toBe('abha');
    expect(detectSearchMode('ramesh@abdm')).toBe('abha');
    expect(detectSearchMode('0021-45871')).toBe('uhid');
    expect(detectSearchMode('UHID/45871')).toBe('uhid');
    expect(detectSearchMode('ABCDE1234F')).toBe('identifier');
    expect(detectSearchMode('Ramesh Kumar')).toBe('name');
  });
});

describe('PatientSearchCombobox — docs/06 §5.2 #42', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces to one server call and passes the detected mode', async () => {
    const { onSearch } = renderCombobox({});
    const field = screen.getByLabelText(labels.fieldLabel);
    fireEvent.change(field, { target: { value: 'Ram' } });
    fireEvent.change(field, { target: { value: 'Rame' } });
    fireEvent.change(field, { target: { value: 'Ramesh' } });
    expect(onSearch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('Ramesh', 'name');
  });

  it('does not search below the minimum character count', async () => {
    const { onSearch } = renderCombobox({});
    fireEvent.change(screen.getByLabelText(labels.fieldLabel), { target: { value: 'R' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onSearch).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Type at least 2 characters');
  });

  it('shows only the last four digits of a mobile number', async () => {
    const { container } = renderCombobox({});
    fireEvent.change(screen.getByLabelText(labels.fieldLabel), { target: { value: 'Ramesh' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(screen.getByText(/••••••3210/)).toBeInTheDocument();
    expect(container.textContent).not.toContain('9876543210');
  });

  it('disambiguates two identical names by UHID, age and last visit', async () => {
    renderCombobox({});
    fireEvent.change(screen.getByLabelText(labels.fieldLabel), { target: { value: 'Ramesh' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]?.textContent).toContain('0021-45871');
    expect(options[0]?.textContent).toContain('45 y');
    expect(options[1]?.textContent).toContain('0019-22104');
    expect(options[1]?.textContent).toContain('62 y');
    expect(options[1]?.textContent).toContain('Possible duplicate');
  });

  it('selects with the arrow keys and Enter, and moves aria-activedescendant', async () => {
    const { onSelect } = renderCombobox({});
    const field = screen.getByLabelText(labels.fieldLabel);
    fireEvent.change(field, { target: { value: 'Ramesh' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(field).toHaveAttribute('aria-expanded', 'true');
    // The first result is active as soon as results land.
    expect(field.getAttribute('aria-activedescendant')).toMatch(/option-0$/);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    const active = field.getAttribute('aria-activedescendant');
    expect(active).toMatch(/option-1$/);
    expect(document.getElementById(active ?? '')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(ramesh);
  });

  it('routes a non-care-team patient through break-glass, never through onSelect', async () => {
    const { onSelect, onBreakGlassRequired } = renderCombobox({});
    const field = screen.getByLabelText(labels.fieldLabel);
    fireEvent.change(field, { target: { value: 'Ramesh' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    const options = screen.getAllByRole('option');
    expect(options[1]).toHaveAttribute('data-break-glass', 'required');
    fireEvent.mouseDown(options[1] as HTMLElement);
    expect(onBreakGlassRequired).toHaveBeenCalledWith(rameshOther);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('treats a fast keystroke burst as a scan and resolves it to a patient', async () => {
    const onScanResolve = vi
      .fn<(payload: string) => Promise<PatientSearchResult | null>>()
      .mockResolvedValue(ramesh);
    const { onSelect, onSearch } = renderCombobox({ onScanResolve });

    act(() => {
      burst('002145871009', 5);
    });
    expect(onScanResolve).toHaveBeenCalledWith('002145871009');
    await act(async () => {
      await Promise.resolve();
    });
    expect(onSelect).toHaveBeenCalledWith(ramesh);
    // The burst never became a half-typed search.
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('accepts a scan typed straight into the focused field', async () => {
    const onScanResolve = vi
      .fn<(payload: string) => Promise<PatientSearchResult | null>>()
      .mockResolvedValue(ramesh);
    renderCombobox({ onScanResolve });
    const field = screen.getByLabelText(labels.fieldLabel);
    field.focus();
    act(() => {
      burst('002145871009', 5, field);
    });
    expect(onScanResolve).toHaveBeenCalledWith('002145871009');
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('ignores human typing speed', () => {
    const onScanResolve = vi
      .fn<(payload: string) => Promise<PatientSearchResult | null>>()
      .mockResolvedValue(ramesh);
    renderCombobox({ onScanResolve });
    act(() => {
      burst('002145871009', 90);
    });
    expect(onScanResolve).not.toHaveBeenCalled();
  });

  it('shows the raw payload and keeps manual search open when a scan cannot be resolved', async () => {
    const onScanResolve = vi
      .fn<(payload: string) => Promise<PatientSearchResult | null>>()
      .mockResolvedValue(null);
    const { container } = renderCombobox({ onScanResolve });
    act(() => {
      burst('BADCODE1234', 5);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-scan-state="unresolved"]')?.textContent).toContain(
      'Unrecognised code BADCODE1234',
    );
    expect(screen.getByLabelText(labels.fieldLabel)).not.toBeDisabled();
  });

  it('never auto-selects on blur', async () => {
    const { onSelect, onBreakGlassRequired } = renderCombobox({});
    const field = screen.getByLabelText(labels.fieldLabel);
    fireEvent.change(field, { target: { value: 'Ramesh' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    fireEvent.blur(field);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onBreakGlassRequired).not.toHaveBeenCalled();
  });

  it('shows recent patients before anything is typed', () => {
    renderCombobox({ recent: [ramesh] });
    fireEvent.focus(screen.getByLabelText(labels.fieldLabel));
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.getByRole('option')).toHaveAttribute('data-patient-id', 'pat_1');
  });

  it('names a failed search instead of showing an empty list', async () => {
    renderCombobox({ search: () => Promise.reject(new Error('gateway')) });
    fireEvent.change(screen.getByLabelText(labels.fieldLabel), { target: { value: 'Ramesh' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Search is unavailable');
  });

  it('closes the list on Escape', async () => {
    renderCombobox({});
    const field = screen.getByLabelText(labels.fieldLabel);
    fireEvent.change(field, { target: { value: 'Ramesh' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not spin when the caller passes an inline search lambda', async () => {
    // The realistic call site: `onSearch={(q) => api.searchPatients(q)}` — a new
    // function identity on every render. If that identity were a dependency of the
    // debounce effect, the effect's own setState would re-run it forever.
    let renders = 0;
    const served = vi.fn<() => void>();
    function Inline(): React.JSX.Element {
      renders += 1;
      return (
        <PatientSearchCombobox
          labels={labels}
          onSearch={(_query, _mode) => {
            served();
            return Promise.resolve([ramesh]);
          }}
          onSelect={() => undefined}
          onBreakGlassRequired={() => undefined}
        />
      );
    }
    render(<Inline />);
    fireEvent.change(screen.getByLabelText(labels.fieldLabel), { target: { value: 'Ramesh' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(served).toHaveBeenCalledTimes(1);
    expect(renders).toBeLessThan(10);
  });

  it('has no axe violations with results open', async () => {
    vi.useRealTimers();
    const { container } = renderCombobox({});
    fireEvent.change(screen.getByLabelText(labels.fieldLabel), { target: { value: 'Ramesh' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});
