import { defineStories } from '../stories/story.js';
import { ResultFlag } from './result-flag.js';

const potassiumRange = 'reference 3.5 – 5.1 mmol/L';

export const resultFlagStories = defineStories({
  slug: 'result-flag',
  component: 'ResultFlag',
  spec: '§5.2 #6',
  summary:
    'One laboratory result and how far outside the reference interval it sits. Glyph, letter and colour, never colour alone.',
  stories: [
    {
      id: 'normal',
      name: 'Within the reference interval',
      rationale:
        'The overwhelmingly common case, and the one that must stay quiet. A normal result that draws the eye trains people to ignore the ones that should.',
      render: () => (
        <ResultFlag
          value="4.2"
          unit="mmol/L"
          flag="normal"
          labels={{ flag: 'normal', referenceRange: potassiumRange }}
        />
      ),
    },
    {
      id: 'high',
      name: 'High',
      rationale: 'Abnormal but not panic-range: a letter and an upward glyph, no rule, no bold.',
      render: () => (
        <ResultFlag
          value="5.6"
          unit="mmol/L"
          flag="high"
          labels={{ flag: 'high', referenceRange: potassiumRange }}
        />
      ),
    },
    {
      id: 'low',
      name: 'Low',
      rationale:
        'Paired with High so a reviewer can check the two are told apart by the glyph direction and not only by hue — they are amber and blue, which protanopia flattens.',
      render: () => (
        <ResultFlag
          value="3.1"
          unit="mmol/L"
          flag="low"
          labels={{ flag: 'low', referenceRange: potassiumRange }}
        />
      ),
    },
    {
      id: 'critical-high',
      name: 'Critically high, announced',
      rationale:
        'A potassium of 7.2 is the result this whole component exists for. Doubled glyph, doubled letter, a left rule, bold weight, and the only story that takes an assertive live region.',
      render: () => (
        <ResultFlag
          value="7.2"
          unit="mmol/L"
          flag="critical_high"
          announce
          labels={{
            flag: 'critically high — panic range',
            referenceRange: potassiumRange,
            delta: 'up 3.0 since 06:15',
          }}
        />
      ),
    },
    {
      id: 'critical-low',
      name: 'Critically low',
      rationale:
        'The mirror of the above, in violet rather than red. §3.5 splits the two critical directions across hues deliberately so a glance distinguishes them.',
      render: () => (
        <ResultFlag
          value="2.4"
          unit="mmol/L"
          flag="critical_low"
          labels={{ flag: 'critically low — panic range', referenceRange: potassiumRange }}
        />
      ),
    },
    {
      id: 'corrected',
      name: 'Corrected result',
      rationale:
        'The superseded value stays visible and struck through. A correction that silently replaces the number leaves a clinician who acted on the first one with no way to know.',
      render: () => (
        <ResultFlag
          value="4.4"
          unit="mmol/L"
          flag="normal"
          previousValue="8.1"
          labels={{
            flag: 'normal',
            referenceRange: potassiumRange,
            corrected: 'corrected at 09:40 — previously 8.1, haemolysed sample',
          }}
        />
      ),
    },
    {
      id: 'qualitative',
      name: 'Qualitative — reactive',
      rationale:
        'Not every result is a number. A reactive serology has no reference interval and no arrow, so it takes the abnormal diamond and its own letters.',
      render: () => <ResultFlag value="Reactive" flag="reactive" labels={{ flag: 'reactive' }} />,
    },
    {
      id: 'pending',
      name: 'Pending',
      degraded: true,
      rationale:
        'Degraded data. The analyser has not reported. This must never render as a blank cell, which reads as "nothing to see", nor as normal.',
      render: () => <ResultFlag value="—" flag="pending" labels={{ flag: 'not yet resulted' }} />,
    },
    {
      id: 'indeterminate',
      name: 'Indeterminate',
      degraded: true,
      rationale:
        'Degraded data, and the one people get wrong: the test ran and could not decide. It is not pending and it is certainly not negative.',
      render: () => (
        <ResultFlag
          value="Indeterminate"
          flag="indeterminate"
          labels={{ flag: 'indeterminate — repeat on a fresh sample' }}
        />
      ),
    },
  ],
});
