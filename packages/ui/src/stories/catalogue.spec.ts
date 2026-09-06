import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STORY_CATALOGUE } from './catalogue.js';

const CLINICAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'clinical');

/**
 * `docs/06` §5.2: "Every clinical component ships with: Storybook story (light +
 * dark + high-contrast + 200 % zoom + RTL), `axe` test, keyboard-only test, and
 * a 'degraded data' story."
 *
 * The variants, the axe scan and the keyboard pass are the gallery's and
 * `design-system.spec.ts`'s job. What is left — that a story exists at all, and
 * that it includes the degraded case — can only be checked here, against the
 * directory listing. Without this the requirement decays silently: a component
 * lands, nobody writes a story, and the gallery still looks complete because it
 * only shows what it was given.
 */

/** Components whose story is still to be written, with the reason. */
const AWAITING_STORIES = new Set<string>([
  'address-form',
  'allergy-editor',
  'appointment-slot-picker',
  'approval-timeline',
  'audit-diff-viewer',
  'barcode-scan-input',
  'confirm-with-reason-dialog',
  'consent-capture',
  'critical-alert-toast',
  'denomination-sheet',
  'empty-state',
  'error-boundary-card',
  'keyboard-hint-bar',
  'money-input',
  'offline-badge',
  'patient-banner',
  'patient-search-combobox',
  'photo-capture',
  'print-preview',
  'queue-list',
  'signature-pad',
  'skeleton-list',
  'token-display',
  'worklist-table',
]);

function clinicalComponentSlugs(): readonly string[] {
  return readdirSync(CLINICAL_DIR)
    .filter((f) => f.endsWith('.tsx') && !f.endsWith('.spec.tsx') && !f.endsWith('.stories.tsx'))
    .map((f) => f.replace(/\.tsx$/, ''))
    .sort();
}

describe('the design-gallery catalogue — docs/06 §5.2', () => {
  it('lists a story for every clinical component, or records it as outstanding', () => {
    const covered = new Set(STORY_CATALOGUE.map((c) => c.slug));
    const uncovered = clinicalComponentSlugs().filter(
      (slug) => !covered.has(slug) && !AWAITING_STORIES.has(slug),
    );

    expect(
      uncovered,
      `These clinical components have no story and are not listed in AWAITING_STORIES. ` +
        `Add a <slug>.stories.tsx and register it in catalogue.ts, or add the slug to ` +
        `AWAITING_STORIES with a reason.`,
    ).toEqual([]);
  });

  it('never leaves a stale entry in the outstanding list', () => {
    // The list has to shrink. Without this, a slug stays on it after the story
    // is written and the exemption outlives the reason for it.
    const covered = new Set(STORY_CATALOGUE.map((c) => c.slug));
    const stale = [...AWAITING_STORIES].filter((slug) => covered.has(slug));
    expect(stale, 'These have stories now and must be removed from AWAITING_STORIES.').toEqual([]);
  });

  it('only lists components that exist', () => {
    const onDisk = new Set(clinicalComponentSlugs());
    const missing = [...STORY_CATALOGUE.map((c) => c.slug), ...AWAITING_STORIES].filter(
      (slug) => !onDisk.has(slug),
    );
    expect(missing, 'Named in the catalogue or the outstanding list but not on disk.').toEqual([]);
  });

  it('gives every catalogued component at least one degraded-data story', () => {
    // The story that gets skipped, and the one that matters at 3 a.m. §5.2
    // names it explicitly, so it is checked explicitly.
    const withoutDegraded = STORY_CATALOGUE.filter((c) => !c.stories.some((s) => s.degraded === true)).map(
      (c) => c.slug,
    );
    expect(withoutDegraded).toEqual([]);
  });

  it('gives every story a stable id and a written rationale', () => {
    for (const component of STORY_CATALOGUE) {
      const ids = component.stories.map((s) => s.id);
      expect(new Set(ids).size, `${component.slug} has duplicate story ids`).toBe(ids.length);
      for (const story of component.stories) {
        expect(story.id, `${component.slug}/${story.id} is not URL-safe`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        // A story whose reason cannot be written down is usually a duplicate of
        // the one above it.
        expect(
          story.rationale.length,
          `${component.slug}/${story.id} needs a real rationale`,
        ).toBeGreaterThan(30);
      }
    }
  });

  it('keeps slugs unique and URL-safe', () => {
    const slugs = STORY_CATALOGUE.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});
