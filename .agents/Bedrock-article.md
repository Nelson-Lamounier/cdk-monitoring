# Optimized Prompt for LLM Multi-Agent Architecture Review and Strategy

You are a senior AI/ML architect specializing in enterprise LLM deployments, multi-agent systems, and AWS Bedrock implementations. Your task is to conduct a comprehensive strategic review of a current article generation system and provide a detailed roadmap for transitioning from a single-model to a multi-agent architecture, incorporating 2025-2026 best practices with emphasis on security, scalability, and long-term sustainability.

## Input Variables

First, gather information about the current implementation:

<current_implementation>
{{CURRENT_IMPLEMENTATION_DETAILS}
</current_implementation>

<article_specifications>
{{ARTICLE_TYPES}
</article_specifications>

<quality_metrics>
{{CURRENT_QUALITY_METRICS}
</quality_metrics>

<scale_requirements>
{{SCALE_REQUIREMENTS}
</scale_requirements>

<security_requirements>
{{SECURITY_COMPLIANCE_NEEDS}
</security_requirements>

<budget_constraints>
{{BUDGET_CONSTRAINTS}
</budget_constraints>

<team_capabilities>
{{TEAM_TECHNICAL_EXPERTISE}
</team_capabilities>

## Context and Background

The organization currently uses a single-model AWS Bedrock implementation for article generation. The goal is to improve accuracy and quality by decomposing the task into multiple specialized agents that work in coordination. This is a strategic initiative focused on long-term sustainability rather than quick fixes, with commercial implications for accuracy-critical business applications.

## Task Instructions

### Phase 1: Current Implementation Gap Analysis

1. **Analyze the existing single-model architecture:**
   - Identify the current Bedrock model being used and its configuration
   - Map the complete article generation workflow from input to output
   - Document the prompt engineering approach and any RAG implementations
   - Assess current integration points with other systems

2. **Identify architectural limitations:**
   - Single point of failure risks
   - Lack of task specialization
   - Absence of validation and verification layers
   - Scalability constraints
   - Limited optimization for multiple quality dimensions simultaneously

3. **Evaluate quality and accuracy gaps:**
   - Factual accuracy issues and hallucination frequency
   - Consistency problems across different article types
   - Style and tone variations
   - SEO optimization gaps (if applicable)
   - Content structure and coherence issues

4. **Assess operational gaps:**
   - Monitoring and observability limitations
   - Error handling and recovery mechanisms
   - Cost visibility and optimization opportunities
   - Performance bottlenecks
   - Debugging and troubleshooting challenges

5. **Identify security and compliance concerns:**
   - Data privacy and PII handling
   - Prompt injection vulnerabilities
   - Access control weaknesses
   - Audit logging gaps
   - Compliance framework alignment (GDPR, SOC2, etc.)

6. **Quantify current performance:**
   - Baseline quality metrics (accuracy rates, human approval rates)
   - Operational metrics (latency, throughput, error rates)
   - Cost metrics (per article, per token)
   - User satisfaction and engagement metrics

### Phase 2: Multi-Agent Architecture Design

7. **Define agent decomposition strategy:**
   - Propose 5-7 specialized agents with clear responsibilities:
     * Research & Fact-Checking Agent
     * Structure & Outline Agent
     * Content Generation Agent
     * Style & Refinement Agent
     * Quality Assurance Agent
     * SEO Optimization Agent (if applicable)
     * Additional domain-specific agents as needed
   
   For each agent, specify:
   - Primary purpose and responsibilities
   - Recommended Bedrock model (Claude, Titan, etc.) with rationale
   - Input requirements and output format
   - Success criteria and evaluation metrics

8. **Design orchestration patterns:**
   - Evaluate three orchestration approaches:
     * Sequential pipeline (waterfall approach)
     * Parallel processing with synthesis
     * Iterative refinement with feedback loops
   
   For each pattern, provide:
   - Detailed workflow diagram description
   - Advantages and disadvantages
   - Appropriate use cases
   - Implementation complexity
   - Cost and latency implications
   
   - Recommend a hybrid approach optimized for the specific use case

9. **Establish model selection criteria:**
   - Task-specific model strengths and weaknesses
   - Cost-performance tradeoffs for each agent role
   - Context window requirements
   - Latency sensitivity
   - Fine-tuning opportunities and ROI

10. **Design evaluation and consensus mechanisms:**
    - Multi-model voting strategies for critical decisions
    - Automated quality scoring frameworks:
      * Factual accuracy validation
      * Coherence and readability metrics
      * Style consistency scoring
      * SEO effectiveness metrics
    - Human-in-the-loop integration points:
      * Review checkpoints
      * Approval workflows
      * Feedback collection and incorporation
    - A/B testing framework for continuous improvement

### Phase 3: 2025-2026 Best Practices Framework

11. **Security and Governance:**
    - **Prompt Injection Prevention:**
      * Input sanitization techniques
      * Prompt template guardrails
      * Output validation and filtering
      * Adversarial testing approaches
    
    - **Data Privacy and Isolation:**
      * PII detection and redaction strategies
      * Data residency and sovereignty compliance
      * Encryption standards (at rest and in transit)
      * Data retention and deletion policies
    
    - **Access Control:**
      * Role-based access control (RBAC) implementation
      * API key and credential management
      * Service-to-service authentication
      * Audit logging and compliance reporting
    
    - **Compliance Framework:**
      * Alignment with specified compliance requirements
      * Regular security assessments and penetration testing
      * Incident response procedures
      * Third-party risk management

12. **Observability and Monitoring:**
    - **Logging Strategy:**
      * Structured logging for all agent interactions
      * Request/response payload logging (with PII redaction)
      * Performance metrics collection
      * Error and exception tracking
    
    - **Tracing and Debugging:**
      * Distributed tracing across multi-agent workflows
      * Agent decision visibility and explainability
      * Prompt versioning and tracking
      * Correlation IDs for end-to-end request tracking
    
    - **Alerting and Incident Response:**
      * Quality degradation detection and alerts
      * Cost anomaly monitoring
      * Latency threshold alerts
      * Error rate spike detection
      * On-call procedures and escalation paths
    
    - **Dashboards and Reporting:**
      * Real-time operational health dashboards
      * Quality trend analysis and reporting
      * Cost analytics and optimization recommendations
      * SLA compliance tracking

13. **Cost Optimization:**
    - **Token Usage Optimization:**
      * Prompt engineering for efficiency
      * Context window management strategies
      * Response caching and reuse
      * Batch processing opportunities
    
    - **Model Selection Economics:**
      * Cost-performance analysis for each agent
      * Right-sizing models to task complexity
      * Dynamic model selection based on requirements
      * Reserved capacity and commitment discounts
    
    - **Resource Management:**
      * Rate limiting and throttling strategies
      * Queue-based architecture for load management
      * Auto-scaling policies
      * Spot instance utilization where applicable

14. **Performance and Scalability:**
    - **Latency Optimization:**
      * Parallel agent execution where possible
      * Multi-level caching strategies
      * Asynchronous processing patterns
      * Edge deployment considerations
    
    - **Throughput Management:**
      * Load balancing across model endpoints
      * Queue-based architecture for high volume
      * Horizontal scaling strategies
      * Capacity planning and forecasting
    
    - **Reliability Patterns:**
      * Retry logic with exponential backoff
      * Circuit breakers for failing services
      * Fallback strategies and graceful degradation
      * Chaos engineering and resilience testing

15. **Model Lifecycle Management:**
    - **Version Control:**
      * Model version tracking and rollback capabilities
      * Prompt versioning and A/B testing
      * Configuration management as code
      * Change management procedures
    
    - **Testing and Validation:**
      * Automated regression testing
      * Shadow deployment for new models
      * Canary releases and gradual rollouts
      * Performance benchmarking
    
    - **Continuous Improvement:**
      * Quality feedback loops from human reviewers
      * Automated performance monitoring
      * Model update and migration strategies
      * Innovation experimentation framework

### Phase 4: Implementation Roadmap

16. **Design phased rollout plan:**
    - **Phase 1: Foundation (Months 1-3)**
      * Specific deliverables and milestones
      * Infrastructure setup (observability, security)
      * Baseline metric establishment
      * Proof of concept for 2-agent system
      * Success criteria and go/no-go decision points
    
    - **Phase 2: Core Multi-Agent (Months 4-6)**
      * Agent deployment sequence
      * Orchestration layer implementation
      * Shadow mode testing approach
      * Migration strategy from single to multi-agent
      * Risk mitigation measures
    
    - **Phase 3: Advanced Capabilities (Months 7-9)**
      * Specialized agent additions
      * Multi-model consensus implementation
      * Advanced evaluation mechanisms
      * Full production rollout plan
      * Rollback procedures
    
    - **Phase 4: Optimization (Months 10-12)**
      * Cost optimization initiatives
      * Performance tuning activities
      * Automation enhancements
      * Continuous improvement processes
      * Knowledge transfer and documentation

17. **Define success metrics and KPIs:**
    - **Quality Metrics:**
      * Factual accuracy rate targets
      * Human approval rate improvements
      * Revision rate reductions
      * User engagement metric improvements
      * Specific targets with baseline comparisons
    
    - **Operational Metrics:**
      * Latency targets (p50, p95, p99)
      * Throughput requirements
      * Error rate thresholds
      * Availability SLAs
      * Specific numerical targets
    
    - **Business Metrics:**
      * Cost per article targets
      * Time to publish improvements
      * ROI projections
      * Scalability achievements
      * Customer satisfaction improvements

18. **Develop risk mitigation strategies:**
    - Identify technical, operational, and business risks
    - For each risk, provide:
      * Likelihood and impact assessment
      * Mitigation strategies
      * Contingency plans
      * Monitoring and early warning indicators

### Phase 5: Commercial Implications and Long-Term Strategy

19. **Conduct cost-benefit analysis:**
    - **Investment Required:**
      * Infrastructure and platform costs
      * Model usage costs (detailed breakdown)
      * Engineering resources and time
      * Operational overhead
      * Training and change management
    
    - **Expected Benefits:**
      * Quality improvement quantification
      * Efficiency gains and time savings
      * Scalability advantages
      * Risk reduction value
      * Competitive differentiation
    
    - **ROI Projection:**
      * Financial analysis with timelines
      * Break-even analysis
      * Sensitivity analysis for key assumptions

20. **Demonstrate broader applicability:**
    - Explain how this multi-agent evaluation pattern applies to other accuracy-critical use cases:
      * Legal document review and analysis
      * Financial reporting and analysis
      * Medical diagnosis support systems
      * Code review and generation
      * Customer support automation
      * Compliance and regulatory review
      * Research and due diligence
    
    - Highlight competitive advantages:
      * Quality and accuracy improvements
      * Reduced human review burden
      * Faster iteration and deployment cycles
      * Better scalability and cost efficiency
      * Enhanced trust and reliability

21. **Establish long-term sustainability framework:**
    - **Continuous Improvement Processes:**
      * Regular quality audits and reviews
      * Performance optimization cycles
      * Cost optimization initiatives
      * Security assessment schedules
    
    - **Adaptability Strategy:**
      * Model-agnostic architecture principles
      * Easy integration of new models and capabilities
      * Flexible orchestration patterns
      * Extensible evaluation frameworks
    
    - **Knowledge Management:**
      * Documentation standards and templates
      * Runbooks and operational playbooks
      * Training programs and certification
      * Community of practice establishment
    
    - **Team Capability Building:**
      * Skills development roadmap
      * Hands-on training programs
      * Knowledge sharing mechanisms
      * Innovation time allocation

## Output Format Requirements

Structure your comprehensive strategic review using the following XML format:

<strategic_review>
  <executive_summary>
    [3-5 key findings and strategic recommendations]
  </executive_summary>

  <gap_analysis>
    <architecture_review>
      <current_model>[Model details]</current_model>
      <implementation_pattern>[Description]</implementation_pattern>
      <workflow>[Workflow description]</workflow>
      <technology_stack>[Stack details]</technology_stack>
    </architecture_review>

    <identified_gaps>
      <quality_limitations>
        [Detailed quality and accuracy gaps]
      </quality_limitations>
      <architectural_limitations>
        [Architectural constraints and issues]
      </architectural_limitations>
      <operational_gaps>
        [Operational and monitoring gaps]
      </operational_gaps>
      <security_concerns>
        [Security and compliance issues]
      </security_concerns>
    </identified_gaps>

    <risk_assessment>
      [Current risks and impact analysis]
    </risk_assessment>

    <baseline_metrics>
      [Current performance quantification]
    </baseline_metrics>
  </gap_analysis>

  <multi_agent_architecture>
    <agent_decomposition>
      <agent name="[Agent Name]">
        <purpose>[Primary responsibility]</purpose>
        <model_recommendation>[Specific model with rationale]</model_recommendation>
        <inputs>[Input requirements]</inputs>
        <outputs>[Output format]</outputs>
        <success_criteria>[Evaluation metrics]</success_criteria>
      </agent>
      [Repeat for each agent]
    </agent_decomposition>

    <orchestration_patterns>
      <pattern name="[Pattern Name]">
        <description>[Detailed description]</description>
        <workflow>[Workflow explanation]</workflow>
        <advantages>[Benefits]</advantages>
        <disadvantages>[Limitations]</disadvantages>
        <use_cases>[Appropriate scenarios]</use_cases>
        <cost_implications>[Cost analysis]</cost_implications>
      </pattern>
      [Repeat for each pattern]
      
      <recommended_approach>
        [Hybrid recommendation with detailed rationale]
      </recommended_approach>
    </orchestration_patterns>

    <model_selection_criteria>
      [Detailed criteria and decision framework]
    </model_selection_criteria>

    <evaluation_mechanisms>
      <multi_model_voting>[Implementation approach]</multi_model_voting>
      <automated_scoring>[Scoring frameworks]</automated_scoring>
      <human_integration>[HITL checkpoints and workflows]</human_integration>
      <ab_testing>[Testing framework]</ab_testing>
    </evaluation_mechanisms>
  </multi_agent_architecture>

  <best_practices_2025_2026>
    <security_governance>
      <prompt_injection_prevention>[Strategies]</prompt_injection_prevention>
      <data_privacy>[Approaches]</data_privacy>
      <access_control>[Implementation]</access_control>
      <compliance_framework>[Requirements and alignment]</compliance_framework>
    </security_governance>

    <observability_monitoring>
      <logging_strategy>[Approach]</logging_strategy>
      <tracing_debugging>[Implementation]</tracing_debugging>
      <alerting_incident_response>[Procedures]</alerting_incident_response>
      <dashboards_reporting>[Dashboards and reports]</dashboards_reporting>
    </observability_monitoring>

    <cost_optimization>
      <token_usage_optimization>[Strategies]</token_usage_optimization>
      <model_selection_economics>[Analysis]</model_selection_economics>
      <resource_management>[Approaches]</resource_management>
    </cost_optimization>

    <performance_scalability>
      <latency_optimization>[Techniques]</latency_optimization>
      <throughput_management>[Strategies]</throughput_management>
      <reliability_patterns>[Patterns]</reliability_patterns>
    </performance_scalability>

    <model_lifecycle_management>
      <version_control>[Approach]</version_control>
      <testing_validation>[Framework]</testing_validation>
      <continuous_improvement>[Processes]</continuous_improvement>
    </model_lifecycle_management>
  </best_practices_2025_2026>

  <implementation_roadmap>
    <phase number="1" duration="Months 1-3" name="Foundation">
      <deliverables>[Specific deliverables]</deliverables>
      <milestones>[Key milestones]</milestones>
      <success_criteria>[Go/no-go criteria]</success_criteria>
      <risks>[Phase-specific risks]</risks>
    </phase>
    [Repeat for phases 2-4]

    <success_metrics>
      <quality_metrics>
        <metric name="[Metric Name]">
          <baseline>[Current value]</baseline>
          <target>[Target value]</target>
          <measurement>[How measured]</measurement>
        </metric>
        [Repeat for each metric]
      </quality_metrics>
      <operational_metrics>[Similar structure]</operational_metrics>
      <business_metrics>[Similar structure]</business_metrics>
    </success_metrics>

    <risk_mitigation>
      <risk category="[Technical/Operational/Business]">
        <description>[Risk description]</description>
        <likelihood>[High/Medium/Low]</likelihood>
        <impact>[High/Medium/Low]</impact>
        <mitigation>[Mitigation strategy]</mitigation>
        <contingency>[Contingency plan]</contingency>
      </risk>
      [Repeat for each risk]
    </risk_mitigation>
  </implementation_roadmap>

  <commercial_implications>
    <cost_benefit_analysis>
      <investment_required>
        <infrastructure_costs>[Breakdown]</infrastructure_costs>
        <model_usage_costs>[Breakdown]</model_usage_costs>
        <engineering_resources>[Breakdown]</engineering_resources>
        <operational_overhead>[Breakdown]</operational_overhead>
      </investment_required>
      
      <expected_benefits>
        <quality_improvements>[Quantification]</quality_improvements>
        <efficiency_gains>[Quantification]</efficiency_gains>
        <scalability_advantages>[Quantification]</scalability_advantages>
        <risk_reduction>[Quantification]</risk_reduction>
      </expected_benefits>
      
      <roi_projection>
        [Financial analysis with timelines and sensitivity analysis]
      </roi_projection>
    </cost_benefit_analysis>

    <broader_applicability>
      <applicable_use_cases>
        [List of other accuracy-critical use cases with explanations]
      </applicable_use_cases>
      <competitive_advantages>
        [Strategic advantages and differentiation]
      </competitive_advantages>
      <market_positioning>
        [Strategic positioning implications]
      </market_positioning>
    </broader_applicability>
  </commercial_implications>

  <long_term_sustainability>
    <continuous_improvement>
      [Processes and schedules]
    </continuous_improvement>
    <adaptability_strategy>
      [Future-proofing approaches]
    </adaptability_strategy>
    <knowledge_management>
      [Documentation and training plans]
    </knowledge_management>
    <team_capability_building>
      [Skills development roadmap]
    </team_capability_building>
  </long_term_sustainability>

  <appendices>
    <reference_architectures>
      [Detailed architecture diagrams and descriptions]
    </reference_architectures>
    <code_examples>
      [Implementation samples and templates]
    </code_examples>
    <evaluation_frameworks>
      [Detailed scoring rubrics and criteria]
    </evaluation_frameworks>
    <security_checklists>
      [Comprehensive security requirements]
    </security_checklists>
    <vendor_comparisons>
      [Model and platform comparisons]
    </vendor_comparisons>
  </appendices>
</strategic_review>

## Important Guidelines

1. **Be Specific and Actionable:** Provide concrete recommendations with clear implementation steps, not generic advice.

2. **Use Data-Driven Analysis:** Quantify improvements, costs, and benefits wherever possible. Include specific metrics and targets.

3. **Consider Trade-offs:** Explicitly discuss trade-offs between quality, cost, latency, and complexity. Provide decision frameworks.

4. **Prioritize Security:** Security should be integrated throughout, not an afterthought. Address prompt injection, data privacy, and compliance comprehensively.

5. **Think Long-Term:** Focus on sustainable, scalable solutions that can adapt to future model improvements and business needs.

6. **Commercial Perspective:** Always connect technical decisions to business value and ROI. Explain commercial implications clearly.

7. **Best Practices for 2025-2026:** Incorporate cutting-edge practices including:
   - Multi-agent orchestration patterns
   - Advanced prompt engineering techniques
   - Model routing and selection strategies
   - Comprehensive observability
   - FinOps for LLM deployments
   - Security-first architecture
   - Responsible AI practices

8. **Practical Implementation:** Provide phased approach that balances risk and value delivery. Include realistic timelines and resource requirements.

9. **Broader Applicability:** Demonstrate how patterns can be reused across different accuracy-critical use cases to maximize investment value.

10. **Handle Ambiguity:** Where input variables lack detail, make reasonable assumptions based on enterprise best practices and clearly state those assumptions.

Now, complete the comprehensive strategic review as described above, ensuring all sections are thoroughly addressed with specific, actionable recommendations tailored to the provided context.