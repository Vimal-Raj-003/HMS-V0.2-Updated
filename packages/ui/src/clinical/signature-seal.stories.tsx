import { defineStories } from '../stories/story.js';
import { SignatureSeal, type Signer } from './signature-seal.js';

const labels = {
  draft: 'Draft',
  final: 'Final v{n}',
  amended: 'Amended v{n}',
  cancelled: 'Cancelled',
  signedBy: 'Signed by',
  registrationNo: 'KMC',
  method: 'Method',
  hash: 'Hash',
  reason: 'Reason',
  verify: 'Verify this signature',
  draftWarning: 'Not signed. Do not act on this document.',
};

const signer: Signer = {
  name: 'Dr Ananya Krishnan',
  registrationNo: '58214',
  method: 'password + OTP',
  signedAt: '2 Sep 2026, 14:02 IST',
};

export const signatureSealStories = defineStories({
  slug: 'signature-seal',
  component: 'SignatureSeal',
  spec: '§5.2 #40',
  summary: 'Whether a document can be acted on, and who put their registration number behind it.',
  stories: [
    {
      id: 'final',
      name: 'Final, version 1',
      rationale:
        'The signed state. The hash is a real fingerprint of the sealed bytes, so it is shown in full rather than as decoration.',
      render: () => (
        <SignatureSeal
          labels={labels}
          onVerify={() => undefined}
          seal={{ kind: 'final', version: 1, signer, hash: '9f2c4a1b7e05d3886a41c0fe2b9d7743' }}
        />
      ),
    },
    {
      id: 'amended',
      name: 'Amended, version 2',
      rationale:
        'An amendment carries its reason. A clinician who read version 1 needs to know both that it changed and why, or the amendment is invisible to the person it matters to.',
      render: () => (
        <SignatureSeal
          labels={labels}
          onVerify={() => undefined}
          seal={{
            kind: 'amended',
            version: 2,
            signer,
            hash: 'c1d8e6f409b27a53e0148db6f7c29a10',
            reason: 'Laterality corrected — the procedure was on the left knee.',
          }}
        />
      ),
    },
    {
      id: 'cancelled',
      name: 'Cancelled',
      rationale:
        'Cancelled documents stay visible because they were acted on. Deleting one loses the record that it existed.',
      render: () => (
        <SignatureSeal
          labels={labels}
          seal={{
            kind: 'cancelled',
            version: 3,
            signer,
            reason: 'Recorded against the wrong patient; re-entered under UHID BLR-Main00000117.',
          }}
        />
      ),
    },
    {
      id: 'draft',
      name: 'Draft — not signed',
      degraded: true,
      rationale:
        'Degraded data. There is no signer and the union makes that unrepresentable any other way. It states the instruction rather than the label, because "Draft" alone is something people read past.',
      render: () => <SignatureSeal labels={labels} seal={{ kind: 'draft' }} />,
    },
  ],
});
