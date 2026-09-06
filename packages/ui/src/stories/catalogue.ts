import { doseCalculatorStories } from '../clinical/dose-calculator.stories.js';
import { ewsBadgeStories } from '../clinical/ews-badge.stories.js';
import { interactionPanelStories } from '../clinical/interaction-panel.stories.js';
import { resultFlagStories } from '../clinical/result-flag.stories.js';
import { signatureSealStories } from '../clinical/signature-seal.stories.js';
import { taskListStories } from '../clinical/task-list.stories.js';
import { vitalsSparklineStories } from '../clinical/vitals-sparkline.stories.js';
import type { ComponentStories } from './story.js';

/**
 * Every component the design gallery knows about.
 *
 * Explicit imports rather than a glob: this file is the one place that decides
 * what ships into the gallery bundle, and a glob would quietly pull a story into
 * `apps/web` the moment somebody created one. It is also the list
 * `catalogue.spec.ts` checks against the components in `src/clinical`, so a new
 * component without a story fails a test rather than being noticed a year later.
 */
export const STORY_CATALOGUE: readonly ComponentStories[] = [
  doseCalculatorStories,
  ewsBadgeStories,
  interactionPanelStories,
  resultFlagStories,
  signatureSealStories,
  taskListStories,
  vitalsSparklineStories,
];

export function findComponentStories(slug: string): ComponentStories | undefined {
  return STORY_CATALOGUE.find((entry) => entry.slug === slug);
}

export * from './story.js';
