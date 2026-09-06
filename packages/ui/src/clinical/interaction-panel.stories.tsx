import { defineStories } from '../stories/story.js';
import { InteractionPanel, type InteractionItem } from './interaction-panel.js';

const labels = {
  heading: 'Drug interactions',
  severity: {
    contraindicated: 'Contraindicated',
    major: 'Major',
    moderate: 'Moderate',
    low: 'Minor',
    info: 'Information',
  },
  mechanism: 'Mechanism',
  management: 'Management',
  acknowledge: 'Acknowledge',
  acknowledged: 'Acknowledged — {reason}',
  ruleId: 'Rule',
  none: 'No interactions found between these 4 medicines.',
  degraded: 'Vendor knowledge base unavailable. This list is the local formulary only and may be incomplete.',
};

const warfarinCipro: InteractionItem = {
  id: 'ddi-1',
  severity: 'major',
  interruption: 'soft_stop',
  title: 'Warfarin + Ciprofloxacin',
  mechanism: 'CYP1A2 inhibition raises warfarin exposure.',
  management: 'Check INR within 3 days and reduce the warfarin dose if it rises.',
  ruleId: 'DDI-0412',
};

export const interactionPanelStories = defineStories({
  slug: 'interaction-panel',
  component: 'InteractionPanel',
  spec: '§5.2 #17',
  summary:
    'Every interaction the knowledge base found, most urgent first, each with its mechanism and what to do about it.',
  stories: [
    {
      id: 'mixed-severities',
      name: 'Four interactions, deliberately out of order',
      rationale:
        'The items are handed to the panel minor-first. It must render contraindicated at the top regardless, because a prescriber reads down and stops.',
      render: () => (
        <InteractionPanel
          labels={labels}
          onAcknowledge={() => undefined}
          items={[
            {
              id: 'ddi-4',
              severity: 'low',
              interruption: 'passive',
              title: 'Paracetamol + Metoclopramide',
              mechanism: 'Faster gastric emptying raises the rate of absorption.',
              management: 'No action needed.',
              ruleId: 'DDI-1180',
            },
            {
              id: 'ddi-3',
              severity: 'moderate',
              interruption: 'passive',
              title: 'Atorvastatin + Amlodipine',
              mechanism: 'CYP3A4 competition raises statin exposure.',
              management: 'Cap atorvastatin at 20 mg daily.',
              ruleId: 'DDI-0733',
            },
            warfarinCipro,
            {
              id: 'ddi-0',
              severity: 'contraindicated',
              interruption: 'hard_stop',
              title: 'Linezolid + Fluoxetine',
              mechanism: 'Additive serotonergic effect — risk of serotonin syndrome.',
              management: 'Do not co-prescribe. Allow a 5-week washout after fluoxetine.',
              ruleId: 'DDI-0007',
            },
          ]}
        />
      ),
    },
    {
      id: 'acknowledged',
      name: 'Acknowledged with a coded reason',
      rationale:
        'Once acknowledged the button is replaced by the reason, so the record of why somebody proceeded is on the row itself rather than only in the audit log.',
      render: () => (
        <InteractionPanel
          labels={labels}
          onAcknowledge={() => undefined}
          items={[{ ...warfarinCipro, acknowledgedReason: 'INR monitoring already arranged' }]}
        />
      ),
    },
    {
      id: 'none',
      name: 'No interactions',
      rationale:
        'States the number of medicines checked. "No interactions" alone does not say whether anything was looked at.',
      render: () => <InteractionPanel labels={labels} items={[]} />,
    },
    {
      id: 'degraded',
      name: 'Vendor knowledge base unavailable',
      degraded: true,
      rationale:
        'Degraded data, and the reason D-9 exists: a short list rendered as a clean result is worse than no list. "We could not look" and "we found nothing" are different sentences and this says which one it is.',
      render: () => <InteractionPanel labels={labels} degraded items={[warfarinCipro]} />,
    },
  ],
});
