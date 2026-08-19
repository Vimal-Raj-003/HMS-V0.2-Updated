import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PairingScreen } from '../features/pairing/pairing-screen';
import type { PairingState } from '../features/pairing/use-pairing';

const NOW = new Date('2026-08-19T14:07:02');

const awaiting: PairingState = {
  phase: 'awaiting',
  challenge: {
    deviceId: 'device-corridor-a',
    pairingCode: '483920',
    expiresAt: '2026-08-19T14:17:02.000Z',
    pollIntervalMs: 3000,
  },
};

describe('PairingScreen', () => {
  it('shows the pairing code an operator has to type into the console', () => {
    render(
      <PairingScreen
        state={awaiting}
        deviceId="device-corridor-a"
        now={NOW}
        boardHint="This screen is not yet assigned to a board."
      />,
    );

    expect(screen.getByTestId('pairing-code')).toHaveTextContent('483920');
    expect(screen.getByText(/Enter this code in the display fleet console/i)).toBeInTheDocument();
    expect(screen.getByTestId('pairing-screen')).toHaveAttribute('data-phase', 'awaiting');
  });

  it('shows a clock and the device identity so IT can match screen to record', () => {
    render(<PairingScreen state={awaiting} deviceId="device-corridor-a" now={NOW} boardHint="Unassigned" />);

    expect(screen.getByTestId('pairing-clock')).toHaveTextContent('14:07:02');
    expect(screen.getByText(/Device device-c/)).toBeInTheDocument();
  });

  it('says the pairing service is unreachable instead of showing a dead code', () => {
    render(
      <PairingScreen
        state={{ phase: 'unreachable', message: 'fetch failed' }}
        deviceId="device-corridor-a"
        now={NOW}
        boardHint="Unassigned"
      />,
    );

    expect(screen.getByTestId('pairing-unreachable')).toBeInTheDocument();
    expect(screen.queryByTestId('pairing-code')).not.toBeInTheDocument();
  });
});
