import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhotoCapture, type PhotoCaptureLabels } from '../clinical/photo-capture.js';
import { findAccessibilityViolations } from './axe.js';

const labels: PhotoCaptureLabels = {
  region: 'Patient photo',
  start: 'Use the webcam',
  capture: 'Take photo',
  retake: 'Retake',
  accept: 'Use this photo',
  uploadInstead: 'Upload from this device',
  requesting: 'Waiting for the camera…',
  previewAlt: 'Photo of the patient',
  livePreviewLabel: 'Live camera preview',
  noPhotoYet: 'No photo yet',
  unavailable: {
    'no-device': 'No camera on this counter.',
    'permission-denied': 'Camera access was refused for this browser.',
    'insecure-context': 'The camera needs an https connection.',
    error: 'The camera could not be started.',
  },
  fallbackHint: 'Upload a photo taken on a phone instead.',
};

function setMediaDevices(value: unknown): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  setMediaDevices(undefined);
});

describe('PhotoCapture — phase-01 §1.2', () => {
  it('always offers the upload fallback, at every state', () => {
    const { container } = render(<PhotoCapture labels={labels} onCapture={() => undefined} />);
    expect(container.querySelector('[data-slot="photo-capture"]')).toHaveAttribute('data-state', 'idle');
    expect(screen.getByLabelText('Upload from this device')).toBeInTheDocument();
  });

  it('names the reason when the counter has no camera', () => {
    setMediaDevices(undefined);
    const { container } = render(<PhotoCapture labels={labels} onCapture={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Use the webcam/ }));
    expect(container.querySelector('[data-unavailable-reason="no-device"]')).not.toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('No camera on this counter.');
    expect(screen.getByRole('status')).toHaveTextContent('Upload a photo taken on a phone instead.');
    // The fallback is still there — the failure is not a dead end.
    expect(screen.getByLabelText('Upload from this device')).toBeInTheDocument();
  });

  it('distinguishes a refused permission from a missing camera', async () => {
    const denied = new Error('denied');
    denied.name = 'NotAllowedError';
    setMediaDevices({ getUserMedia: vi.fn().mockRejectedValue(denied) });
    const { container } = render(<PhotoCapture labels={labels} onCapture={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Use the webcam/ }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-unavailable-reason="permission-denied"]')).not.toBeNull();
  });

  it('reaches the streaming state when a camera is available', async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] };
    setMediaDevices({ getUserMedia: vi.fn().mockResolvedValue(stream) });
    const { container } = render(<PhotoCapture labels={labels} onCapture={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Use the webcam/ }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-slot="photo-capture"]')).toHaveAttribute('data-state', 'streaming');
    expect(screen.getByRole('button', { name: /Take photo/ })).toBeInTheDocument();
  });

  it('stops the camera when the component unmounts', async () => {
    const track = { stop: vi.fn() };
    setMediaDevices({ getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }) });
    const { unmount } = render(<PhotoCapture labels={labels} onCapture={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Use the webcam/ }));
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('shows an existing photo and offers a retake', () => {
    const { container } = render(
      <PhotoCapture
        labels={labels}
        onCapture={() => undefined}
        initialDataUrl="data:image/png;base64,iVBORw0KGgo="
      />,
    );
    expect(container.querySelector('[data-slot="photo-capture"]')).toHaveAttribute('data-state', 'captured');
    expect(screen.getByAltText('Photo of the patient')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retake/ })).toBeInTheDocument();
  });

  it('is operable by keyboard', () => {
    render(<PhotoCapture labels={labels} onCapture={() => undefined} />);
    const start = screen.getByRole('button', { name: /Use the webcam/ });
    start.focus();
    expect(document.activeElement).toBe(start);
    const upload = screen.getByLabelText('Upload from this device');
    upload.focus();
    expect(document.activeElement).toBe(upload);
  });

  it('has no axe violations', async () => {
    const { container } = render(<PhotoCapture labels={labels} onCapture={() => undefined} />);
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});
