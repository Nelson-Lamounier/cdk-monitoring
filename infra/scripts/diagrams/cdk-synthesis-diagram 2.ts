#!/usr/bin/env npx tsx
/**
 * CDK Full-App Synthesis Architecture Diagram
 *
 * Generates a Graphviz DOT diagram showing how CDK synthesizes
 * all 6 NextJS stacks and deploys them individually.
 *
 * Usage: npx tsx scripts/diagrams/cdk-synthesis-diagram.ts
 * Requires: GraphViz (`dot`) installed locally
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const outputDir = path.join(__dirname, '..', '..', 'docs', 'diagrams');
const outputFile = path.join(outputDir, 'cdk-nextjs-synthesis.png');

// ============================================================================
// DOT Graph Definition
// ============================================================================

const dot = `
digraph CDKSynthesis {
  // Global settings
  rankdir=TB;
  compound=true;
  fontname="Helvetica";
  fontsize=14;
  bgcolor="white";
  pad=0.5;
  nodesep=0.6;
  ranksep=0.8;
  
  // Default node style
  node [
    shape=box,
    style="rounded,filled",
    fontname="Helvetica",
    fontsize=10,
    fillcolor="#FAFAFA",
    color="#CCCCCC",
    penwidth=1.2
  ];
  
  // Default edge style
  edge [
    fontname="Helvetica",
    fontsize=9,
    color="#666666"
  ];

  // ========================================================================
  // PHASE 1: CDK SYNTHESIS
  // ========================================================================
  subgraph cluster_synthesis {
    label="Phase 1: CDK Synthesis  —  app.ts → factory.createAllStacks()\\nALL 6 stacks synthesized on every cdk deploy command";
    style="dashed,rounded";
    color="#FF9900";
    fontcolor="#232F3E";
    fontsize=13;
    bgcolor="#FFFAF0";
    penwidth=2;
    
    // ------ Stack 1: Data ------
    subgraph cluster_data {
      label="Stack 1: Data\\n(eu-west-1)";
      style="rounded,filled";
      color="#3F8624";
      fontcolor="#3F8624";
      fillcolor="#F0FFF0";
      fontsize=11;
      
      ecr [label="ECR\\nRepository", fillcolor="#ED7100", fontcolor="white"];
      dynamodb [label="DynamoDB\\nArticles Table", fillcolor="#527FFF", fontcolor="white"];
      s3 [label="S3 Static\\nAssets Bucket", fillcolor="#3F8624", fontcolor="white"];
      ssm_data [label="SSM\\nParameters", fillcolor="#E7157B", fontcolor="white"];
    }
    
    // ------ Stack 2: Compute ------
    subgraph cluster_compute {
      label="Stack 2: Compute\\n(eu-west-1)";
      style="rounded,filled";
      color="#3F8624";
      fontcolor="#3F8624";
      fillcolor="#F0FFF0";
      fontsize=11;
      
      ecs_cluster [label="ECS\\nCluster", fillcolor="#ED7100", fontcolor="white"];
      asg [label="Auto Scaling\\nGroup", fillcolor="#ED7100", fontcolor="white"];
      launch_tpl [label="Launch\\nTemplate", fillcolor="#ED7100", fontcolor="white"];
    }
    
    // ------ Stack 3: Networking ------
    subgraph cluster_networking {
      label="Stack 3: Networking\\n(eu-west-1)";
      style="rounded,filled";
      color="#3F8624";
      fontcolor="#3F8624";
      fillcolor="#F0FFF0";
      fontsize=11;
      
      alb [label="Application\\nLoad Balancer", fillcolor="#8C4FFF", fontcolor="white"];
      tg [label="Target\\nGroup", fillcolor="#8C4FFF", fontcolor="white"];
      sg [label="Security\\nGroups", fillcolor="#DD344C", fontcolor="white"];
    }
    
    // ------ Stack 4: Application ------
    subgraph cluster_application {
      label="Stack 4: Application\\n(eu-west-1)";
      style="rounded,filled";
      color="#3F8624";
      fontcolor="#3F8624";
      fillcolor="#F0FFF0";
      fontsize=11;
      
      ecs_service [label="ECS\\nService", fillcolor="#ED7100", fontcolor="white"];
      task_def [label="Task\\nDefinition", fillcolor="#ED7100", fontcolor="white"];
    }
    
    // ------ Stack 5: API ------
    subgraph cluster_api {
      label="Stack 5: API\\n(eu-west-1)";
      style="rounded,filled";
      color="#3F8624";
      fontcolor="#3F8624";
      fillcolor="#F0FFF0";
      fontsize=11;
      
      apigw [label="API\\nGateway", fillcolor="#8C4FFF", fontcolor="white"];
      lambda [label="Lambda\\nFunctions", fillcolor="#ED7100", fontcolor="white"];
    }
    
    // ------ Stack 6: Edge (REQUIRED CONTEXT) ------
    subgraph cluster_edge {
      label="Stack 6: Edge (us-east-1)  ⚡ REQUIRES CONTEXT\\ndomainName · hostedZoneId · crossAccountRoleArn";
      style="rounded,bold,filled";
      color="#D13212";
      fontcolor="#D13212";
      fillcolor="#FFF0F0";
      fontsize=11;
      penwidth=2.5;
      
      cloudfront [label="CloudFront\\nDistribution", fillcolor="#8C4FFF", fontcolor="white"];
      acm [label="ACM\\nCertificate", fillcolor="#DD344C", fontcolor="white"];
      waf [label="WAF\\nWebACL", fillcolor="#DD344C", fontcolor="white"];
    }
  }

  // ========================================================================
  // CROSS-ACCOUNT DNS (Root Account)
  // ========================================================================
  subgraph cluster_root {
    label="Root Account (711387127421)\\nCross-Account DNS Access";
    style="rounded,filled";
    color="#232F3E";
    fontcolor="#232F3E";
    fillcolor="#F5F5F5";
    fontsize=11;
    
    dns_role [label="IAM Role\\nRoute53DnsValidation", fillcolor="#DD344C", fontcolor="white"];
    route53 [label="Route53\\nHosted Zone", fillcolor="#8C4FFF", fontcolor="white"];
  }

  // ========================================================================
  // PHASE 2: CDK DEPLOY
  // ========================================================================
  subgraph cluster_deploy {
    label="Phase 2: cdk deploy  —  CloudFormation deploys ONLY the selected stack";
    style="dashed,rounded";
    color="#1A8A1A";
    fontcolor="#232F3E";
    fontsize=13;
    bgcolor="#F0FFF0";
    penwidth=2;
    
    cfn [label="CloudFormation\\nDeploy Target\\n(single stack)", fillcolor="#E7157B", fontcolor="white", penwidth=2];
  }

  // ========================================================================
  // CONTEXT FLOW (GitHub → CDK)
  // ========================================================================
  subgraph cluster_context {
    label="GitHub Actions Context Flow";
    style="rounded,filled";
    color="#FF9900";
    fontcolor="#232F3E";
    fillcolor="#FFF8F0";
    fontsize=11;
    
    gh_vars [label="GitHub\\nRepository Variables\\n(vars.*)", fillcolor="#24292F", fontcolor="white"];
    caller [label="Caller Workflow\\ndeploy-nextjs-dev.yml\\n(with: inputs)", fillcolor="#24292F", fontcolor="white"];
    reusable [label="Reusable Workflow\\n_deploy-nextjs.yml\\n(inputs → additional-context)", fillcolor="#24292F", fontcolor="white"];
    deploy_stack [label="_deploy-stack.yml\\nadditional-context →\\n-c domainName=... ", fillcolor="#24292F", fontcolor="white"];
  }

  // ========================================================================
  // EDGES: Infrastructure Relationships
  // ========================================================================
  
  // Data → Application
  ecr -> task_def [label="Image URI", color="#3F8624", style=bold];
  
  // Compute
  ecs_cluster -> asg [color="#3F8624"];
  asg -> launch_tpl [color="#3F8624"];
  
  // Networking → Application
  alb -> tg [color="#3F8624"];
  tg -> ecs_service [label="Routes traffic", color="#8C4FFF", style=bold];
  sg -> alb [color="#DD344C", style=dashed];
  
  // Application
  ecs_service -> task_def [color="#3F8624"];
  
  // API
  dynamodb -> lambda [label="CRUD", color="#527FFF", style=dashed];
  apigw -> lambda [color="#8C4FFF"];
  
  // Edge → Origin
  cloudfront -> alb [label="Origin\\n(dynamic)", color="#D13212", style=bold, penwidth=2];
  cloudfront -> s3 [label="Origin\\n(static assets)", color="#D13212", style=dashed];
  waf -> cloudfront [label="Protects", color="#DD344C"];
  
  // Edge → Root Account DNS
  acm -> dns_role [label="DNS Validation\\n(cross-account)", color="#D13212", style=dashed, penwidth=1.5];
  dns_role -> route53 [color="#232F3E"];
  
  // Deploy phase
  cfn -> alb [label="--exclusively", color="#1A8A1A", style=bold, penwidth=2, lhead=cluster_networking];

  // ========================================================================
  // EDGES: Context Flow
  // ========================================================================  
  gh_vars -> caller [label="DOMAIN_NAME\\nHOSTED_ZONE_ID\\nDNS_VALIDATION_ROLE", color="#FF9900", style=bold];
  caller -> reusable [label="with: + secrets:", color="#FF9900"];
  reusable -> deploy_stack [label="additional-context\\nJSON", color="#FF9900"];
  deploy_stack -> cloudfront [label="-c domainName=...\\n-c hostedZoneId=...\\n-c crossAccountRoleArn=...", color="#D13212", style=bold, lhead=cluster_edge];
}
`;

// ============================================================================
// Generate PNG via GraphViz
// ============================================================================

// Ensure output directory exists
fs.mkdirSync(outputDir, { recursive: true });

// Write DOT file for reference
const dotFile = path.join(outputDir, 'cdk-nextjs-synthesis.dot');
fs.writeFileSync(dotFile, dot);

try {
  execSync(`dot -Tpng -Gdpi=150 -o "${outputFile}" "${dotFile}"`, {
    stdio: 'inherit',
  });

  console.log(`\n✅ Diagram generated successfully!`);
  console.log(`   PNG: ${outputFile}`);
  console.log(`   DOT: ${dotFile}`);
} catch (_error) {
  console.error('❌ Failed to generate diagram. Is GraphViz installed?');
  console.error('   Install: brew install graphviz');
  process.exit(1);
}
