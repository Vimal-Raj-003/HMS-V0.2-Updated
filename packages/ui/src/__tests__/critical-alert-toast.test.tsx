import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CriticalAlertToast,
  type CriticalAlert,
  type CriticalAlertToastLabels,
} from '../clinical/critical-alert-toast.js';
import { ToastProvider, ToastViewport, useToast } from '../primitives/toast.js';
import { findAccessibilityViolations } from './axe.js';

const alert: CriticalAlert = {
  id: 'alert-1',
  title: 'Critical result — Potassium 6.8 mmol/L',
  detail: 'Critical high. Reference 3.5 to 5.1. Delta up 1.9 since yesterday.',
  patientName: 'SHARMA, Ramesh Kumar',
  uhid: '0021-45871',
  raisedAt: '18-08 14:07',
};

const labels: CriticalAlertToastLabels = {
  region: 'Critical clinical alert',
  acknowledge: 'Acknowledge',
  acknowledging: 'Recording…',
  uhidPrefix: 'UHID',
  openInbox: (count) => `+${String(count)} more`,
};

describe('CriticalAlertToast — docs/06 §5.2 #32', () => {
  it('offers no way out except acknowledgement', () => {
    render(<CriticalAlertToast alert={alert} labels={labels} onAcknowledge={() => undefined} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent('Acknowledge');
    // No close affordance of any shape.
    expect(screen.queryByRole('button', { name: /dismiss|close/i })).toBeNull();
  });

  it('announces assertively and carries two patient identifiers', () => {
    const { container } = render(
      <CriticalAlertToast alert={alert} labels={labels} onAcknowledge={() => undefined} />,
    );
    const node = screen.getByRole('alert');
    expect(node).toHaveAttribute('aria-live', 'assertive');
    expect(node).toHaveTextContent('SHARMA, Ramesh Kumar');
    expect(node).toHaveTextContent('UHID 0021-45871');
    expect(container.querySelector('[data-requires-acknowledgement="true"]')).not.toBeNull();
  });

  it('records who acknowledged, by keyboard', () => {
    const onAcknowledge = vi.fn();
    render(<CriticalAlertToast alert={alert} labels={labels} onAcknowledge={onAcknowledge} />);
    const button = screen.getByRole('button', { name: 'Acknowledge' });
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onAcknowledge).toHaveBeenCalledWith('alert-1');
  });

  it('does not double-record when the acknowledge button is hit twice', () => {
    const onAcknowledge = vi.fn();
    render(<CriticalAlertToast alert={alert} labels={labels} onAcknowledge={onAcknowledge} />);
    const button = screen.getByRole('button', { name: 'Acknowledge' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <CriticalAlertToast alert={alert} labels={labels} onAcknowledge={() => undefined} />,
    );
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });

  /**
   * The toast *item* was axe-tested from the start; the viewport that wraps it
   * never was, and that is where the defect lived — `aria-label` on a role-less
   * <div>, which ARIA prohibits, so the region's name was discarded and it
   * announced as nothing. Testing a component in isolation does not test the
   * container it is mounted into.
   */
  it('gives the viewport a named landmark, and has no axe violations', async () => {
    const { container } = render(
      <ToastProvider>
        <ToastViewport label="Notifications" />
      </ToastProvider>,
    );
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeInTheDocument();
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});

function Publisher(): React.JSX.Element {
  const { publish, dismiss, toasts, overflow } = useToast();
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          publish({ id: 'critical-1', title: 'Code blue — Ward 3B', severity: 'critical' });
        }}
      >
        raise critical
      </button>
      <button
        type="button"
        onClick={() => {
          publish({ id: 'info-1', title: 'Rx signed', severity: 'success' });
        }}
      >
        raise info
      </button>
      <button
        type="button"
        data-testid="try-dismiss"
        onClick={() => {
          dismiss('critical-1');
        }}
      >
        try dismiss
      </button>
      <output data-testid="counts">{`${String(toasts.length)}/${String(overflow)}`}</output>
    </div>
  );
}

describe('the toast engine — docs/06 §6.8', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-dismisses an ordinary toast after 4 s but never a critical one', () => {
    render(
      <ToastProvider>
        <Publisher />
        <ToastViewport label="Notifications" />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByText('raise info'));
    fireEvent.click(screen.getByText('raise critical'));
    expect(screen.getByText('Rx signed')).toBeInTheDocument();
    expect(screen.getByText('Code blue — Ward 3B')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(screen.queryByText('Rx signed')).toBeNull();
    // Ten seconds later the critical alert is still on screen, unacknowledged.
    expect(screen.getByText('Code blue — Ward 3B')).toBeInTheDocument();
  });

  it('refuses a programmatic dismiss of an unacknowledged critical alert', () => {
    render(
      <ToastProvider>
        <Publisher />
        <ToastViewport label="Notifications" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('raise critical'));
    fireEvent.click(screen.getByTestId('try-dismiss'));
    expect(screen.getByText('Code blue — Ward 3B')).toBeInTheDocument();
  });

  it('removes a critical alert only through Acknowledge', () => {
    const onAcknowledge = vi.fn();
    function AckPublisher(): React.JSX.Element {
      const { publish } = useToast();
      return (
        <button
          type="button"
          onClick={() => {
            publish({
              id: 'critical-2',
              title: 'NEWS2 7 — Bed 12',
              severity: 'critical',
              acknowledgeLabel: 'Acknowledge',
              onAcknowledge,
            });
          }}
        >
          raise
        </button>
      );
    }

    render(
      <ToastProvider>
        <AckPublisher />
        <ToastViewport label="Notifications" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('raise'));
    expect(screen.getByText('NEWS2 7 — Bed 12')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(onAcknowledge).toHaveBeenCalledWith('critical-2');
    expect(screen.queryByText('NEWS2 7 — Bed 12')).toBeNull();
  });
});
