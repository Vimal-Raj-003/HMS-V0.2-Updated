import { defineStories } from '../stories/story.js';
import { EwsBadge } from './ews-badge.js';

export const ewsBadgeStories = defineStories({
  slug: 'ews-badge',
  component: 'EwsBadge',
  spec: '§5.2 #5',
  summary:
    'An early-warning score and the escalation it obliges. The score is never shown without the action.',
  stories: [
    {
      id: 'low',
      name: 'NEWS2 1 — low',
      rationale:
        'The routine case. Even at low risk the badge states the observation frequency, because "low" is a decision about how often to come back, not an absence of one.',
      render: () => (
        <EwsBadge
          type="news2"
          score={{ kind: 'scored', total: 1, band: 'low' }}
          labels={{
            scoreName: 'NEWS2',
            band: 'low risk',
            requiredAction: 'Continue routine observations, 12-hourly.',
          }}
        />
      ),
    },
    {
      id: 'medium',
      name: 'NEWS2 6 — medium',
      rationale:
        'The band where the action text earns its place: 6 obliges an urgent review by a clinician competent in acute illness, and nobody remembers that from the number.',
      render: () => (
        <EwsBadge
          type="news2"
          score={{ kind: 'scored', total: 6, band: 'medium' }}
          labels={{
            scoreName: 'NEWS2',
            band: 'medium risk',
            requiredAction: 'Urgent review by a clinician competent in acute illness. Observations hourly.',
          }}
          onShowBreakdown={() => undefined}
        />
      ),
    },
    {
      id: 'high',
      name: 'NEWS2 9 — high',
      rationale:
        'Emergency response. Rendered with the breakdown control attached, because the first question anyone asks of a 9 is which component drove it.',
      render: () => (
        <EwsBadge
          type="news2"
          score={{ kind: 'scored', total: 9, band: 'high' }}
          labels={{
            scoreName: 'NEWS2',
            band: 'high risk',
            requiredAction:
              'Emergency assessment by a critical-care team. Continuous monitoring. Consider transfer to a higher level of care.',
            breakdown: 'Show score breakdown',
          }}
          onShowBreakdown={() => undefined}
        />
      ),
    },
    {
      id: 'scale-2',
      name: 'NEWS2 5 — Scale 2 (COPD)',
      rationale:
        'Scale 2 changes how oxygen saturation scores for hypercapnic respiratory failure. A Scale 2 score read as Scale 1 under-escalates, so the marker sits beside the name and is never abbreviated away.',
      render: () => (
        <EwsBadge
          type="news2"
          score={{ kind: 'scored', total: 5, band: 'medium' }}
          labels={{
            scoreName: 'NEWS2',
            band: 'medium risk',
            scaleMarker: 'Scale 2',
            requiredAction: 'Urgent review. Target saturations 88–92%.',
          }}
        />
      ),
    },
    {
      id: 'incomplete',
      name: 'Not scored — observations missing',
      degraded: true,
      rationale:
        'The degraded story, and the reason the score is a union. Two of the seven components were not recorded, so there is no NEWS2. It renders neutral and names what is missing; a 0 in a green badge here would be the dangerous failure PROGRESS records for Phase 2.',
      render: () => (
        <EwsBadge
          type="news2"
          score={{ kind: 'incomplete', missing: ['respiratory rate', 'consciousness'] }}
          labels={{
            scoreName: 'NEWS2',
            band: 'not scored',
            requiredAction: 'Record the missing observations to score.',
            incomplete: 'Not scored — respiratory rate and consciousness are not recorded.',
          }}
        />
      ),
    },
    {
      id: 'paediatric',
      name: 'PEWS 4',
      rationale:
        'A second scale on the same component, to check that nothing about NEWS2 leaked into the layout — different name, different bands, same contract.',
      render: () => (
        <EwsBadge
          type="pews"
          score={{ kind: 'scored', total: 4, band: 'low-medium' }}
          labels={{
            scoreName: 'PEWS',
            band: 'low to medium risk',
            requiredAction: 'Inform the nurse in charge. Repeat observations in 1 hour.',
          }}
        />
      ),
    },
  ],
});
