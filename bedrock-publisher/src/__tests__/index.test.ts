/**
 * @format
 * Bedrock Publisher — Unit Tests
 *
 * Tests for the pure, side-effect-free functions exported from index.ts.
 * These functions contain core business logic (complexity analysis, JSON parsing,
 * key derivation, Mermaid validation) and have no AWS SDK dependencies.
 */

/* eslint-disable @typescript-eslint/no-unsafe-member-access */

// Mock environment variables BEFORE importing the module
process.env.ASSETS_BUCKET = 'test-bucket';
process.env.TABLE_NAME = 'test-table';

import {
    analyseComplexity,
    deriveSlug,
    derivePublishedKey,
    deriveContentKey,
    parseTransformResult,
    validateMermaidSyntax,
} from '../index';

// =============================================================================
// Constants
// =============================================================================

const DRAFT_PREFIX = 'drafts/';

// =============================================================================
// Fixtures — markdown samples for each complexity tier
// =============================================================================

/** Short, narrative-heavy draft — expected LOW complexity */
const LOW_COMPLEXITY_DRAFT = `# Quick Tip: Using Justfile

Here's a quick tip for running tasks with Justfile.

Just run:

\`\`\`bash
just deploy
\`\`\`

That's it. Simple and effective.
`;

/** Standard DevOps article with moderate code — expected MID complexity */
const MID_COMPLEXITY_DRAFT = `# Deploying a Lambda Function with CDK

## Overview

This article covers deploying a Lambda function.

## Architecture

The architecture uses API Gateway and Lambda.

\`\`\`typescript
// infra/lib/stacks/api-stack.ts
const fn = new lambda.Function(this, 'Handler', {
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda'),
});
\`\`\`

## Configuration

\`\`\`yaml
# config/settings.yml
runtime: nodejs22.x
memory: 256
timeout: 30
\`\`\`

## Deployment

\`\`\`bash
cdk deploy --require-approval never
\`\`\`

## Monitoring

Check CloudWatch logs for errors.
`;

/**
 * Dense IaC article with many code blocks, YAML configs, and headings.
 * Expected HIGH complexity.
 */
const HIGH_COMPLEXITY_DRAFT = `# Building a Multi-Service Kubernetes Platform on AWS

## Overview

A comprehensive guide to deploying K8s with monitoring, service mesh, and GitOps.

## Prerequisites

Install the following tools.

## Network Architecture

### VPC Design

\`\`\`typescript
// infra/lib/stacks/network-stack.ts
const vpc = new ec2.Vpc(this, 'PlatformVpc', {
  maxAzs: 3,
  natGateways: 1,
  subnetConfiguration: [
    { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
    { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
    { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
  ],
});
\`\`\`

### Security Groups

\`\`\`typescript
// infra/lib/stacks/security-stack.ts
const controlPlaneSg = new ec2.SecurityGroup(this, 'ControlPlaneSg', {
  vpc,
  description: 'Control plane security group',
  allowAllOutbound: true,
});
controlPlaneSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(6443));
\`\`\`

## Kubernetes Setup

### Kubeadm Bootstrap

\`\`\`bash
kubeadm init --pod-network-cidr=192.168.0.0/16 --service-cidr=10.96.0.0/12
\`\`\`

### CNI Configuration

\`\`\`yaml
# k8s/calico-config.yaml
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    bgp: Disabled
    ipPools:
    - cidr: 192.168.0.0/16
      encapsulation: VXLANCrossSubnet
      natOutgoing: Enabled
      nodeSelector: all()
\`\`\`

## Monitoring Stack

### Prometheus

\`\`\`yaml
# k8s/prometheus/prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
scrape_configs:
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: true
\`\`\`

### Grafana Dashboards

\`\`\`json
{
  "dashboard": {
    "title": "Cluster Overview",
    "panels": [
      {
        "type": "graph",
        "title": "CPU Usage",
        "targets": [{ "expr": "rate(node_cpu_seconds_total[5m])" }]
      }
    ]
  }
}
\`\`\`

## GitOps with ArgoCD

\`\`\`yaml
# k8s/argocd/application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: nextjs-frontend
spec:
  project: default
  source:
    repoURL: https://github.com/user/repo
    targetRevision: main
    path: k8s/overlays/production
  destination:
    server: https://kubernetes.default.svc
    namespace: frontend
  syncPolicy:
    automated:
      selfHeal: true
      prune: true
\`\`\`

## Helm Values

\`\`\`yaml
# k8s/helm-values/ingress-nginx.yaml
controller:
  service:
    type: LoadBalancer
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: nlb
\`\`\`

## Terraform State

\`\`\`hcl
# terraform/backend.tf
terraform {
  backend "s3" {
    bucket         = "my-tf-state"
    key            = "platform/terraform.tfstate"
    region         = "eu-west-1"
    dynamodb_table = "tf-locks"
  }
}
\`\`\`

## Service Discovery

### CoreDNS Configuration

\`\`\`yaml
# k8s/coredns/corefile
.:53 {
    errors
    health
    kubernetes cluster.local in-addr.arpa ip6.arpa {
       pods insecure
       fallthrough in-addr.arpa ip6.arpa
    }
    forward . /etc/resolv.conf
    cache 30
    loop
    reload
    loadbalance
}
\`\`\`

## Lessons Learned

Key takeaways from the deployment.

## Next Steps

Plans for improvement.
`;

// =============================================================================
// Valid JSON fixture for parseTransformResult
// =============================================================================

/** A valid JSON response from Claude matching the TransformResult schema */
const VALID_TRANSFORM_RESPONSE = JSON.stringify({
    content: '---\ntitle: "Test Article"\n---\n\n## Introduction\n\nThis is a test article.',
    metadata: {
        title: 'Test Article',
        description: 'A test article for unit testing.',
        tags: ['testing', 'devops'],
        slug: 'test-article',
        publishDate: '2026-03-17',
        readingTime: 5,
        category: 'DevOps',
        aiSummary: 'A test article covering testing fundamentals.',
        technicalConfidence: 85,
        processingNote: 'Straightforward test draft.',
    },
    shotList: [],
});

// =============================================================================
// analyseComplexity
// =============================================================================

describe('analyseComplexity', () => {
    it('should classify a short narrative draft as LOW', () => {
        const result = analyseComplexity(LOW_COMPLEXITY_DRAFT);
        expect(result.tier).toBe('LOW');
        expect(result.budgetTokens).toBe(2_048);
        expect(result.reason).toBeDefined();
        expect(result.signals.charCount).toBeGreaterThan(0);
    });

    it('should classify a standard DevOps article as MID', () => {
        const result = analyseComplexity(MID_COMPLEXITY_DRAFT);
        expect(result.tier).toBe('MID');
        expect(result.budgetTokens).toBe(8_192);
    });

    it('should classify a dense IaC article as HIGH', () => {
        const result = analyseComplexity(HIGH_COMPLEXITY_DRAFT);
        expect(result.tier).toBe('HIGH');
        // HIGH budget equals THINKING_BUDGET_TOKENS env var (default 16000)
        expect(result.budgetTokens).toBeGreaterThanOrEqual(8_192);
    });

    it('should return all signal values', () => {
        const result = analyseComplexity(MID_COMPLEXITY_DRAFT);
        expect(result.signals).toEqual(
            expect.objectContaining({
                charCount: expect.any(Number),
                codeBlockCount: expect.any(Number),
                codeRatio: expect.any(Number),
                yamlFrontmatterBlocks: expect.any(Number),
                uniqueHeadingCount: expect.any(Number),
            }),
        );
    });

    it('should handle empty input as LOW', () => {
        const result = analyseComplexity('');
        expect(result.tier).toBe('LOW');
    });

    it('should count YAML/HCL code fences as IaC indicator', () => {
        const result = analyseComplexity(HIGH_COMPLEXITY_DRAFT);
        expect(result.signals.yamlFrontmatterBlocks).toBeGreaterThanOrEqual(4);
    });
});

// =============================================================================
// deriveSlug
// =============================================================================

describe('deriveSlug', () => {
    it('should strip the drafts/ prefix and .md extension', () => {
        expect(deriveSlug(`${DRAFT_PREFIX}deploying-k8s-on-aws.md`))
            .toBe('deploying-k8s-on-aws');
    });

    it('should handle nested paths after the prefix', () => {
        expect(deriveSlug(`${DRAFT_PREFIX}2026/my-article.md`))
            .toBe('2026/my-article');
    });

    it('should handle filenames without spaces', () => {
        expect(deriveSlug(`${DRAFT_PREFIX}simple.md`))
            .toBe('simple');
    });
});

// =============================================================================
// derivePublishedKey
// =============================================================================

describe('derivePublishedKey', () => {
    it('should convert drafts/ prefix to published/ and .md to .mdx', () => {
        expect(derivePublishedKey(`${DRAFT_PREFIX}my-article.md`))
            .toBe('published/my-article.mdx');
    });

    it('should preserve nested paths', () => {
        expect(derivePublishedKey(`${DRAFT_PREFIX}subdir/deep-article.md`))
            .toBe('published/subdir/deep-article.mdx');
    });
});

// =============================================================================
// deriveContentKey
// =============================================================================

describe('deriveContentKey', () => {
    const ISO_TIMESTAMP = '2026-03-17T08:30:00.000Z';

    it('should create a versioned content path with ISO timestamp', () => {
        expect(deriveContentKey(`${DRAFT_PREFIX}my-article.md`, ISO_TIMESTAMP))
            .toBe(`content/v_${ISO_TIMESTAMP}/my-article.mdx`);
    });

    it('should convert .md extension to .mdx', () => {
        const result = deriveContentKey(`${DRAFT_PREFIX}test.md`, ISO_TIMESTAMP);
        expect(result).toMatch(/\.mdx$/);
    });

    it('should include the ISO timestamp in the path for S3/DynamoDB alignment', () => {
        const result = deriveContentKey(`${DRAFT_PREFIX}test.md`, ISO_TIMESTAMP);
        expect(result).toContain(`v_${ISO_TIMESTAMP}`);
    });
});

// =============================================================================
// parseTransformResult
// =============================================================================

describe('parseTransformResult', () => {
    it('should parse a valid JSON response', () => {
        const result = parseTransformResult(VALID_TRANSFORM_RESPONSE);
        expect(result.content).toContain('Test Article');
        expect(result.metadata.title).toBe('Test Article');
        expect(result.metadata.slug).toBe('test-article');
        expect(result.metadata.readingTime).toBe(5);
        expect(result.shotList).toEqual([]);
    });

    it('should handle surrounding text before/after JSON', () => {
        const wrapped = `Here is the output:\n\n${VALID_TRANSFORM_RESPONSE}\n\nDone.`;
        const result = parseTransformResult(wrapped);
        expect(result.metadata.title).toBe('Test Article');
    });

    it('should coerce readingTime from string to number', () => {
        const jsonWithStringTime = JSON.stringify({
            content: '---\ntitle: "Test"\n---\nBody',
            metadata: {
                title: 'Test',
                description: 'Test desc',
                tags: ['test'],
                slug: 'test',
                publishDate: '2026-03-17',
                readingTime: '12',
                category: 'DevOps',
                aiSummary: 'Test summary.',
                technicalConfidence: 90,
            },
            shotList: [],
        });
        const result = parseTransformResult(jsonWithStringTime);
        expect(result.metadata.readingTime).toBe(12);
        expect(typeof result.metadata.readingTime).toBe('number');
    });

    it('should clamp technicalConfidence above 100 to 100', () => {
        const jsonWithHighConfidence = JSON.stringify({
            content: '---\ntitle: "Test"\n---\nBody',
            metadata: {
                title: 'Test',
                description: 'Test desc',
                tags: ['test'],
                slug: 'test',
                publishDate: '2026-03-17',
                readingTime: 5,
                category: 'DevOps',
                aiSummary: 'Test summary.',
                technicalConfidence: 150,
            },
            shotList: [],
        });
        const result = parseTransformResult(jsonWithHighConfidence);
        expect(result.metadata.technicalConfidence).toBe(100);
    });

    it('should clamp technicalConfidence below 0 to 0', () => {
        const json = JSON.stringify({
            content: '---\ntitle: "Test"\n---\nBody',
            metadata: {
                title: 'Test',
                description: 'Test desc',
                tags: ['test'],
                slug: 'test',
                publishDate: '2026-03-17',
                readingTime: 5,
                category: 'DevOps',
                aiSummary: 'Test summary.',
                technicalConfidence: -10,
            },
            shotList: [],
        });
        const result = parseTransformResult(json);
        expect(result.metadata.technicalConfidence).toBe(0);
    });

    it('should throw for input with no JSON object', () => {
        expect(() => parseTransformResult('No JSON here'))
            .toThrow('No JSON object found');
    });

    it('should throw for empty string input', () => {
        expect(() => parseTransformResult(''))
            .toThrow('No JSON object found');
    });

    it('should throw for missing required metadata fields', () => {
        const incompleteJson = JSON.stringify({
            content: 'Some content',
            metadata: { title: 'Only a title' },
            shotList: [],
        });
        expect(() => parseTransformResult(incompleteJson)).toThrow();
    });

    it('should handle control characters inside content (newlines, tabs)', () => {
        const jsonWithControlChars = JSON.stringify({
            content: '---\ntitle: "Test"\n---\n\n## Section\n\n\tIndented code\n```bash\necho "hello"\n```',
            metadata: {
                title: 'Test',
                description: 'Desc',
                tags: ['test'],
                slug: 'test',
                publishDate: '2026-03-17',
                readingTime: 3,
                category: 'DevOps',
                aiSummary: 'Summary.',
                technicalConfidence: 80,
            },
            shotList: [],
        });
        const result = parseTransformResult(jsonWithControlChars);
        expect(result.content).toContain('echo "hello"');
    });

    it('should preserve shotList items', () => {
        const jsonWithShots = JSON.stringify({
            content: '---\ntitle: "Test"\n---\n<ImageRequest id="arch-diagram" type="diagram" instruction="Show architecture" context="Helps reader understand" />',
            metadata: {
                title: 'Test',
                description: 'Desc',
                tags: ['test'],
                slug: 'test',
                publishDate: '2026-03-17',
                readingTime: 5,
                category: 'DevOps',
                aiSummary: 'Summary.',
                technicalConfidence: 88,
            },
            shotList: [
                {
                    id: 'arch-diagram',
                    type: 'diagram',
                    instruction: 'Show architecture',
                    context: 'Helps reader understand',
                },
            ],
        });
        const result = parseTransformResult(jsonWithShots);
        expect(result.shotList).toHaveLength(1);
        expect(result.shotList[0].id).toBe('arch-diagram');
        expect(result.shotList[0].type).toBe('diagram');
    });
});

// =============================================================================
// validateMermaidSyntax
// =============================================================================

describe('validateMermaidSyntax', () => {
    it('should return empty array for content with no MermaidChart components', () => {
        const result = validateMermaidSyntax('# Just a heading\n\nSome text.');
        expect(result).toEqual([]);
    });

    it('should return empty array for valid MermaidChart components', () => {
        const mdx = `
<MermaidChart chart={\`
graph LR
    A["Start"] --> B["End"]
    style A fill:#2d6a4f,color:#fff
\`} />
`;
        const result = validateMermaidSyntax(mdx);
        expect(result).toEqual([]);
    });

    it('should detect empty MermaidChart components', () => {
        const mdx = `<MermaidChart chart={\`\`} />`;
        const result = validateMermaidSyntax(mdx);
        expect(result).toContainEqual('Empty MermaidChart component found');
    });

    it('should detect YAML frontmatter leaked into MermaidChart', () => {
        const mdx = `<MermaidChart chart={\`---
title: Oops
---
graph LR
    A --> B
\`} />`;
        const result = validateMermaidSyntax(mdx);
        expect(result).toContainEqual('YAML frontmatter detected inside MermaidChart component');
    });

    it('should validate multiple MermaidChart components independently', () => {
        const mdx = `
<MermaidChart chart={\`graph LR
    A --> B
\`} />

<MermaidChart chart={\`\`} />
`;
        const result = validateMermaidSyntax(mdx);
        expect(result).toHaveLength(1);
        expect(result[0]).toBe('Empty MermaidChart component found');
    });
});

// =============================================================================
// requireEnv (indirect test via module init)
// =============================================================================

describe('requireEnv (environment validation)', () => {
    it('should have loaded without error when ASSETS_BUCKET and TABLE_NAME are set', () => {
        // If requireEnv failed, the module import would have thrown.
        // This test confirms the module loaded successfully.
        expect(analyseComplexity).toBeDefined();
        expect(deriveSlug).toBeDefined();
    });
});
