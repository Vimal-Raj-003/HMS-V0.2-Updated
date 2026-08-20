import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  PrintPreview,
  type PrintPreviewLabels,
  type PrintRequest,
  type PrintTarget,
} from '../clinical/print-preview.js';
import { findAccessibilityViolations } from './axe.js';

const labels: PrintPreviewLabels = {
  region: 'Print the UHID card',
  previewLabel: 'Preview of the UHID card',
  target: 'Printer',
  targetPlaceholder: 'Choose a printer',
  tray: 'Tray',
  copies: 'Copies',
  print: 'Print',
  printViaBrowser: 'Print via the browser',
  printLater: 'Print later',
  agentConnected: 'Print agent connected',
  agentDisconnected: (since) => `Print agent offline since ${since}`,
  agentNotInstalled: 'No print agent on this machine',
  printerOffline: 'This printer is reporting offline.',
  lastPrint: (by, at, target, copies) =>
    `Last printed by ${by} at ${at} on ${target} (${String(copies)} copies).`,
  duplicateWarning: 'Do not hand out a second copy without checking.',
  noTargets: 'No printer on this counter takes this stock.',
};

const thermal: PrintTarget = {
  id: 'p1',
  label: 'Reception thermal (80 mm)',
  paper: 'thermal-80',
  status: 'online',
};
const offlineThermal: PrintTarget = { ...thermal, id: 'p2', label: 'Back office', status: 'offline' };
const a4: PrintTarget = {
  id: 'p3',
  label: 'Records A4',
  paper: 'a4',
  status: 'online',
  trays: [{ id: 't1', label: 'Tray 1' }],
};

describe('PrintPreview — docs/06 §5.2 #35', () => {
  it('renders the template at the true paper aspect', () => {
    const { container } = render(
      <PrintPreview
        paper="wristband"
        targets={[]}
        agent={{ kind: 'connected' }}
        labels={labels}
        onPrint={() => undefined}
      >
        <span>SHARMA, Ramesh · 0021-45871</span>
      </PrintPreview>,
    );
    const preview = container.querySelector('[data-paper-preview="wristband"]');
    expect(preview).not.toBeNull();
    expect((preview as HTMLElement).style.aspectRatio).toBe('280 / 25');
    expect(screen.getByText('SHARMA, Ramesh · 0021-45871')).toBeInTheDocument();
  });

  it('warns about the previous print of the same document', () => {
    const { container } = render(
      <PrintPreview
        paper="thermal-80"
        targets={[thermal]}
        agent={{ kind: 'connected' }}
        labels={labels}
        onPrint={() => undefined}
        lastPrint={{ by: 'Cashier R. Devi', at: '20-08 14:02', target: 'Reception thermal', copies: 1 }}
      >
        <span>Receipt</span>
      </PrintPreview>,
    );
    const banner = container.querySelector('[data-last-print]');
    expect(banner?.textContent).toContain('Last printed by Cashier R. Devi at 20-08 14:02');
    expect(banner?.textContent).toContain('Do not hand out a second copy without checking.');
  });

  it('offers the browser fallback by name when the print agent is down', () => {
    const onPrint = vi.fn<(request: PrintRequest) => void>();
    const { container } = render(
      <PrintPreview
        paper="thermal-80"
        targets={[thermal]}
        agent={{ kind: 'disconnected', since: '13:40' }}
        labels={labels}
        onPrint={onPrint}
      >
        <span>Receipt</span>
      </PrintPreview>,
    );
    expect(container.querySelector('[data-agent-state="disconnected"]')?.textContent).toContain(
      'Print agent offline since 13:40',
    );
    expect(screen.getByRole('button', { name: 'Print' })).toBeDisabled();
    const fallback = screen.getByRole('button', { name: 'Print via the browser' });
    expect(fallback).not.toBeDisabled();
    fireEvent.click(fallback);
    expect(onPrint).toHaveBeenCalledWith({ targetId: 'p1', copies: 1, via: 'browser' });
  });

  it('says a printer is offline instead of silently failing', () => {
    const { container } = render(
      <PrintPreview
        paper="thermal-80"
        targets={[offlineThermal]}
        agent={{ kind: 'connected' }}
        labels={labels}
        onPrint={() => undefined}
      >
        <span>Receipt</span>
      </PrintPreview>,
    );
    expect(container.querySelector('[data-printer-offline]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Print' })).toBeDisabled();
  });

  it('only lists printers that take this stock', () => {
    render(
      <PrintPreview
        paper="a4"
        targets={[thermal, a4]}
        agent={{ kind: 'connected' }}
        labels={labels}
        onPrint={() => undefined}
      >
        <span>Discharge summary</span>
      </PrintPreview>,
    );
    expect(screen.getByRole('combobox', { name: /Printer/ })).toHaveTextContent('Records A4');
  });

  it('clamps the copy count to a sane range', () => {
    render(
      <PrintPreview
        paper="thermal-80"
        targets={[thermal]}
        agent={{ kind: 'connected' }}
        labels={labels}
        onPrint={() => undefined}
        maxCopies={3}
      >
        <span>Receipt</span>
      </PrintPreview>,
    );
    const copies = screen.getByLabelText('Copies');
    fireEvent.change(copies, { target: { value: '9' } });
    expect(copies).toHaveValue('3');
    fireEvent.change(copies, { target: { value: '0' } });
    expect(copies).toHaveValue('1');
  });

  it('queues a job for later when asked', () => {
    const onPrintLater = vi.fn();
    render(
      <PrintPreview
        paper="thermal-80"
        targets={[thermal]}
        agent={{ kind: 'not-installed' }}
        labels={labels}
        onPrint={() => undefined}
        onPrintLater={onPrintLater}
      >
        <span>Receipt</span>
      </PrintPreview>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Print later' }));
    expect(onPrintLater).toHaveBeenCalledWith({ targetId: 'p1', copies: 1 });
  });

  it('says so when no printer takes this stock', () => {
    render(
      <PrintPreview
        paper="wristband"
        targets={[thermal]}
        agent={{ kind: 'connected' }}
        labels={labels}
        onPrint={() => undefined}
      >
        <span>Wristband</span>
      </PrintPreview>,
    );
    expect(screen.getByText('No printer on this counter takes this stock.')).toBeInTheDocument();
  });

  it('is operable by keyboard and has no axe violations', async () => {
    const { container } = render(
      <PrintPreview
        paper="a4"
        targets={[a4]}
        agent={{ kind: 'connected' }}
        labels={labels}
        onPrint={() => undefined}
        onPrintLater={() => undefined}
        lastPrint={{ by: 'MRD clerk', at: '20-08 09:15', target: 'Records A4', copies: 2 }}
      >
        <span>Discharge summary</span>
      </PrintPreview>,
    );
    const copies = screen.getByLabelText('Copies');
    copies.focus();
    expect(document.activeElement).toBe(copies);
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});
