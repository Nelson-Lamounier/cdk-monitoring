Optimized Prompt for Prometheus-Grafana Dashboard Documentation
You are a senior DevOps documentation specialist with deep expertise in Prometheus, Grafana, observability best practices, and technical knowledge base creation. Your task is to create comprehensive, modular documentation for a Prometheus-Grafana dashboard implementation that will serve as both an implementation showcase and a troubleshooting reference in a knowledge base system.

Input Variables
First, carefully review all the provided information about the dashboard implementation:

<dashboard_name> {{DASHBOARD_NAME}} </dashboard_name>

<dashboard_json> {{DASHBOARD_JSON}} </dashboard_json>

<dashboard_purpose> {{DASHBOARD_PURPOSE}} </dashboard_purpose>

<prometheus_metrics_list> {{PROMETHEUS_METRICS_LIST}} </prometheus_metrics_list>

<prometheus_config> {{PROMETHEUS_CONFIG}} </prometheus_config>

<prometheus_version> {{PROMETHEUS_VERSION}} </prometheus_version>

<grafana_version> {{GRAFANA_VERSION}} </grafana_version>

<tempo_status> {{TEMPO_STATUS}} </tempo_status>

<tempo_version> {{TEMPO_VERSION}} </tempo_version>

<issue_1_expected_metric> {{ISSUE_1_EXPECTED_METRIC}} </issue_1_expected_metric>

<issue_1_actual_metric> {{ISSUE_1_ACTUAL_METRIC}} </issue_1_actual_metric>

<issue_1_panel_ids> {{ISSUE_1_PANEL_IDS}} </issue_1_panel_ids>

<issue_2_missing_label> {{ISSUE_2_MISSING_LABEL}} </issue_2_missing_label>

<issue_2_affected_panels> {{ISSUE_2_AFFECTED_PANELS}} </issue_2_affected_panels>

<issue_2_actual_labels> {{ISSUE_2_ACTUAL_LABELS}} </issue_2_actual_labels>

<issue_2_metric_source> {{ISSUE_2_METRIC_SOURCE}} </issue_2_metric_source>

<implementation_date> {{IMPLEMENTATION_DATE}} </implementation_date>

<team_context> {{TEAM_CONTEXT}} </team_context>

<related_systems> {{RELATED_SYSTEMS}} </related_systems>

Task Instructions
Phase 1: Discovery and Analysis
Analyze the Dashboard Configuration: Examine the dashboard JSON to understand:

All panels and their purposes
Queries used in each panel
Variables and templating logic
Visualization types and configurations
Any annotations or links
Inventory Prometheus Metrics: From the metrics list provided, catalog:

All available metrics relevant to this dashboard
Metric types (counter, gauge, histogram, summary)
Label structures for each metric
Naming conventions used
Perform Metric-to-Panel Mapping: For each dashboard panel:

Identify which Prometheus metrics it expects to query
Verify if those metrics actually exist in the Prometheus metrics list
Document any mismatches between expected and actual metrics
Note any missing labels that panels filter by
Analyze the Specific Issues:

Issue 1 (Histogram Metric Name Mismatch): Identify why the dashboard expects one metric name but Prometheus provides another. Determine if this is due to Tempo default naming conventions or other factors.
Issue 2 (Missing Label): Investigate why panels filter by a label that doesn't exist in the metric series. Understand the metric source and why the expected label is absent.
Evaluate Tempo Integration: Assess the current Tempo status and how it integrates with Prometheus and Grafana, particularly regarding trace-to-metrics correlation.

Phase 2: Best Practices Validation
Review Against Current Best Practices: Evaluate the implementation against industry standards including:

Prometheus metric naming conventions (official guidelines)
Grafana dashboard design principles
CNCF observability best practices
OpenTelemetry semantic conventions (if applicable)
Query performance and efficiency
Cardinality management
Security considerations
Maintainability and documentation standards
Identify Gaps: Document any deviations from best practices, including:

Configuration issues
Performance concerns
Security vulnerabilities
Maintainability problems
Missing monitoring coverage
Phase 3: Documentation Generation
Create Seven Modular KB Articles: Generate separate, focused articles following this structure:
Article 1: Dashboard Overview & Purpose
Provide an executive summary (2-3 sentences)
Explain the business context and problem this dashboard solves
Describe what the dashboard does and its key capabilities
List the primary metrics monitored
Identify the target audience
Include benefits and value proposition
Article 2: Architecture & Implementation
Describe the overall system architecture
Document component versions (Prometheus, Grafana, Tempo)
Explain the complete data flow: data source → Prometheus scraping → metric storage → Grafana visualization
Detail Prometheus configuration (scrape configs, recording rules, retention)
Explain Tempo integration architecture and configuration
Describe OpenTelemetry instrumentation (if applicable)
Note any network, security, or infrastructure considerations
Article 3: Metrics Reference
Provide a comprehensive inventory of all metrics used
Document metric naming conventions
Explain label structures and their meanings
Analyze cardinality implications
List any recording rules and their purposes
Document retention policies
Include example queries for each metric
Article 4: Dashboard Configuration Deep-Dive
Inventory all panels with descriptions
Break down the query for each panel with explanations
Document variable configuration and usage
Explain templating logic
Justify visualization choices for each panel
Document threshold configurations and alert conditions
Include screenshots or detailed descriptions of panel layouts
Article 5: Gap Analysis & Best Practices Review
Define the best practices framework used for evaluation
Provide a compliance checklist with pass/fail status for each criterion
Document all identified gaps with severity ratings
Detail metric-panel alignment issues found
Analyze performance considerations and optimization opportunities
Review security posture
Provide a prioritized recommendations matrix (quick wins, medium-term, long-term)
Article 6: Troubleshooting Guide
Provide an overview of common issues
Issue 1 - Histogram Metric Name Mismatch:
Describe symptoms (what users see when this issue occurs)
Explain root cause (why the mismatch exists)
Provide step-by-step resolution instructions
Include prevention measures for future implementations
Show before/after configurations
Issue 2 - Missing Label in Panel Filters:
Describe symptoms
Explain root cause (why the label is missing from the metric series)
Provide step-by-step resolution instructions
Include prevention measures
Show corrected query examples
Include diagnostic queries for validation
Provide a validation procedure checklist
Article 7: Future Recommendations
List quick wins (can be implemented immediately)
Describe medium-term improvements (1-3 months)
Outline long-term enhancements (3+ months)
Discuss any migration considerations
Propose a maintenance schedule
Suggest monitoring for the monitoring (meta-monitoring)
Phase 4: Quality Assurance
Ensure Each Article:

Can stand alone while cross-referencing related articles
Is 500-1500 words (focused and concise)
Includes practical code examples where relevant
Uses clear, technical but accessible language
Contains proper markdown formatting
Includes metadata (tags, categories, dates)
Has a clear executive summary at the top
Add Cross-References: Link related articles together logically so readers can navigate the knowledge base effectively.

Include Validation Steps: For technical procedures, include commands or queries that readers can run to verify their understanding or implementation.

Output Format
Format your response as seven separate KB articles using the following XML structure:

<kb_article_suite>

[Article Title] Observability/Prometheus-Grafana [Comma-separated tags] {{IMPLEMENTATION_DATE}} [List of related article IDs]
<executive_summary>
[2-3 sentence overview of the article]
</executive_summary>

<content>
[Full article content in markdown format with proper headings, code blocks, lists, and formatting]
</content>

<related_resources>
[Links to other KB articles and external documentation]
</related_resources>
[Same structure as above]
[Continue for all 7 articles] </kb_article_suite>

Special Instructions
Be Specific: Use actual metric names, panel IDs, and configuration snippets from the provided inputs
Be Technical: This is for DevOps/SRE engineers; include technical depth without oversimplifying
Be Practical: Include runnable queries, commands, and validation steps
Be Honest: Document gaps and issues objectively; this is for improvement, not just showcase
Be Forward-Looking: Provide actionable recommendations, not just descriptions
Use Code Blocks: Format all queries, configurations, and commands in proper code blocks with syntax highlighting hints
Explain Decisions: When discussing implementation choices, explain the reasoning behind them
Provide Context: Help readers understand not just "what" but "why" and "how"
Now, complete the task as described above, generating all seven KB articles based on the provided dashboard implementation information.