/**
 * @fileoverview Tool handler for `list-skills`.
 *
 * Returns the current skills taxonomy, optionally filtered by category.
 *
 * @module tools/list-skills
 */

import { SKILLS_TAXONOMY } from '../data/skills-taxonomy.js';
import { SCOPE_PROFILES } from '../data/scope-profiles.js';
import { ADR_TOPICS } from '../data/adr-topics.js';
import { RUNBOOK_SCENARIOS } from '../data/runbook-scenarios.js';

/**
 * Returns the skills taxonomy and available scopes/templates.
 *
 * @param categoryFilter - Optional category ID to filter.
 * @returns Structured taxonomy data.
 */
export function handleListSkills(categoryFilter?: string): {
  readonly categories: ReadonlyArray<{
    id: string;
    name: string;
    skillCount: number;
    skills: ReadonlyArray<{
      id: string;
      name: string;
      demand: string;
    }>;
  }>;
  readonly scopes: ReadonlyArray<{ id: string; name: string }>;
  readonly adrTopics: ReadonlyArray<{ id: string; title: string }>;
  readonly runbookScenarios: ReadonlyArray<{ id: string; title: string }>;
  readonly totalSkills: number;
} {
  const filteredCategories = categoryFilter
    ? SKILLS_TAXONOMY.filter((cat) => cat.id === categoryFilter)
    : SKILLS_TAXONOMY;

  if (categoryFilter && filteredCategories.length === 0) {
    const validIds = SKILLS_TAXONOMY.map((c) => c.id).join(', ');
    throw new Error(`Unknown category "${categoryFilter}". Valid categories: ${validIds}`);
  }

  return {
    categories: filteredCategories.map((cat) => ({
      id: cat.id,
      name: cat.name,
      skillCount: cat.skills.length,
      skills: cat.skills.map((s) => ({
        id: s.id,
        name: s.name,
        demand: s.demand,
      })),
    })),
    scopes: SCOPE_PROFILES.map((s) => ({ id: s.id, name: s.name })),
    adrTopics: ADR_TOPICS.map((a) => ({ id: a.id, title: a.title })),
    runbookScenarios: RUNBOOK_SCENARIOS.map((r) => ({ id: r.id, title: r.title })),
    totalSkills: filteredCategories.reduce((sum, cat) => sum + cat.skills.length, 0),
  };
}
