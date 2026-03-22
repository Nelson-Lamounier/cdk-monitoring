/**
 * @fileoverview Shared type definitions for the portfolio documentation MCP server.
 *
 * All types are evidence-centric: every skill claim, coverage assessment,
 * and generated document traces back to concrete file paths in the repository.
 *
 * @module types
 */

/** Demand level for a skill in the current DevOps/Cloud Engineering job market. */
export type DemandLevel = 'high' | 'medium-high' | 'medium' | 'low';

/** A single skill within the taxonomy. */
export interface Skill {
  /** Machine-readable identifier (e.g. 'aws-cdk', 'kubernetes-helm'). */
  readonly id: string;
  /** Human-readable display name (e.g. 'AWS CDK'). */
  readonly name: string;
  /** Current market demand level. */
  readonly demand: DemandLevel;
  /** File patterns that indicate this skill is present (glob format). */
  readonly detectionPatterns: readonly string[];
  /** Content patterns to search inside files (regex strings). */
  readonly contentPatterns?: readonly string[];
}

/** A category grouping related skills. */
export interface SkillCategory {
  /** Machine-readable identifier (e.g. 'infrastructure-as-code'). */
  readonly id: string;
  /** Human-readable display name (e.g. 'Infrastructure as Code'). */
  readonly name: string;
  /** Skills within this category. */
  readonly skills: readonly Skill[];
}

/** A skill detected in the repository, with evidence. */
export interface DetectedSkill {
  /** The skill identifier from the taxonomy. */
  readonly skillId: string;
  /** The skill display name. */
  readonly skillName: string;
  /** The category this skill belongs to. */
  readonly categoryId: string;
  /** Market demand level. */
  readonly demand: DemandLevel;
  /** File paths that prove this skill is used. */
  readonly evidence: readonly string[];
}

/** A file discovered during repo scanning. */
export interface ScannedFile {
  /** Relative path from repo root. */
  readonly relativePath: string;
  /** Absolute path on disk. */
  readonly absolutePath: string;
  /** File category (e.g. 'cdk-construct', 'helm-chart', 'ci-workflow'). */
  readonly category: FileCategory;
}

/** Categories for scanned files. */
export type FileCategory =
  | 'cdk-construct'
  | 'cdk-stack'
  | 'cdk-config'
  | 'helm-chart'
  | 'helm-values'
  | 'k8s-manifest'
  | 'argocd-app'
  | 'ci-workflow'
  | 'dockerfile'
  | 'typescript-source'
  | 'test-file'
  | 'documentation'
  | 'package-manifest'
  | 'terraform'
  | 'crossplane-xrd'
  | 'grafana-dashboard'
  | 'script'
  | 'other';

/** Coverage assessment for a single skill category. */
export interface CategoryCoverage {
  /** The category identifier. */
  readonly categoryId: string;
  /** The category display name. */
  readonly categoryName: string;
  /** Skills that are demonstrated in the repo. */
  readonly demonstrated: readonly DetectedSkill[];
  /** Skills from the taxonomy that are NOT demonstrated. */
  readonly notDemonstrated: readonly Skill[];
  /** Coverage percentage (0–100). */
  readonly coveragePercent: number;
}

/** Full coverage matrix across all categories. */
export interface CoverageMatrix {
  /** Per-category coverage assessments. */
  readonly categories: readonly CategoryCoverage[];
  /** Total skills demonstrated. */
  readonly totalDemonstrated: number;
  /** Total skills in taxonomy. */
  readonly totalInTaxonomy: number;
  /** Overall coverage percentage. */
  readonly overallCoveragePercent: number;
}

/** Scan result returned by the repo scanner. */
export interface ScanResult {
  /** All files discovered. */
  readonly files: readonly ScannedFile[];
  /** Total file count. */
  readonly totalFiles: number;
  /** Breakdown by category. */
  readonly categoryCounts: Record<FileCategory, number>;
}

/** A snippet of a source file used as evidence for a detected skill. */
export interface EvidenceSnippet {
  /** Relative path from repo root. */
  readonly relativePath: string;
  /** File category (e.g. 'cdk-stack', 'helm-chart'). */
  readonly category: FileCategory;
  /** First N lines of the file (truncated for payload size). */
  readonly contentPreview: string;
  /** Total line count of the full file. */
  readonly totalLines: number;
}

/** Rich evidence payload returned to the AI caller for polished doc generation. */
export interface EvidencePayload {
  /** Detected skills with evidence file paths. */
  readonly skills: readonly DetectedSkill[];
  /** Source file snippets for each evidence file (deduplicated). */
  readonly evidenceSnippets: readonly EvidenceSnippet[];
  /** Coverage matrix summary. */
  readonly coverage: CoverageMatrix;
  /** Scope metadata (if scoped scan). */
  readonly scope?: ScopeProfile;
}

/** Result of the full analyse-portfolio pipeline. */
export interface AnalysisResult {
  /** Detected skills with evidence. */
  readonly detectedSkills: readonly DetectedSkill[];
  /** Coverage matrix against market taxonomy. */
  readonly coverage: CoverageMatrix;
  /** Path to the generated markdown file. */
  readonly outputPath: string;
  /** Generated markdown content. */
  readonly markdownContent: string;
  /** Rich evidence payload for the AI caller. */
  readonly evidencePayload?: EvidencePayload;
}

/** Configuration for a scoped scan profile. */
export interface ScopeProfile {
  /** Scope identifier (e.g. 'crossplane', 'finops'). */
  readonly id: string;
  /** Human-readable scope name. */
  readonly name: string;
  /** Glob patterns to include in the scan. */
  readonly includePatterns: readonly string[];
  /** Skill category IDs to focus on. */
  readonly focusCategories: readonly string[];
}

/** A predefined ADR topic with evidence mapping. */
export interface AdrTopic {
  /** Decision identifier (e.g. 'self-managed-k8s-vs-eks'). */
  readonly id: string;
  /** Decision title. */
  readonly title: string;
  /** Brief context for the decision. */
  readonly context: string;
  /** File patterns that provide evidence for this decision. */
  readonly evidencePatterns: readonly string[];
}

/** A predefined runbook scenario. */
export interface RunbookScenario {
  /** Scenario identifier (e.g. 'instance-terminated'). */
  readonly id: string;
  /** Scenario title. */
  readonly title: string;
  /** What triggers this scenario. */
  readonly trigger: string;
  /** File patterns that show automatic response mechanisms. */
  readonly autoResponseEvidence: readonly string[];
  /** What to manually verify after automatic response. */
  readonly manualChecks: readonly string[];
  /** Where to check recovery status. */
  readonly recoveryEvidence: readonly string[];
}

/** Output target for generated documents. */
export type DocumentTarget = 'docs' | 'articles-draft';

/** Generated document metadata. */
export interface GeneratedDocument {
  /** Output file path. */
  readonly outputPath: string;
  /** Document content. */
  readonly content: string;
  /** Document type. */
  readonly documentType:
    | 'portfolio-overview'
    | 'feature-article'
    | 'adr'
    | 'runbook'
    | 'cost-breakdown'
    | 'chaos-evidence'
    | 'decision-analysis'
    | 'technical-doc'
    | 'code-quality-report';
  /** Source file contents used to generate this document (for AI caller). */
  readonly sourceEvidence?: ReadonlyArray<{
    readonly relativePath: string;
    readonly contentType: string;
    readonly content: string;
  }>;
}

// =============================================================================
// DECISION ANALYSIS TYPES
// =============================================================================

/** Supported decision analysis frameworks. */
export type DecisionFramework = 'weighted-matrix' | 'pros-cons' | 'risk-matrix';

/** A single criterion used to evaluate decision options. */
export interface DecisionCriterion {
  /** Criterion name (e.g. 'Operational Complexity'). */
  readonly name: string;
  /** Relative weight (0–1). All weights in a set should sum to 1. */
  readonly weight: number;
  /** Human-readable description of what this criterion measures. */
  readonly description: string;
}

/** Pros and cons for a decision option. */
export interface OptionProsAndCons {
  /** Advantages of choosing this option. */
  readonly pros: readonly string[];
  /** Disadvantages or trade-offs of choosing this option. */
  readonly cons: readonly string[];
}

/** A risk associated with a particular decision option. */
export interface RiskAssessment {
  /** Short risk description. */
  readonly risk: string;
  /** Probability of the risk materialising: 'low' | 'medium' | 'high'. */
  readonly probability: 'low' | 'medium' | 'high';
  /** Impact severity if the risk materialises: 'low' | 'medium' | 'high'. */
  readonly impact: 'low' | 'medium' | 'high';
  /** Recommended mitigation action. */
  readonly mitigation: string;
}

/** A single option under evaluation. */
export interface DecisionOption {
  /** Option identifier (e.g. 'self-managed-k8s'). */
  readonly id: string;
  /** Human-readable option name (e.g. 'Self-Managed Kubernetes'). */
  readonly name: string;
  /** Brief description of this option. */
  readonly description: string;
  /** Pros and cons for this option. */
  readonly prosAndCons: OptionProsAndCons;
  /** Scores per criterion (criterion name → 1–5). */
  readonly scores: Record<string, number>;
  /** Key risks specific to this option. */
  readonly risks: readonly RiskAssessment[];
  /** Short-term impact assessment (1–5). */
  readonly shortTermScore: number;
  /** Long-term impact assessment (1–5). */
  readonly longTermScore: number;
}

/** A predefined decision template with options, criteria, and evidence. */
export interface DecisionTemplate {
  /** Template identifier (e.g. 'hosting-platform'). */
  readonly id: string;
  /** Decision title. */
  readonly title: string;
  /** Context explaining why this decision matters. */
  readonly context: string;
  /** Pre-populated evaluation criteria with default weights. */
  readonly criteria: readonly DecisionCriterion[];
  /** Pre-populated options to evaluate. */
  readonly options: readonly DecisionOption[];
  /** File patterns that provide evidence for this decision. */
  readonly evidencePatterns: readonly string[];
}

/** Full decision analysis result. */
export interface DecisionAnalysis {
  /** The decision title. */
  readonly title: string;
  /** Context for the decision. */
  readonly context: string;
  /** Framework used for the analysis. */
  readonly framework: DecisionFramework;
  /** Criteria used to score options. */
  readonly criteria: readonly DecisionCriterion[];
  /** All options evaluated. */
  readonly options: readonly DecisionOption[];
  /** The recommended option ID. */
  readonly recommendedOptionId: string;
  /** Narrative reasoning for the recommendation. */
  readonly reasoning: string;
  /** Confidence level in the recommendation (0–100). */
  readonly confidence: number;
  /** Evidence file paths from the repository. */
  readonly evidenceFiles: readonly string[];
}

// =============================================================================
// TECHNICAL WRITER TYPES
// =============================================================================

/** Target audience for generated documentation. */
export type DocumentAudience = 'developer' | 'operator' | 'stakeholder' | 'end-user';

/** Output style/format for the generated document. */
export type DocumentStyle =
  | 'api-reference'
  | 'user-guide'
  | 'runbook-polished'
  | 'architecture-overview'
  | 'tutorial';

/** Audience-specific writing configuration. */
export interface WritingProfile {
  /** Audience identifier. */
  readonly id: DocumentAudience;
  /** Human-readable label. */
  readonly label: string;
  /** Tone description for the writer. */
  readonly tone: string;
  /** Detail level: high, medium, or low. */
  readonly detailLevel: 'high' | 'medium' | 'low';
  /** Whether full technical jargon is acceptable. */
  readonly jargonTolerance: 'full' | 'moderate' | 'minimal' | 'none';
  /** Ordered list of sections to include by default. */
  readonly defaultSections: readonly string[];
  /** Formatting guidelines specific to this audience. */
  readonly formattingRules: readonly string[];
}

/** A single source file read from the repository. */
export interface SourceFileContent {
  /** Relative path from repo root. */
  readonly relativePath: string;
  /** File content as a string. */
  readonly content: string;
  /** Detected content type. */
  readonly contentType: 'code' | 'markdown' | 'config' | 'notes';
}

/** Full configuration for a technical document generation request. */
export interface TechnicalDocConfig {
  /** Document title. */
  readonly title: string;
  /** Target audience profile. */
  readonly audience: DocumentAudience;
  /** Output style. */
  readonly style: DocumentStyle;
  /** Raw source file contents to transform. */
  readonly sources: readonly SourceFileContent[];
  /** Additional context or instructions from the caller. */
  readonly context?: string;
  /** Glossary of terms to define in the output. */
  readonly glossary?: Record<string, string>;
}

// =============================================================================
// CODE-QUALITY TYPES
// =============================================================================

/** Severity of a code-quality finding. */
export type FindingSeverity = 'error' | 'warning' | 'info';

/** A single code-quality finding detected in a source file. */
export interface CodeQualityFinding {
  /** Relative file path from repo root. */
  readonly file: string;
  /** Line number where the issue was found (1-indexed). */
  readonly line: number;
  /** Rule identifier (e.g. 'missing-jsdoc', 'any-usage'). */
  readonly rule: string;
  /** Human-readable description of the issue. */
  readonly message: string;
  /** Severity level. */
  readonly severity: FindingSeverity;
}

/** Aggregated code-quality report for a repository scan. */
export interface CodeQualityReport {
  /** Total TypeScript files scanned. */
  readonly totalFiles: number;
  /** Total findings across all files. */
  readonly totalFindings: number;
  /** Breakdown of finding count by rule identifier. */
  readonly findingsByRule: Record<string, number>;
  /** All individual findings. */
  readonly findings: readonly CodeQualityFinding[];
  /** Overall quality score (0–100, higher is better). */
  readonly score: number;
}
