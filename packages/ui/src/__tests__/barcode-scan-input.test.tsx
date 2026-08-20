import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BarcodeScanInput,
  type BarcodeScanInputLabels,
  type ScanResolution,
} from '../clinical/barcode-scan-input.js';
import { findAccessibilityViolations } from './axe.js';

const labels: BarcodeScanInputLabels = {
  fieldLabel: 'Scan wristband or specimen',
  placeholder: 'Scan or type the code',
  resolving: 'Resolving…',
  unresolved: (raw) => `Unrecognised code ${raw}.`,
  manualEntryHint: 'Search manually.',
};

/** Dispatches a keydown burst with controlled inter-key intervals (docs/06 §6.2). */
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

const resolution: ScanResolution = {
  entityId: 'pat_01J8',
  display: 'SHARMA, Ramesh Kumar · UHID 0021-45871',
  entityKind: 'patient',
};

describe('BarcodeScanInput — docs/06 §5.2 #23 and §6.2', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats a fast keystroke burst terminated by Enter as a scan', async () => {
    const resolve = vi
      .fn<(payload: string) => Promise<ScanResolution | null>>()
      .mockResolvedValue(resolution);
    const onResolved = vi.fn();
    render(<BarcodeScanInput labels={labels} resolve={resolve} onResolved={onResolved} />);

    act(() => {
      burst('0021458710', 5);
    });
    expect(resolve).toHaveBeenCalledWith('0021458710');

    // §5.2 #23 — the decoded entity is shown for 1.5 s BEFORE the action fires.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(resolution.display)).toBeInTheDocument();
    expect(onResolved).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(onResolved).toHaveBeenCalledWith(resolution);
  });

  it('ignores human typing speed — a slow burst is not a scan', () => {
    const resolve = vi
      .fn<(payload: string) => Promise<ScanResolution | null>>()
      .mockResolvedValue(resolution);
    render(<BarcodeScanInput labels={labels} resolve={resolve} onResolved={() => undefined} />);
    act(() => {
      burst('0021458710', 80);
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('ignores a burst that is too short to be a barcode', () => {
    const resolve = vi
      .fn<(payload: string) => Promise<ScanResolution | null>>()
      .mockResolvedValue(resolution);
    render(<BarcodeScanInput labels={labels} resolve={resolve} onResolved={() => undefined} />);
    act(() => {
      burst('123', 5);
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('strips the device-profile prefix before resolving', () => {
    const resolve = vi
      .fn<(payload: string) => Promise<ScanResolution | null>>()
      .mockResolvedValue(resolution);
    render(<BarcodeScanInput labels={labels} resolve={resolve} onResolved={() => undefined} prefix="~" />);
    act(() => {
      burst('~0021458710', 5);
    });
    expect(resolve).toHaveBeenCalledWith('0021458710');
  });

  it('shows the raw payload and a manual path when the scan cannot be resolved', async () => {
    const resolve = vi.fn<(payload: string) => Promise<ScanResolution | null>>().mockResolvedValue(null);
    render(<BarcodeScanInput labels={labels} resolve={resolve} onResolved={() => undefined} />);
    act(() => {
      burst('BADCODE123', 5);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/Unrecognised code BADCODE123/)).toHaveTextContent('Search manually.');
  });

  it('always offers a keyboard-only manual entry path', async () => {
    const resolve = vi
      .fn<(payload: string) => Promise<ScanResolution | null>>()
      .mockResolvedValue(resolution);
    render(<BarcodeScanInput labels={labels} resolve={resolve} onResolved={() => undefined} />);
    const field = screen.getByLabelText(labels.fieldLabel);
    field.focus();
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: 'L-4471' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(resolve).toHaveBeenCalledWith('L-4471');
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('has no axe violations', async () => {
    // axe-core schedules its own work; it needs the real timer queue.
    vi.useRealTimers();
    const resolve = vi
      .fn<(payload: string) => Promise<ScanResolution | null>>()
      .mockResolvedValue(resolution);
    const { container } = render(
      <BarcodeScanInput labels={labels} resolve={resolve} onResolved={() => undefined} />,
    );
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});
