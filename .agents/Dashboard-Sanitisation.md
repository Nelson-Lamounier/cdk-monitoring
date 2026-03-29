Optimized Prompt for Dashboard Sanitization and Metric Correction
You are an expert DevOps/SRE engineer specializing in observability infrastructure, specifically Grafana dashboards, Prometheus metrics, and Tempo distributed tracing. Your task is to systematically audit, diagnose, and fix a monitoring dashboard that has multiple issues including incorrect metric names, missing labels, dead code references, and non-functional components.

Input Variables
<PROMETHEUS_URL> {{PROMETHEUS_URL}} </PROMETHEUS_URL>

<GRAFANA_DASHBOARD_JSON> {{GRAFANA_DASHBOARD_JSON}} </GRAFANA_DASHBOARD_JSON>

<CURRENT_WRONG_METRIC> {{CURRENT_WRONG_METRIC}} </CURRENT_WRONG_METRIC>

<CORRECT_METRIC_NAME> {{CORRECT_METRIC_NAME}} </CORRECT_METRIC_NAME>

<MISSING_LABEL_NAME> {{MISSING_LABEL_NAME}} </MISSING_LABEL_NAME>

<AVAILABLE_LABELS> {{AVAILABLE_LABELS}} </AVAILABLE_LABELS>

<SERVICE_NAMES> {{SERVICE_NAMES}} </SERVICE_NAMES>

<TRAEFIK_JOB_NAME> {{TRAEFIK_JOB_NAME}} </TRAEFIK_JOB_NAME>

<DEAD_REFERENCES> {{DEAD_REFERENCES}} </DEAD_REFERENCES>

{{ENVIRONMENT}}
Context
You are working with a monitoring stack consisting of:

Grafana for visualization
Prometheus for metrics collection and storage
Tempo for distributed tracing (using default naming conventions)
The dashboard has accumulated technical debt and configuration drift, resulting in:

Histogram metric name mismatch: Dashboard queries use incorrect metric names that don't match Tempo's default naming
Missing label filters: Panels filter by labels that don't exist in the actual metric series
Dead code and parameters: References to obsolete services (e.g., "portfolio-frontend", "nextjs-personal-portfilo-development" DynamoDB table)
Non-functional Traefik dropdown: Not displaying data despite Traefik being monitored
General misalignment: Dashboard configuration doesn't reflect actual Prometheus-scraped metrics
The spans originate from services without custom OTel semantic attributes, limiting available labels for filtering.

Task Instructions
Phase 1: Discovery and Analysis
Query Prometheus for available metrics:

Execute: curl -G <span style="color: #C0271C">{{PROMETHEUS_URL}}</span>/api/v1/label/__name__/values to list all metric names
Filter for Tempo-related metrics: Look for patterns like tempo_*, traces_*, or histogram metrics with _bucket, _sum, _count suffixes
Filter for Traefik metrics: Look for traefik_* patterns
Document all metrics related to the services in <span style="color: #C0271C">{{SERVICE_NAMES}}</span>
Inspect metric label structure:

For each relevant metric, query: curl -G <span style="color: #C0271C">{{PROMETHEUS_URL}}</span>/api/v1/series -d 'match[]={__name__="<metric_name>"}'
Extract all unique label names and their possible values
Pay special attention to labels like job, instance, service, environment, namespace
Compare discovered labels against <span style="color: #C0271C">{{AVAILABLE_LABELS}}</span> and <span style="color: #C0271C">{{MISSING_LABEL_NAME}}</span>
Analyze dashboard configuration:

Parse <span style="color: #C0271C">{{GRAFANA_DASHBOARD_JSON}}</span> to extract:
All PromQL queries from panels
Variable definitions and their queries
Template variables used in filters
Panel titles and descriptions
Identify every occurrence of:
<span style="color: #C0271C">{{CURRENT_WRONG_METRIC}}</span> (the incorrect metric name)
<span style="color: #C0271C">{{MISSING_LABEL_NAME}}</span> (the label being filtered that doesn't exist)
Any reference in <span style="color: #C0271C">{{DEAD_REFERENCES}}</span> list
The Traefik dropdown configuration
Create mismatch report:

List all panels using <span style="color: #C0271C">{{CURRENT_WRONG_METRIC}}</span> with their panel IDs and titles
List all queries filtering by <span style="color: #C0271C">{{MISSING_LABEL_NAME}}</span>
List all references to dead code/parameters from <span style="color: #C0271C">{{DEAD_REFERENCES}}</span>
Document the Traefik dropdown query and why it's failing
Phase 2: Generate Corrections
Fix metric name issues:

For each panel using <span style="color: #C0271C">{{CURRENT_WRONG_METRIC}}</span>:
Replace with <span style="color: #C0271C">{{CORRECT_METRIC_NAME}}</span>
Ensure histogram queries use proper suffixes (_bucket, _sum, _count)
Verify aggregation functions are appropriate (e.g., histogram_quantile() for percentiles)
Provide the corrected PromQL query
Resolve label filtering issues:

For panels filtering by <span style="color: #C0271C">{{MISSING_LABEL_NAME}}</span>:
Determine if an alternative label from <span style="color: #C0271C">{{AVAILABLE_LABELS}}</span> can achieve the same filtering intent
If no alternative exists, remove the filter and document the limitation
Update variable definitions if they reference the missing label
Provide corrected queries with working label filters
Fix Traefik dropdown:

Analyze the current Traefik dropdown query
Verify the <span style="color: #C0271C">{{TRAEFIK_JOB_NAME}}</span> is correct
Check if Traefik metrics exist in Prometheus with query: {job="<span style="color: #C0271C">{{TRAEFIK_JOB_NAME}}</span>"}
Identify the root cause (wrong job name, missing metrics, incorrect label matcher)
Provide corrected dropdown query using actual Traefik metric labels
Remove dead references:

For each item in <span style="color: #C0271C">{{DEAD_REFERENCES}}</span>:
Locate all occurrences in the dashboard JSON (panels, variables, annotations, links)
Provide JSON path or line numbers for removal
Suggest replacement values if the reference serves a functional purpose
Mark items for complete deletion if they're purely obsolete
Phase 3: Implementation Plan
Create step-by-step remediation:

Number each change sequentially
Provide exact JSON modifications or Grafana UI steps
Include validation query for each fix (e.g., "Run this query in Prometheus to verify data exists")
Specify order of operations (e.g., fix variables before panels that use them)
Generate updated dashboard JSON:

Apply all corrections to <span style="color: #C0271C">{{GRAFANA_DASHBOARD_JSON}}</span>
Increment the dashboard version number
Update the dashboard description to note "Sanitized metrics and removed dead references"
Ensure JSON is valid and properly formatted
Phase 4: Validation
Create validation checklist:

For each corrected panel: Provide a test query to run in Prometheus that should return data
For the Traefik dropdown: Specify expected values that should appear
For removed dead code: Confirm no remaining references exist
List specific Grafana UI checks (e.g., "Panel X should display histogram with data from last 24h")
Document changes:

Summarize total number of fixes by category
List any limitations or trade-offs (e.g., "Removed service filter because label doesn't exist")
Provide rollback instructions (restore from backup JSON)
Note any follow-up actions needed (e.g., "Add custom labels to instrumentation for better filtering")
Output Format
Structure your response using the following XML format:

<dashboard_sanitization_report> <executive_summary> <total_issues_found>[number]</total_issues_found> [high/medium/low] <estimated_fix_time>[duration]</estimated_fix_time> <critical_findings>[brief description of most severe issues]</critical_findings> </executive_summary>

<discovery_results> <prometheus_metrics> <tempo_metrics> </tempo_metrics> <traefik_metrics> </traefik_metrics> <service_metrics> </service_metrics> </prometheus_metrics>

<dashboard_analysis>
  <incorrect_metrics>
    <issue panel_id="[id]" panel_title="[title]">
      <current_query>[PromQL query]</current_query>
      <problem>[description]</problem>
    </issue>
    <!-- Repeat for each issue -->
  </incorrect_metrics>

  <missing_labels>
    <issue panel_id="[id]" panel_title="[title]">
      <missing_label>[label_name]</missing_label>
      <current_filter>[filter expression]</current_filter>
      <impact>[description]</impact>
    </issue>
    <!-- Repeat for each issue -->
  </missing_labels>

  <dead_references>
    <reference>
      <name>[reference_name]</name>
      <locations>[JSON paths or panel IDs]</locations>
      <type>[service/table/parameter]</type>
    </reference>
    <!-- Repeat for each dead reference -->
  </dead_references>

  <traefik_dropdown_issue>
    <current_query>[query]</current_query>
    <root_cause>[explanation]</root_cause>
  </traefik_dropdown_issue>
</dashboard_analysis>
</discovery_results>

<detailed_fixes> <metric_corrections> <current_query>[incorrect PromQL]</current_query> <corrected_query>[correct PromQL]</corrected_query> <changes_made>[description of changes]</changes_made> <validation_query>[query to test in Prometheus]</validation_query> </metric_corrections>

<label_fixes>
  <fix panel_id="[id]" panel_title="[title]">
    <issue>[description]</issue>
    <solution>[approach taken]</solution>
    <corrected_query>[new PromQL query]</corrected_query>
    <limitations>[any trade-offs or limitations]</limitations>
  </fix>
  <!-- Repeat for each fix -->
</label_fixes>

<traefik_dropdown_fix>
  <corrected_query>[new dropdown query]</corrected_query>
  <explanation>[why this works]</explanation>
  <expected_values>[what should appear in dropdown]</expected_values>
</traefik_dropdown_fix>

<removals>
  <removal>
    <item>[name of dead reference]</item>
    <json_path>[path in dashboard JSON]</json_path>
    <action>[delete/replace]</action>
    <replacement>[if applicable]</replacement>
  </removal>
  <!-- Repeat for each removal -->
</removals>
</detailed_fixes>

<implementation_plan> [description] [Grafana UI steps or JSON edit] [how to verify] </implementation_plan>

<validation_checklist> [what to verify] <test_procedure>[how to test]</test_procedure> <expected_result>[what should happen]</expected_result> </validation_checklist>

<updated_dashboard_json> <changes_summary>[high-level description of all changes]</changes_summary> <version_increment>[old version] → [new version]</version_increment> <json_content> [Complete corrected dashboard JSON] </json_content> </updated_dashboard_json>

[description] [description] [recommendation]
<rollback_procedure> [instruction] </rollback_procedure> </dashboard_sanitization_report>

Important Considerations
Preserve functionality: Ensure all fixes maintain or improve dashboard usability
Data validation: Every corrected query must be tested against Prometheus to confirm it returns data
Backward compatibility: Note if any changes might affect alerts or other dashboards referencing the same metrics
Documentation: Clearly explain the reasoning behind each change, especially when removing functionality
Tempo naming conventions: Respect Tempo's default metric naming patterns (typically tempo_<metric_type>_<name>_<suffix>)
Label cardinality: Be mindful of high-cardinality labels that could impact Prometheus performance
Environment specificity: Ensure fixes are appropriate for <span style="color: #C0271C">{{ENVIRONMENT}}</span>
Now, complete the dashboard sanitization task as described above, providing a comprehensive analysis and actionable fixes for all identified issues.