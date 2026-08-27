import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DispenseAlertView } from '../api/types';
import type { CounterAlert } from '../lib/counter';
import { HardStopPanel } from './hard-stop-panel';

/**
 * `docs/06` §1.2: a hard stop is "modal, cannot be dismissed, requires a
 * documented override reason".
 *
 * The first two are structural properties of this component, and the tests below
 * are written to fail if somebody adds a close button, an Escape handler or a
 * "don't show again" — which is what every alert panel eventually grows.
 */
function alert(overrides: Partial<DispenseAlertView> = {}): DispenseAlertView {
  return {
    key: 'ALLERGY:PENICILLIN',
    family: 'allergy',
    severity: 'contraindicated',
    interruption: 'hard_stop',
    title: 'Documented penicillin allergy (anaphylaxis)',
    detail: 'Amoxicillin is a penicillin. The patient has a recorded anaphylactic reaction.',
    acknowledged: false,
    ...overrides,
  };
}

const BLOCKING: readonly CounterAlert[] = [
  { dispenseItemId: 'item-1', lineNo: 1, itemName: 'Amoxicillin 500 mg', alert: alert() },
];

const ADVISORY: readonly CounterAlert[] = [
  {
    dispenseItemId: 'item-2',
    lineNo: 2,
    itemName: 'Morphine 10 mg/ml',
    alert: alert({
      key: 'SCHED:NO_REG',
      family: 'schedule_guardrail',
      title: 'Prescriber registration missing',
    }),
  },
];

describe('the hard stop panel', () => {
  it('announces the alert assertively rather than waiting to be noticed', () => {
    render(
      <HardStopPanel
        blocking={BLOCKING}
        advisory={[]}
        reasons={new Map()}
        onReasonChange={() => undefined}
      />,
    );
    const region = screen.getByTestId('blocking-alerts');
    expect(region).toHaveAttribute('role', 'alert');
    expect(region).toHaveAttribute('aria-live', 'assertive');
    expect(region).toHaveTextContent('Documented penicillin allergy');
  });

  /**
   * The assertion that matters. A close button, an × or a "dismiss" is the one
   * thing this panel must never grow — so every control inside it is
   * enumerated, and the only one allowed is the reason box.
   */
  it('offers no control that dismisses, closes or silences it', () => {
    render(
      <HardStopPanel
        blocking={BLOCKING}
        advisory={ADVISORY}
        reasons={new Map()}
        onReasonChange={() => undefined}
      />,
    );
    const panel = screen.getByTestId('hard-stop-panel');

    // No button of any kind. Not "dismiss", not "×", not "acknowledge" — the
    // component is a region of the page rather than a dialog, so there is
    // nothing to close and no scrim to click.
    expect(within(panel).queryAllByRole('button')).toHaveLength(0);
    expect(within(panel).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(panel).queryAllByRole('link')).toHaveLength(0);
    expect(panel.querySelectorAll('[aria-label]')).toHaveLength(0);

    // The only interactive controls at all are the recorded-reason textareas,
    // one per blocking alert and none for the advisory ones.
    const fields = within(panel).getAllByRole('textbox');
    expect(fields).toHaveLength(BLOCKING.length);
    expect(panel.querySelectorAll('button, input, select, a, [tabindex]')).toHaveLength(0);
  });

  it('says in words that it cannot be dismissed and names the lawful path', () => {
    render(
      <HardStopPanel
        blocking={BLOCKING}
        advisory={[]}
        reasons={new Map()}
        onReasonChange={() => undefined}
      />,
    );
    const region = screen.getByTestId('blocking-alerts');
    expect(region).toHaveTextContent(/cannot be dismissed/iu);
    expect(region).toHaveTextContent(/no setting that turns it off/iu);
    expect(region).toHaveTextContent(/Telephone the prescriber/iu);
  });

  it('tells the pharmacist the button stays blocked until the reason is real', () => {
    render(
      <HardStopPanel
        blocking={BLOCKING}
        advisory={[]}
        reasons={new Map()}
        onReasonChange={() => undefined}
      />,
    );
    expect(screen.getByTestId('hard-stop-panel')).toHaveTextContent(/Completion stays blocked/iu);
  });

  it('changes its help text once a reason has been recorded, without hiding the alert', () => {
    const reasons = new Map([
      ['item-1::ALLERGY:PENICILLIN', 'Dr Menon telephoned 10:42 — rash on prior exposure, not anaphylaxis.'],
    ]);
    render(
      <HardStopPanel blocking={BLOCKING} advisory={[]} reasons={reasons} onReasonChange={() => undefined} />,
    );
    expect(screen.getByTestId('blocking-alerts')).toHaveTextContent(/Recorded\./u);
    // Still on screen. Recording a reason documents the decision; it does not
    // make the alert go away.
    expect(screen.getByTestId('blocking-alerts')).toHaveTextContent('Documented penicillin allergy');
  });

  it('reports every keystroke of the reason to the screen that owns it', () => {
    const onReasonChange = vi.fn();
    render(
      <HardStopPanel blocking={BLOCKING} advisory={[]} reasons={new Map()} onReasonChange={onReasonChange} />,
    );
    const field = screen.getByTestId('ack-ALLERGY:PENICILLIN');
    fireEvent.change(field, { target: { value: 'Prescriber confirmed at 10:42' } });
    expect(onReasonChange).toHaveBeenCalledWith(
      'item-1::ALLERGY:PENICILLIN',
      'Prescriber confirmed at 10:42',
    );
  });

  /**
   * Alert fatigue is a safety defect (`docs/06` §1.2, EN-037). The alerts that
   * hold the counter and the alerts that already stopped the prescriber are
   * rendered as two different things, and only the first demands a reason.
   */
  it('separates what holds this counter from what stopped the prescriber', () => {
    render(
      <HardStopPanel
        blocking={BLOCKING}
        advisory={ADVISORY}
        reasons={new Map()}
        onReasonChange={() => undefined}
      />,
    );
    expect(screen.getByTestId('blocking-alerts')).toHaveTextContent('Documented penicillin allergy');
    const advisory = screen.getByTestId('advisory-alerts');
    expect(advisory).toHaveTextContent('Prescriber registration missing');
    expect(advisory).toHaveTextContent(/do not hold the counter/iu);
    expect(within(advisory).queryAllByRole('textbox')).toHaveLength(0);
  });

  it('renders nothing at all when there is no alert — no empty red box', () => {
    const { container } = render(
      <HardStopPanel blocking={[]} advisory={[]} reasons={new Map()} onReasonChange={() => undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
