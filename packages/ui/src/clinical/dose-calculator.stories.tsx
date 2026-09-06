import { defineStories } from '../stories/story.js';
import { DoseCalculator } from './dose-calculator.js';

const labels = {
  heading: 'Dose calculation',
  weightMissing: 'Weight not recorded',
  weightMissingAction: 'Record a weight in the vitals room before prescribing by milligram per kilogram.',
  weight: 'Weight',
  measuredAt: 'measured',
  dose: 'Dose',
  administration: 'Give',
  overCeiling: 'Above the maximum dose',
  ceiling: 'maximum',
  attempted: 'attempted',
  ofCeiling: 'of the maximum',
  nearCeiling: 'Above the usual maximum. Confirm the indication before prescribing.',
};

export const doseCalculatorStories = defineStories({
  slug: 'dose-calculator',
  component: 'DoseCalculator',
  spec: '§5.2 #18',
  summary: 'A weight-based dose with its arithmetic shown, so the result can be checked rather than trusted.',
  stories: [
    {
      id: 'paediatric',
      name: 'Paracetamol for a 12 kg child',
      rationale:
        'The worked example from the spec. Every step is visible, so a misplaced decimal point is caught by the person reading it rather than by the patient.',
      render: () => (
        <DoseCalculator
          labels={labels}
          weight={{ kind: 'recorded', kg: 12, measuredAt: '2 h ago' }}
          outcome={{
            kind: 'calculated',
            fractionOfCeiling: 0.75,
            dose: '180 mg',
            administration: '5 mL of 250 mg/5 mL',
            steps: [
              { expression: '12 kg × 15 mg/kg', result: '180 mg' },
              { expression: '180 mg ÷ 50 mg/mL', result: '3.6 mL', note: 'rounded to 5 mL spoon' },
            ],
          }}
        />
      ),
    },
    {
      id: 'near-ceiling',
      name: 'Between 100% and 200% of the ceiling',
      rationale:
        'Allowed, but not silently. The dose is still returned because there are legitimate indications above the usual maximum; the warning makes it a decision rather than an accident.',
      render: () => (
        <DoseCalculator
          labels={labels}
          weight={{ kind: 'recorded', kg: 12, measuredAt: '2 h ago' }}
          outcome={{
            kind: 'calculated',
            fractionOfCeiling: 1.4,
            dose: '336 mg',
            steps: [{ expression: '12 kg × 28 mg/kg', result: '336 mg' }],
          }}
        />
      ),
    },
    {
      id: 'over-ceiling',
      name: 'Ten times the intended dose',
      rationale:
        'The 10× error the spec asks to be blocked, which in practice is a decimal point. Above 200% there is no dose to submit at all — a warning here would just be something to click past.',
      render: () => (
        <DoseCalculator
          labels={labels}
          weight={{ kind: 'recorded', kg: 12, measuredAt: '2 h ago' }}
          outcome={{
            kind: 'over-ceiling',
            fractionOfCeiling: 7.5,
            attempted: '1,800 mg',
            ceiling: '240 mg',
            steps: [{ expression: '12 kg × 150 mg/kg', result: '1,800 mg' }],
          }}
        />
      ),
    },
    {
      id: 'weight-missing',
      name: 'No weight on the chart',
      degraded: true,
      rationale:
        'Degraded data, and the most consequential empty state in the product. There is no dose, because the alternative to blocking is an adult default applied to a child. The database refuses the same row.',
      render: () => <DoseCalculator labels={labels} weight={{ kind: 'not-recorded' }} />,
    },
  ],
});
