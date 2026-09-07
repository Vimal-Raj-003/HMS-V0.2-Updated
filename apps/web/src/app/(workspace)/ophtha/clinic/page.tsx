import type { Metadata } from 'next';
import { EyeClinicScreen } from '@/features/specialty/ophthalmology/components/eye-clinic-screen';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';

export const metadata: Metadata = { title: "Eye clinic · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="eye-clinic">
      <EyeClinicScreen />
    </SpecialtyGate>
  );
}
