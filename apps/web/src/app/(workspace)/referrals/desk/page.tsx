import type { Metadata } from 'next';
import { ReferralDesk } from '@/features/specialty/handoffs/components/referral-desk';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';

export const metadata: Metadata = { title: "Referrals · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="referral-desk">
      <ReferralDesk />
    </SpecialtyGate>
  );
}
