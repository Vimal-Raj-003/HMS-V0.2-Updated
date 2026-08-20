'use client';

import { Camera, CameraOff, RefreshCw, Upload, User } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/button.js';

/**
 * `PhotoCapture` — the registration-desk patient photo (docs/prompts/phase-01 §1.2:
 * "photo capture (webcam/phone)").
 *
 * Design rules:
 *  - **The fallback is not an error path, it is a peer path.** Half the counters in a
 *    district hospital have no webcam and the clerk photographs the patient on a phone.
 *    The file/gallery control is therefore always rendered, at every state.
 *  - **A failure is always named.** `unavailable` carries a reason from a closed union
 *    (`no-device`, `permission-denied`, `insecure-context`, `error`), so the screen can
 *    say *what* happened and *what to do next* (docs/06 §6.7) instead of showing a dead
 *    black rectangle.
 *  - The camera stream is stopped on unmount, on capture and on retake. A registration
 *    desk that leaves the webcam LED on after the patient leaves is a privacy incident.
 */

export type PhotoUnavailableReason =
  /** No camera on this device, or the browser exposes no `mediaDevices`. */
  | 'no-device'
  /** The user or an admin policy denied camera access. */
  | 'permission-denied'
  /** `getUserMedia` needs a secure context; an on-prem HTTP kiosk will land here. */
  | 'insecure-context'
  | 'error';

export type PhotoCaptureState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'requesting' }
  | { readonly kind: 'streaming' }
  | { readonly kind: 'captured'; readonly dataUrl: string }
  | { readonly kind: 'unavailable'; readonly reason: PhotoUnavailableReason };

export interface PhotoCaptureLabels {
  readonly region: string;
  readonly start: string;
  readonly capture: string;
  readonly retake: string;
  readonly accept: string;
  readonly uploadInstead: string;
  readonly requesting: string;
  readonly previewAlt: string;
  readonly livePreviewLabel: string;
  readonly noPhotoYet: string;
  readonly unavailable: Readonly<Record<PhotoUnavailableReason, string>>;
  readonly fallbackHint: string;
}

export interface PhotoCaptureProps {
  readonly labels: PhotoCaptureLabels;
  /** Receives a `data:` URL. Uploading it is the caller's job (presigned S3, docs/02). */
  readonly onCapture: (dataUrl: string) => void;
  /** Existing photo, e.g. when editing a patient. */
  readonly initialDataUrl?: string;
  /** Square by default — a UHID card and a wristband both crop to a square. */
  readonly width?: number;
  readonly height?: number;
  /** JPEG keeps a 480×480 face under ~40 kB, which matters on a 2G branch link. */
  readonly mimeType?: string;
  readonly quality?: number;
  readonly disabled?: boolean;
  readonly className?: string;
}

interface MediaCapableNavigator {
  readonly mediaDevices?: {
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  };
}

function mediaDevicesOf(): MediaCapableNavigator['mediaDevices'] | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as unknown as MediaCapableNavigator).mediaDevices;
}

/**
 * `play()` is best-effort. A browser autoplay policy, a headless/test environment or a
 * kiosk shell without a media stack can make it reject or throw, and none of those mean
 * the camera failed — the stream is already attached. Swallowing it here keeps a
 * working camera out of the `unavailable` state.
 */
function startPlayback(video: HTMLVideoElement): void {
  try {
    const played: unknown = video.play();
    if (played instanceof Promise) {
      void played.catch(() => undefined);
    }
  } catch {
    return;
  }
}

function reasonFor(error: unknown): PhotoUnavailableReason {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure-context';
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'permission-denied';
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return 'no-device';
  }
  return 'error';
}

export function PhotoCapture({
  labels,
  onCapture,
  initialDataUrl,
  width = 480,
  height = 480,
  mimeType = 'image/jpeg',
  quality = 0.85,
  disabled = false,
  className,
}: PhotoCaptureProps): React.JSX.Element {
  const fieldId = useId();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<PhotoCaptureState>(() =>
    initialDataUrl === undefined ? { kind: 'idle' } : { kind: 'captured', dataUrl: initialDataUrl },
  );

  const stopStream = useCallback((): void => {
    const stream = streamRef.current;
    if (stream !== null) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (videoRef.current !== null) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => stopStream, [stopStream]);

  const start = (): void => {
    const devices = mediaDevicesOf();
    if (devices?.getUserMedia === undefined) {
      setState({
        kind: 'unavailable',
        reason:
          typeof window !== 'undefined' && window.isSecureContext === false
            ? 'insecure-context'
            : 'no-device',
      });
      return;
    }
    setState({ kind: 'requesting' });
    void devices
      .getUserMedia({ video: { width, height, facingMode: 'user' }, audio: false })
      .then((stream) => {
        streamRef.current = stream;
        if (videoRef.current !== null) {
          videoRef.current.srcObject = stream;
          startPlayback(videoRef.current);
        }
        setState({ kind: 'streaming' });
      })
      .catch((error: unknown) => {
        setState({ kind: 'unavailable', reason: reasonFor(error) });
      });
  };

  const capture = (): void => {
    const video = videoRef.current;
    if (video === null) return;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) {
      // jsdom, a locked-down kiosk browser, or a blocked canvas: say so and offer upload.
      setState({ kind: 'unavailable', reason: 'error' });
      stopStream();
      return;
    }
    context.drawImage(video, 0, 0, width, height);
    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL(mimeType, quality);
    } catch {
      setState({ kind: 'unavailable', reason: 'error' });
      stopStream();
      return;
    }
    stopStream();
    setState({ kind: 'captured', dataUrl });
    onCapture(dataUrl);
  };

  const onFile = (file: File | undefined): void => {
    if (file === undefined) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') return;
      stopStream();
      setState({ kind: 'captured', dataUrl: result });
      onCapture(result);
    };
    reader.readAsDataURL(file);
  };

  return (
    <section
      data-slot="photo-capture"
      data-state={state.kind}
      role="group"
      aria-label={labels.region}
      className={cn('flex flex-col gap-2', className)}
    >
      <div
        className={cn(
          'relative flex aspect-square w-40 items-center justify-center overflow-hidden',
          'rounded-lg border border-default bg-sunken text-fg-subtle',
        )}
      >
        {state.kind === 'captured' ? (
          // A plain <img>: packages/ui is framework-agnostic and a `data:` URL has
          // nothing for an image CDN to optimise.
          <img src={state.dataUrl} alt={labels.previewAlt} className="size-full object-cover" />
        ) : null}

        <video
          ref={videoRef}
          aria-label={labels.livePreviewLabel}
          muted
          playsInline
          className={cn('size-full object-cover', state.kind === 'streaming' ? '' : 'hidden')}
        />

        {state.kind === 'idle' ? (
          <span className="flex flex-col items-center gap-1 text-2xs">
            <User aria-hidden="true" className="size-6" />
            {labels.noPhotoYet}
          </span>
        ) : null}

        {state.kind === 'requesting' ? (
          <span className="flex flex-col items-center gap-1 text-2xs">
            <RefreshCw aria-hidden="true" className="size-6 motion-safe:animate-spin" />
            {labels.requesting}
          </span>
        ) : null}

        {state.kind === 'unavailable' ? (
          <span
            data-unavailable-reason={state.reason}
            className="flex flex-col items-center gap-1 px-2 text-center text-2xs text-warning-fg"
          >
            <CameraOff aria-hidden="true" className="size-6" />
            {labels.unavailable[state.reason]}
          </span>
        ) : null}
      </div>

      <p role="status" aria-live="polite" className="min-h-4 text-xs text-fg-muted">
        {state.kind === 'unavailable' ? `${labels.unavailable[state.reason]} ${labels.fallbackHint}` : null}
        {state.kind === 'requesting' ? labels.requesting : null}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {state.kind === 'streaming' ? (
          <Button variant="primary" size="sm" disabled={disabled} onClick={capture}>
            <Camera aria-hidden="true" />
            {labels.capture}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" disabled={disabled} onClick={start}>
            <Camera aria-hidden="true" />
            {state.kind === 'captured' ? labels.retake : labels.start}
          </Button>
        )}

        {/* Always present, at every state — the fallback is a peer, not a consolation. */}
        <Button variant="ghost" size="sm" disabled={disabled} asChild>
          <label htmlFor={`${fieldId}-file`} className="cursor-pointer">
            <Upload aria-hidden="true" />
            {labels.uploadInstead}
          </label>
        </Button>
        <input
          id={`${fieldId}-file`}
          type="file"
          accept="image/*"
          capture="user"
          disabled={disabled}
          className="sr-only"
          onChange={(event) => {
            onFile(event.target.files?.[0]);
          }}
        />
      </div>
    </section>
  );
}
