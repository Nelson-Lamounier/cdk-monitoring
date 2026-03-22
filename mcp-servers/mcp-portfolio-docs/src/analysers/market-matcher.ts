/**
 * @fileoverview Market matcher — cross-references detected skills against the taxonomy.
 *
 * Produces a coverage matrix showing which skills are demonstrated,
 * which are missing, and the coverage percentage per category.
 *
 * @module analysers/market-matcher
 */

import type {
  CategoryCoverage,
  CoverageMatrix,
  DetectedSkill,
  SkillCategory,
} from '../types/index.js';
import { SKILLS_TAXONOMY } from '../data/skills-taxonomy.js';

/**
 * Calculates coverage for a single skill category.
 *
 * @param category - The taxonomy category.
 * @param detectedSkills - All detected skills from the repo scan.
 * @returns Coverage assessment for this category.
 */
function calculateCategoryCoverage(
  category: SkillCategory,
  detectedSkills: readonly DetectedSkill[],
): CategoryCoverage {
  const detectedInCategory = detectedSkills.filter(
    (ds) => ds.categoryId === category.id,
  );

  const detectedIds = new Set(detectedInCategory.map((ds) => ds.skillId));

  const notDemonstrated = category.skills.filter(
    (skill) => !detectedIds.has(skill.id),
  );

  const totalSkills = category.skills.length;
  const coveragePercent =
    totalSkills > 0
      ? Math.round((detectedInCategory.length / totalSkills) * 100)
      : 0;

  return {
    categoryId: category.id,
    categoryName: category.name,
    demonstrated: detectedInCategory,
    notDemonstrated,
    coveragePercent,
  };
}

/**
 * Generates a full coverage matrix by matching detected skills against the taxonomy.
 *
 * @param detectedSkills - Skills discovered in the repo with evidence.
 * @param taxonomyFilter - Optional category filter (for scoped analysis).
 * @returns Full coverage matrix with per-category breakdowns.
 */
export function matchAgainstMarket(
  detectedSkills: readonly DetectedSkill[],
  taxonomyFilter?: readonly string[],
): CoverageMatrix {
  const categories = taxonomyFilter
    ? SKILLS_TAXONOMY.filter((cat) => taxonomyFilter.includes(cat.id))
    : SKILLS_TAXONOMY;

  const categoryResults = categories.map((category) =>
    calculateCategoryCoverage(category, detectedSkills),
  );

  const totalDemonstrated = categoryResults.reduce(
    (sum, cat) => sum + cat.demonstrated.length,
    0,
  );

  const totalInTaxonomy = categories.reduce(
    (sum, cat) => sum + cat.skills.length,
    0,
  );

  const overallCoveragePercent =
    totalInTaxonomy > 0
      ? Math.round((totalDemonstrated / totalInTaxonomy) * 100)
      : 0;

  return {
    categories: categoryResults,
    totalDemonstrated,
    totalInTaxonomy,
    overallCoveragePercent,
  };
}
