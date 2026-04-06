/**
 * @format
 * Resume Service — Pure Formatting Utility
 *
 * Converts structured resume data (from DynamoDB) into LLM-friendly
 * prompt text. No DynamoDB access — this module is a pure transformer.
 *
 * The Trigger Lambda fetches the resume from DynamoDB; this module
 * formats it for consumption by the Research and Strategist agents.
 */

import type {
    StructuredResumeData,
    ResumeSkillCategory,
} from '../../../shared/src/strategist-types.js';

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Formats structured resume data into a sectioned text block suitable
 * for embedding in an LLM system/user prompt.
 *
 * Each resume section is clearly delimited with headers so the model
 * can identify and reference individual sections during analysis.
 *
 * @param resume - The structured resume data from DynamoDB
 * @returns Formatted plain-text resume with section headers
 */
export function formatResumeForPrompt(resume: StructuredResumeData): string {
    const sections: string[] = [];

    // ── Profile ──────────────────────────────────────────────────────────
    const { profile } = resume;
    sections.push(
        `=== PROFILE ===`,
        `Name: ${profile.name}`,
        `Title: ${profile.title}`,
        `Location: ${profile.location}`,
        `Email: ${profile.email}`,
        ...(profile.linkedin ? [`LinkedIn: ${profile.linkedin}`] : []),
        ...(profile.github ? [`GitHub: ${profile.github}`] : []),
        ...(profile.website ? [`Website: ${profile.website}`] : []),
    );

    // ── Summary ──────────────────────────────────────────────────────────
    if (resume.summary) {
        sections.push('', `=== PROFESSIONAL SUMMARY ===`, resume.summary);
    }

    // ── Experience ───────────────────────────────────────────────────────
    if (resume.experience.length > 0) {
        sections.push('', `=== PROFESSIONAL EXPERIENCE ===`);
        for (const exp of resume.experience) {
            sections.push(
                '',
                `--- ${exp.title} at ${exp.company} (${exp.period}) ---`,
            );
            for (const highlight of exp.highlights) {
                sections.push(`  • ${highlight}`);
            }
        }
    }

    // ── Skills ───────────────────────────────────────────────────────────
    if (resume.skills.length > 0) {
        sections.push('', `=== SKILLS ===`);
        for (const cat of resume.skills) {
            sections.push(`${cat.category}: ${cat.skills.join(', ')}`);
        }
    }

    // ── Education ────────────────────────────────────────────────────────
    if (resume.education.length > 0) {
        sections.push('', `=== EDUCATION ===`);
        for (const edu of resume.education) {
            sections.push(`${edu.degree} — ${edu.institution} (${edu.period})`);
        }
    }

    // ── Certifications ───────────────────────────────────────────────────
    if (resume.certifications.length > 0) {
        sections.push('', `=== CERTIFICATIONS ===`);
        for (const cert of resume.certifications) {
            sections.push(`${cert.name} — ${cert.issuer} (${cert.year})`);
        }
    }

    // ── Projects ─────────────────────────────────────────────────────────
    if (resume.projects.length > 0) {
        sections.push('', `=== PROJECTS ===`);
        for (const proj of resume.projects) {
            const githubSuffix = proj.github ? ` [${proj.github}]` : '';
            sections.push(`${proj.name}: ${proj.description}${githubSuffix}`);
        }
    }

    // ── Key Achievements ─────────────────────────────────────────────────
    if (resume.keyAchievements.length > 0) {
        sections.push('', `=== KEY ACHIEVEMENTS ===`);
        for (const ach of resume.keyAchievements) {
            sections.push(`  • ${ach.achievement}`);
        }
    }

    return sections.join('\n');
}

/**
 * Flattens all skill categories into a single deduplicated array.
 *
 * Useful for the Research Agent's gap analysis — comparing the flat
 * skill list against job description requirements.
 *
 * @param categories - Skill categories from the resume
 * @returns Deduplicated, lowercased skill strings
 */
export function flattenResumeSkills(categories: ResumeSkillCategory[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const cat of categories) {
        for (const skill of cat.skills) {
            const normalised = skill.toLowerCase().trim();
            if (!seen.has(normalised)) {
                seen.add(normalised);
                result.push(skill.trim());
            }
        }
    }

    return result;
}
