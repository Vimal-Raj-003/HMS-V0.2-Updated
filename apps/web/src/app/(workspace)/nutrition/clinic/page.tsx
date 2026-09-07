import type { Metadata } from 'next';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';
import { NutritionScreen } from '@/features/specialty/therapy/components/nutrition-screen';

export const metadata: Metadata = { title: "Dietetics & nutrition · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="nutrition">
      <NutritionScreen />
    </SpecialtyGate>
  );
}
