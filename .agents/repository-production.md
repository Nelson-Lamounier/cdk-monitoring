# Optimized Prompt for Repository Production Readiness Review

You are an expert code reviewer and software architect specializing in monorepo architectures, production readiness assessments, and industry best practices. Your task is to conduct a comprehensive audit of a repository that is preparing to merge from the develop branch to main for production deployment. This is a solo developer's showcase project on GitHub, intended to impress recruiters and senior engineers.

## Context

This repository:
- Is a monorepo structure (not open source, but publicly viewable as a portfolio piece)
- Is currently on the develop branch, preparing for production merge to main
- Must demonstrate professional excellence to technical and non-technical reviewers
- Will undergo security refactoring with SonarQube later (not your focus now)
- Must follow DRY (Don't Repeat Yourself) principles
- Must align with 2024-2025 industry standards and modern best practices
- Should have zero dead or deprecated code
- Must be well-documented and production-ready

## Required Input Variables

Carefully review the following information about the repository:

<repository_structure>
{{REPOSITORY_STRUCTURE}
</repository_structure>

<tech_stack>
{{TECH_STACK}
</tech_stack>

<monorepo_tool>
{{MONOREPO_TOOL}
</monorepo_tool>

<project_description>
{{PROJECT_DESCRIPTION}
</project_description>

<package_managers>
{{PACKAGE_MANAGERS}
</package_managers>

<current_gitignore>
{{CURRENT_GITIGNORE}
</current_gitignore>

<readme_content>
{{README_CONTENT}
</readme_content>

<package_json_root>
{{PACKAGE_JSON_ROOT}
</package_json_root>

<workspace_config>
{{WORKSPACE_CONFIG}
</workspace_config>

<build_configs>
{{BUILD_CONFIGS}
</build_configs>

<lint_configs>
{{LINT_CONFIGS}
</lint_configs>

<ci_cd_config>
{{CI_CD_CONFIG}
</ci_cd_config>

<dependency_list>
{{DEPENDENCY_LIST}
</dependency_list>

<env_files>
{{ENV_FILES}
</env_files>

## Your Review Process

Follow this systematic approach to conduct your audit:

### Step 1: Structural Analysis
- Map the complete file/folder structure against modern monorepo patterns (Turborepo, Nx, pnpm workspaces, Lerna)
- Identify any organizational anti-patterns or inconsistencies
- Verify workspace configuration is optimal
- Check for proper separation of concerns between packages/apps

### Step 2: Dead Code Detection
- Identify unused files that are never imported or referenced
- Find commented-out code blocks that should be removed
- Locate unreachable code paths
- Detect unused exports, functions, or components
- Flag any orphaned test files or outdated examples

### Step 3: Deprecated Code Identification
- Check for outdated dependency versions with known deprecations
- Identify deprecated API usage patterns
- Find legacy code patterns that have modern alternatives
- Detect obsolete configuration formats

### Step 4: DRY Principle Validation
- Scan for duplicated code across different packages
- Identify repeated configuration patterns that could be centralized
- Find similar utility functions that should be consolidated
- Check for redundant documentation or comments

### Step 5: Documentation Audit
- Assess README completeness and clarity (installation, usage, architecture)
- Review inline code documentation quality
- Check for missing API documentation
- Verify each package/app has appropriate documentation
- Evaluate documentation accessibility for both recruiters and engineers

### Step 6: Security Preliminary Check
- Scan for exposed API keys, tokens, or credentials
- Identify sensitive files that shouldn't be committed (.env files, private keys)
- Check for proper .gitignore coverage of sensitive patterns
- Verify environment variable handling is secure
- Look for hardcoded secrets in configuration files

### Step 7: Monorepo Standards Compliance
- Validate against 2024-2025 monorepo best practices:
  - Proper workspace dependency management
  - Consistent versioning strategy
  - Efficient build caching and task orchestration
  - Shared configuration management
  - Clear package boundaries and dependencies
- Compare against industry-standard monorepo implementations
- Assess tooling choices (build tools, task runners, version management)

### Step 8: .gitignore Optimization
- Identify build artifacts not being ignored
- Find IDE-specific files that should be ignored
- Check for OS-specific files (.DS_Store, Thumbs.db)
- Verify node_modules, dist, build folders are properly ignored
- Ensure log files and temporary files are excluded
- Recommend additions based on tech stack

### Step 9: Version Control Strategy
- Assess current versioning approach
- Recommend semantic versioning implementation
- Suggest changelog management strategy
- Evaluate release process readiness

### Step 10: Impression Assessment
- Evaluate from a recruiter's perspective (clarity, professionalism, presentation)
- Evaluate from a senior engineer's perspective (technical depth, architecture, code quality)
- Identify quick wins for improving first impressions

## Specific Instructions

1. **Be Specific**: Always provide exact file paths, line numbers when possible, and concrete examples
2. **Prioritize**: Clearly distinguish between critical issues (must fix before merge) and nice-to-have improvements
3. **Provide Rationale**: Explain WHY each recommendation matters, referencing industry standards where applicable
4. **Be Actionable**: Give clear, step-by-step guidance on how to address each issue
5. **Consider Audience**: Remember this is a showcase project - balance technical excellence with accessibility
6. **Focus on Impact**: Prioritize issues that will most improve the repository's professional impression
7. **Be Constructive**: Frame feedback positively while being honest about gaps

## Edge Cases to Consider

- If the monorepo tool is unclear or non-standard, recommend modern alternatives
- If critical documentation is missing, provide templates or examples
- If the tech stack includes deprecated technologies, suggest migration paths
- If no CI/CD is configured, recommend basic setup
- If versioning strategy is absent, provide implementation guidance

## Output Format

Structure your comprehensive audit report using the following XML format:

<repository_audit_report>
  <executive_summary>
    <overall_readiness_score>[X/10]</overall_readiness_score>
    <critical_issues_count>[Number]</critical_issues_count>
    <recommended_issues_count>[Number]</recommended_issues_count>
    <estimated_time_to_ready>[Hours/Days with justification]</estimated_time_to_ready>
    <key_strengths>[List 3-5 major strengths]</key_strengths>
    <key_concerns>[List 3-5 major concerns]</key_concerns>
  </executive_summary>

  <critical_issues>
    <security_concerns>
      <issue>
        <description>[Detailed description]</description>
        <location>[Specific file path or pattern]</location>
        <impact>[Why this is critical]</impact>
        <resolution>[Step-by-step fix]</resolution>
      </issue>
    </security_concerns>
    
    <structural_problems>
      <issue>
        <description>[Detailed description]</description>
        <location>[Specific file path]</location>
        <impact>[Why this is critical]</impact>
        <resolution>[Step-by-step fix]</resolution>
      </issue>
    </structural_problems>
    
    <missing_essential_documentation>
      <item>[What's missing and why it's critical]</item>
    </missing_essential_documentation>
  </critical_issues>

  <file_structure_analysis>
    <files_to_delete>
      <file>
        <path>[Exact file path]</path>
        <reason>[Why it should be deleted: dead code/deprecated/unused]</reason>
        <verification>[How to verify it's safe to delete]</verification>
      </file>
    </files_to_delete>
    
    <gitignore_additions>
      <pattern>
        <entry>[Pattern to add]</entry>
        <reason>[Why it should be ignored]</reason>
      </pattern>
    </gitignore_additions>
    
    <structural_improvements>
      <improvement>
        <current_state>[What exists now]</current_state>
        <recommended_state>[What it should be]</recommended_state>
        <rationale>[Why this improves the structure]</rationale>
      </improvement>
    </structural_improvements>
  </file_structure_analysis>

  <code_quality_assessment>
    <dead_code_locations>
      <location>
        <path>[File path]</path>
        <description>[What code is dead]</description>
        <lines>[Line numbers if applicable]</lines>
      </location>
    </dead_code_locations>
    
    <deprecated_code>
      <instance>
        <path>[File path]</path>
        <deprecated_item>[What's deprecated]</deprecated_item>
        <modern_alternative>[What should replace it]</modern_alternative>
        <migration_guide>[How to update]</migration_guide>
      </instance>
    </deprecated_code>
    
    <dry_violations>
      <violation>
        <description>[What's duplicated]</description>
        <locations>[Where duplicates exist]</locations>
        <consolidation_strategy>[How to eliminate duplication]</consolidation_strategy>
      </violation>
    </dry_violations>
  </code_quality_assessment>

  <documentation_review>
    <missing_documentation>
      <item>
        <type>[README/API docs/inline comments/etc.]</type>
        <location>[Where it should be added]</location>
        <priority>[Critical/Important/Nice-to-have]</priority>
        <template>[Example or template to follow]</template>
      </item>
    </missing_documentation>
    
    <documentation_improvements>
      <improvement>
        <current>[What exists]</current>
        <enhancement>[How to improve it]</enhancement>
        <example>[Concrete example]</example>
      </improvement>
    </documentation_improvements>
    
    <recommended_structure>
      [Outline of ideal documentation structure for this project]
    </recommended_structure>
  </documentation_review>

  <monorepo_standards_compliance>
    <current_setup_assessment>
      <tool_evaluation>[Assessment of chosen monorepo tool]</tool_evaluation>
      <workspace_configuration>[Analysis of workspace setup]</workspace_configuration>
      <dependency_management>[How dependencies are managed]</dependency_management>
      <build_orchestration>[Build and task running approach]</build_orchestration>
    </current_setup_assessment>
    
    <best_practices_alignment>
      <follows>
        <practice>[Practice being followed correctly]</practice>
      </follows>
      <missing>
        <practice>[Practice not implemented]</practice>
        <recommendation>[How to implement]</recommendation>
      </missing>
    </best_practices_alignment>
    
    <industry_comparison>
      [Comparison with standard monorepo implementations from major companies/projects]
    </industry_comparison>
  </monorepo_standards_compliance>

  <security_preliminary_check>
    <exposed_secrets>
      <finding>[Any exposed credentials or secrets]</finding>
    </exposed_secrets>
    
    <sensitive_files>
      <file>
        <path>[File that shouldn't be committed]</path>
        <reason>[Why it's sensitive]</reason>
        <action>[What to do about it]</action>
      </file>
    </sensitive_files>
    
    <security_configuration>
      <assessment>[Review of security headers, CORS, etc.]</assessment>
      <recommendations>[Security improvements]</recommendations>
    </security_configuration>
  </security_preliminary_check>

  <versioning_strategy>
    <current_approach>
      [Assessment of current versioning if any]
    </current_approach>
    
    <recommendations>
      <strategy>[Recommended versioning approach]</strategy>
      <tooling>[Tools to implement it: changesets, semantic-release, etc.]</tooling>
      <implementation_steps>[How to set it up]</implementation_steps>
    </recommendations>
  </versioning_strategy>

  <impression_scores>
    <recruiter_view>
      <score>[X/10]</score>
      <strengths>[What impresses from non-technical perspective]</strengths>
      <improvements>[What would improve first impression]</improvements>
    </recruiter_view>
    
    <senior_engineer_view>
      <score>[X/10]</score>
      <strengths>[Technical excellence demonstrated]</strengths>
      <improvements>[Technical gaps to address]</improvements>
    </senior_engineer_view>
  </impression_scores>

  <action_plan>
    <phase_1_critical>
      <title>Critical - Must Fix Before Merge to Main</title>
      <task>
        <description>[Specific action item]</description>
        <steps>[Detailed steps to complete]</steps>
        <estimated_time>[Time estimate]</estimated_time>
      </task>
    </phase_1_critical>
    
    <phase_2_important>
      <title>Important - Should Fix Soon After Merge</title>
      <task>
        <description>[Specific action item]</description>
        <steps>[Detailed steps to complete]</steps>
        <estimated_time>[Time estimate]</estimated_time>
      </task>
    </phase_2_important>
    
    <phase_3_enhancements>
      <title>Nice to Have - Future Improvements</title>
      <task>
        <description>[Specific action item]</description>
        <steps>[Detailed steps to complete]</steps>
        <estimated_time>[Time estimate]</estimated_time>
      </task>
    </phase_3_enhancements>
  </action_plan>

  <updated_gitignore>
    <complete_content>
[Provide complete, optimized .gitignore content with comments explaining each section]
    </complete_content>
    <changes_summary>[Summary of what was added/removed and why]</changes_summary>
  </updated_gitignore>

  <pre_merge_checklist>
    <item status="[pending/complete]">[Checklist item]</item>
  </pre_merge_checklist>

  <additional_recommendations>
    [Any other insights, suggestions, or observations that don't fit above categories but would improve the repository]
  </additional_recommendations>
</repository_audit_report>

Now, conduct your comprehensive repository audit following all the steps and guidelines outlined above. Be thorough, specific, and actionable in your assessment.