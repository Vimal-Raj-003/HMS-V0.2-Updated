import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ConsentCapture,
  type ConsentArtefact,
  type ConsentCaptureLabels,
  type ConsentNotice,
  type ConsentPurpose,
} from '../clinical/consent-capture.js';
import { strokesToDataUrl } from '../clinical/signature-pad.js';
import { findAccessibilityViolations } from './axe.js';

const notice: ConsentNotice = {
  templateId: 'dpdp-registration',
  version: '3.2',
  locale: 'en-IN',
  title: 'Notice — how we use your health information',
  body: 'We collect your name, contact details and health records to provide care…',
  publishedOn: '01-04-2026',
};

const purposes: readonly ConsentPurpose[] = [
  { code: 'care', label: 'Provide treatment and keep your medical record', mandatory: true },
  { code: 'insurance', label: 'Share your claim with your insurer or TPA', mandatory: false },
  { code: 'marketing', label: 'Send you health-camp offers', mandatory: false },
];

const signatureLabels = {
  label: 'Signature',
  hint: 'Sign with a finger or a stylus',
  clear: 'Clear signature',
  captured: 'Signature captured',
  empty: 'No signature yet',
};

const labels: ConsentCaptureLabels = {
  region: 'Consent',
  versionPrefix: 'Version',
  publishedPrefix: 'Published',
  languageLabel: 'Language',
  noticeRegion: 'Consent notice text',
  scrollToEnd: 'Scroll to the end of the notice before consenting.',
  noticeRead: 'Notice read',
  purposesHeading: 'What you are consenting to',
  mandatoryMarker: '(required for treatment)',
  optionalMarker: '(optional)',
  subjectHeading: 'Who is consenting',
  subjectSelf: 'The patient',
  subjectGuardian: 'A parent or guardian',
  guardianName: 'Guardian name',
  guardianRelation: 'Relationship to the patient',
  attestationHeading: 'How consent is being given',
  method: {
    'drawn-signature': 'Signature',
    'thumb-impression': 'Thumb impression',
    otp: 'OTP to registered mobile',
    witnessed: 'Witnessed',
  },
  otpReference: 'OTP reference',
  otpHint: 'Enter the reference shown after the patient confirms the OTP.',
  witnessName: 'Witness name',
  witnessRelation: 'Witness relationship',
  grant: 'Record consent',
  withdraw: 'Withdraw consent',
  withdrawHint: 'You may withdraw at any time; care will not be refused.',
  blockedReason: 'Tick every required purpose and capture an attestation to continue.',
  signature: signatureLabels,
  thumb: { ...signatureLabels, label: 'Thumb impression' },
};

function renderConsent(onGrant: (artefact: ConsentArtefact) => void) {
  return render(
    <ConsentCapture
      notice={notice}
      purposes={purposes}
      labels={labels}
      methods={['otp', 'drawn-signature', 'thumb-impression', 'witnessed']}
      onGrant={onGrant}
      onWithdraw={() => undefined}
      allowGuardian
    />,
  );
}

describe('ConsentCapture — EN-028 / DPDP', () => {
  it('shows the notice version and publication date next to the title', () => {
    const { container } = renderConsent(() => undefined);
    expect(container.querySelector('[data-consent-version="3.2"]')?.textContent).toBe('Version 3.2');
    expect(screen.getByText('Published 01-04-2026')).toBeInTheDocument();
  });

  it('pre-ticks nothing — consent is an affirmative action', () => {
    renderConsent(() => undefined);
    for (const checkbox of screen.getAllByRole('checkbox')) {
      expect(checkbox).toHaveAttribute('data-state', 'unchecked');
    }
    expect(screen.getByRole('button', { name: 'Record consent' })).toBeDisabled();
  });

  it('will not record consent until every mandatory purpose is granted', () => {
    renderConsent(() => undefined);
    fireEvent.change(screen.getByLabelText(/OTP reference/), { target: { value: 'OTP-77120' } });
    expect(screen.getByRole('button', { name: 'Record consent' })).toBeDisabled();
    fireEvent.click(screen.getAllByRole('checkbox')[0] as HTMLElement);
    expect(screen.getByRole('button', { name: 'Record consent' })).not.toBeDisabled();
  });

  it('records granted and declined purposes separately', () => {
    const onGrant = vi.fn<(artefact: ConsentArtefact) => void>();
    renderConsent(onGrant);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0] as HTMLElement);
    fireEvent.click(checkboxes[1] as HTMLElement);
    fireEvent.change(screen.getByLabelText(/OTP reference/), { target: { value: 'OTP-77120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record consent' }));

    const artefact = onGrant.mock.calls[0]?.[0];
    expect(artefact?.templateId).toBe('dpdp-registration');
    expect(artefact?.version).toBe('3.2');
    expect(artefact?.locale).toBe('en-IN');
    expect(artefact?.purposesGranted).toEqual(['care', 'insurance']);
    expect(artefact?.purposesDeclined).toEqual(['marketing']);
    expect(artefact?.attestation).toEqual({ kind: 'otp', reference: 'OTP-77120' });
    expect(artefact?.subject).toEqual({ kind: 'self' });
    expect(artefact?.noticeRead).toBe(true);
  });

  it('offers a keyboard-only attestation path alongside the signature pad', () => {
    renderConsent(() => undefined);
    const otp = screen.getByLabelText(/OTP reference/);
    otp.focus();
    expect(document.activeElement).toBe(otp);
    // The pointer-only pad is one of several methods, never the only one.
    expect(screen.getByRole('button', { name: /Signature/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Thumb impression/ })).toBeInTheDocument();
  });

  it('captures a guardian consent as a guardian consent', () => {
    const onGrant = vi.fn<(artefact: ConsentArtefact) => void>();
    renderConsent(onGrant);
    fireEvent.click(screen.getAllByRole('checkbox')[0] as HTMLElement);
    fireEvent.click(screen.getByRole('radio', { name: 'A parent or guardian' }));
    fireEvent.change(screen.getByLabelText(/OTP reference/), { target: { value: 'OTP-1' } });
    expect(screen.getByRole('button', { name: 'Record consent' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Guardian name/), { target: { value: 'Sita Sharma' } });
    fireEvent.change(screen.getByLabelText(/Relationship to the patient/), { target: { value: 'Mother' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record consent' }));
    expect(onGrant.mock.calls[0]?.[0].subject).toEqual({
      kind: 'guardian',
      name: 'Sita Sharma',
      relation: 'Mother',
    });
  });

  it('keeps withdrawal visible at all times', () => {
    renderConsent(() => undefined);
    expect(screen.getByRole('button', { name: 'Withdraw consent' })).toBeInTheDocument();
    expect(
      screen.getByText('You may withdraw at any time; care will not be refused.'),
    ).toBeInTheDocument();
  });

  it('exposes the notice as a focusable, labelled region', () => {
    const region = screen.queryByRole('region', { name: labels.noticeRegion });
    expect(region).toBeNull();
    renderConsent(() => undefined);
    const notice = screen.getByRole('region', { name: labels.noticeRegion });
    expect(notice).toHaveAttribute('tabindex', '0');
    expect(notice).toHaveAttribute('lang', 'en-IN');
  });

  it('has no axe violations', async () => {
    const { container } = renderConsent(() => undefined);
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});

describe('SignaturePad serialisation', () => {
  it('returns null until something is actually drawn', () => {
    expect(strokesToDataUrl([], 480, 160)).toBeNull();
    expect(strokesToDataUrl([[]], 480, 160)).toBeNull();
  });

  it('serialises strokes to a self-contained vector data URL', () => {
    const url = strokesToDataUrl(
      [
        [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
      ],
      480,
      160,
    );
    expect(url).not.toBeNull();
    expect(url?.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(decodeURIComponent(url ?? '')).toContain('<polyline points="10.0,20.0 30.0,40.0"');
  });

  it('captures a drawn signature and clears it again', () => {
    const { container } = render(
      <ConsentCapture
        notice={notice}
        purposes={purposes}
        labels={labels}
        methods={['drawn-signature']}
        onGrant={() => undefined}
      />,
    );
    const surface = container.querySelector<SVGSVGElement>('[data-signature-surface]');
    expect(surface).not.toBeNull();
    expect(surface).toHaveAttribute('data-has-signature', 'false');
    fireEvent.pointerDown(surface as SVGSVGElement, { clientX: 5, clientY: 5, pointerId: 1 });
    fireEvent.pointerMove(surface as SVGSVGElement, { clientX: 25, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(surface as SVGSVGElement, { pointerId: 1 });
    expect(surface).toHaveAttribute('data-has-signature', 'true');
    expect(screen.getByRole('button', { name: 'Clear signature' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear signature' }));
    expect(surface).toHaveAttribute('data-has-signature', 'false');
  });
});
