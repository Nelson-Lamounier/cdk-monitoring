# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Do not open a public issue.** Instead, email **security@nelsonlamounier.com** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact

I will acknowledge receipt within 48 hours and aim to provide a fix or mitigation plan within 7 days.

## Security Measures

This repository implements multiple layers of security controls:

### Secrets Management

- All sensitive values are stored in **GitHub Actions Secrets** or **AWS Secrets Manager**
- Infrastructure identifiers are masked in CI logs using `::add-mask::`
- Secrets are written to `$GITHUB_ENV` via `printf >> FILE` redirection to avoid stdout exposure
- No secrets are hardcoded in source code or workflow files

### CI/CD Pipeline Security

| Control | Implementation |
|---------|---------------|
| **OIDC Authentication** | Workflows authenticate to AWS via short-lived OIDC tokens — no long-lived access keys |
| **Least Privilege** | Each workflow declares the minimum required `permissions` block |
| **Pinned Actions** | All third-party actions are pinned to full commit SHAs, not mutable tags |
| **Log Sanitisation** | Infrastructure identifiers (domains, account IDs, ARNs, bucket names) are masked before logging |
| **Dependency Scanning** | Snyk integration scans for vulnerable dependencies on every PR |
| **Container Scanning** | Docker images are scanned before push to ECR |

### Infrastructure Security

- **Encryption at rest** — All S3 buckets, DynamoDB tables, and EBS volumes use AWS KMS encryption
- **Encryption in transit** — TLS enforced on all public endpoints via ACM certificates
- **Network isolation** — Kubernetes nodes run in private subnets with NAT gateway egress only
- **Security groups** — Ingress restricted to specific CIDR ranges stored in SSM Parameter Store
- **IAM boundaries** — Node roles follow least-privilege with scoped resource policies

### Branch Protection

- Direct pushes to `main` are blocked
- Pull requests require CI checks to pass before merging
- Force pushes and branch deletions are prevented on protected branches

## Scope

This is a **portfolio project** demonstrating DevOps and cloud engineering practices. It deploys real infrastructure on AWS but is not a production SaaS application.

The security controls documented here are implemented to:

1. Protect the AWS account from unauthorised access
2. Prevent sensitive data leaking through public CI logs
3. Demonstrate professional security awareness and best practices

## Dependencies

Dependencies are managed via `yarn` with a lockfile. Automated vulnerability scanning runs on:

- **Pull requests** — Snyk scans added/changed dependencies
- **Scheduled** — Weekly dependency audit via GitHub Actions

## Acknowledgements

Security improvements are welcome. If you spot an issue or have a suggestion, please reach out via the email above.
