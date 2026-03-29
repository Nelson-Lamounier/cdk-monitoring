Comprehensive Code Quality Review Request
I need you to conduct a thorough code quality review and provide detailed, actionable feedback across multiple dimensions.

Code Submission
Please paste the code you want reviewed below. Specify the programming language, framework/technology stack, and the purpose of this code (e.g., production API, prototype feature, data processing script).

Review Criteria
Evaluate the code across the following dimensions:

1. Code Quality Principles
DRY Principle: Is the code free from unnecessary repetition? Are there reusable components that could be extracted?
SOLID Principles: Does the code follow Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, and Dependency Inversion principles?
Code Sophistication: Is the implementation elegant and well-designed? Does it demonstrate appropriate use of language features and design patterns?
2. Industry Standards & Best Practices
Does the code follow established conventions for the specified language and framework?
Are naming conventions consistent and meaningful?
Is the code structure appropriate for the project type and scale?
Does it align with current industry best practices?
3. Documentation & Readability
Is the code well-commented with clear explanations of complex logic?
Are comments meaningful and up-to-date?
Is the code self-documenting with clear variable and function names?
Would another developer easily understand the code's purpose and implementation?
4. Performance & Efficiency
Are there any obvious performance bottlenecks?
Is the algorithm complexity appropriate for the use case?
Are resources (memory, connections, file handles) managed efficiently?
5. Error Handling & Robustness
Does the code handle edge cases appropriately?
Are errors caught and handled gracefully?
Is there proper input validation?
Are failure scenarios accounted for?
6. Security Assessment
Identify any security vulnerabilities based on OWASP Top 10 or similar standards
Check for common issues: SQL injection, XSS, insecure authentication, exposed secrets, insufficient input validation
Assess data handling and privacy considerations
Evaluate authorization and access control implementation
7. Maintainability & Testing
Is the code structured for easy maintenance and future modifications?
Is the code testable? Are there obvious testing gaps?
Is the separation of concerns clear?
Required Output Format
Provide your review in the following structure:

Executive Summary

Overall quality score (1-10 scale)
Brief assessment of code maturity and readiness
Top 3 strengths and top 3 areas for improvement
Detailed Findings by Category For each review criterion above, provide:

Score (1-10) with justification
Specific observations with line references where applicable
Examples of what's done well and what needs improvement
Security Assessment

List any identified vulnerabilities with severity ratings (Critical, High, Medium, Low)
Provide specific remediation recommendations
Prioritized Recommendations Organize improvement suggestions into:

Critical: Must fix before production (security issues, major bugs)
Important: Should fix soon (maintainability, performance issues)
Nice-to-have: Consider for future refactoring (code elegance, minor optimizations)
For each recommendation, provide:

Clear description of the issue
Code example showing the problem (if applicable)
Suggested improvement with code example
Expected benefit of the change
Overall Score Breakdown Provide weighted scoring across all categories with a final composite score and grade (A-F).