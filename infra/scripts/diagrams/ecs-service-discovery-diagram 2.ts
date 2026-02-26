#!/usr/bin/env npx tsx
/**
 * ECS/Prometheus Service Discovery Architecture Diagrams
 *
 * Generates Graphviz DOT diagrams showing:
 * 1. Overall architecture (Next.js ECS ↔ Prometheus EC2)
 * 2. Two-phase discovery flow
 * 3. awsvpc vs host networking comparison
 *
 * Usage: npx tsx scripts/diagrams/ecs-service-discovery-diagram.ts
 * Requires: GraphViz (`dot`) installed locally
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const outputDir = path.join(__dirname, '..', '..', 'docs', 'troubleshooting', 'ecs-prometheus-service-discovery');
fs.mkdirSync(outputDir, { recursive: true });

// ============================================================================
// Helper: Generate a PNG from DOT content
// ============================================================================
function generateDiagram(name: string, dot: string): void {
  const dotFile = path.join(outputDir, `${name}.dot`);
  const pngFile = path.join(outputDir, `${name}.png`);

  fs.writeFileSync(dotFile, dot);
  try {
    execSync(`dot -Tpng -Gdpi=150 -o "${pngFile}" "${dotFile}"`, {
      stdio: 'inherit',
    });
    console.log(`  ✅ ${name}.png generated`);
  } catch {
    console.error(`  ❌ Failed to generate ${name}.png`);
  }
}

// ============================================================================
// AWS Color Palette
// ============================================================================
const AWS = {
  ORANGE: '#FF9900',      // AWS primary
  DARK: '#232F3E',        // AWS dark
  ECS_ORANGE: '#ED7100',  // ECS / Compute
  NETWORK: '#8C4FFF',     // VPC / Networking
  SECURITY: '#DD344C',    // Security / IAM
  SSM: '#E7157B',         // Systems Manager
  STORAGE: '#3F8624',     // S3 / Storage
  EC2_BLUE: '#527FFF',    // EC2
  PROM: '#E6522C',        // Prometheus
  GRAFANA: '#F46800',     // Grafana
};

// ============================================================================
// DIAGRAM 1: Overall Architecture
// ============================================================================
const architectureDot = `
digraph Architecture {
  rankdir=LR;
  compound=true;
  fontname="Helvetica";
  fontsize=14;
  bgcolor="white";
  pad=0.5;
  nodesep=0.5;
  ranksep=1.2;

  node [
    shape=box, style="rounded,filled",
    fontname="Helvetica", fontsize=10,
    fillcolor="#FAFAFA", color="#CCCCCC", penwidth=1.2
  ];
  edge [fontname="Helvetica", fontsize=9, color="#666666"];

  // ======== VPC ========
  subgraph cluster_vpc {
    label="VPC: shared-vpc-development";
    style="rounded,filled"; color="${AWS.DARK}"; fontcolor="${AWS.DARK}";
    fillcolor="#F5F5F5"; fontsize=12;

    // --- Monitoring Instance ---
    subgraph cluster_monitoring {
      label="Monitoring EC2 Instance\\n(i-0940c7c754c389bf7)";
      style="rounded,filled"; color="${AWS.EC2_BLUE}"; fontcolor="${AWS.EC2_BLUE}";
      fillcolor="#F0F4FF"; fontsize=11;

      prometheus [label="Prometheus\\n:9090", fillcolor="${AWS.PROM}", fontcolor="white"];
      grafana [label="Grafana\\n:3000", fillcolor="${AWS.GRAFANA}", fontcolor="white"];
      sd_script [label="ecs-service\\n-discovery.sh\\n(systemd 30s)", fillcolor="${AWS.SSM}", fontcolor="white", shape=cds];
      targets_file [label="file_sd/\\nnextjs-targets.json", fillcolor="#FAFAFA", color="${AWS.PROM}", style="rounded,dashed", fontsize=9];
    }

    // --- ECS Cluster ---
    subgraph cluster_ecs {
      label="ECS: nextjs-cluster-development\\n(EC2 Launch Type)";
      style="rounded,filled"; color="${AWS.ECS_ORANGE}"; fontcolor="${AWS.ECS_ORANGE}";
      fillcolor="#FFF5EB"; fontsize=11;

      ec2_host [label="EC2 Host\\n10.0.0.8\\n(host networking)", fillcolor="${AWS.EC2_BLUE}", fontcolor="white"];

      subgraph cluster_task {
        label="ECS Task (awsvpc)\\nDedicated ENI";
        style="rounded,filled"; color="${AWS.NETWORK}"; fontcolor="${AWS.NETWORK}";
        fillcolor="#F5EEFF"; fontsize=10;

        nextjs_app [label="Next.js App\\n10.0.0.73:3000\\n/api/metrics", fillcolor="${AWS.ECS_ORANGE}", fontcolor="white"];
      }

      node_exp [label="Node Exporter\\n:9100\\n(host networking)", fillcolor="${AWS.STORAGE}", fontcolor="white"];
    }

    // --- AWS APIs ---
    subgraph cluster_aws_api {
      label="AWS APIs";
      style="rounded,filled"; color="${AWS.ORANGE}"; fontcolor="${AWS.ORANGE}";
      fillcolor="#FFFAF0"; fontsize=11;

      ecs_api [label="ECS API\\nlist-tasks\\ndescribe-tasks", fillcolor="${AWS.ECS_ORANGE}", fontcolor="white"];
      ec2_api [label="EC2 API\\ndescribe-network\\n-interfaces", fillcolor="${AWS.EC2_BLUE}", fontcolor="white"];
    }
  }

  // ======== IAM ========
  iam_role [label="IAM Role\\nMonitoring Instance Profile\\necs:ListTasks | ecs:DescribeTasks\\nec2:DescribeNetworkInterfaces", fillcolor="${AWS.SECURITY}", fontcolor="white"];

  // ======== Edges ========
  // Discovery flow
  sd_script -> ecs_api [label="1. List running tasks", color="${AWS.ECS_ORANGE}", style=bold, penwidth=1.5];
  ecs_api -> ec2_api [label="2. Get ENI IDs", color="${AWS.EC2_BLUE}", style=bold, penwidth=1.5];
  ec2_api -> sd_script [label="3. Return private IPs", color="${AWS.EC2_BLUE}", style=dashed];
  sd_script -> targets_file [label="4. Write targets", color="${AWS.PROM}", penwidth=1.5];

  // Prometheus scraping
  prometheus -> targets_file [label="Read (30s refresh)", color="${AWS.PROM}", style=dashed];
  prometheus -> nextjs_app [label="Scrape\\n/api/metrics", color="${AWS.PROM}", style=bold, penwidth=2];
  prometheus -> node_exp [label="Scrape\\n:9100/metrics", color="${AWS.PROM}", style=bold, penwidth=1.5];

  // Grafana
  grafana -> prometheus [label="Query", color="${AWS.GRAFANA}", style=dashed];

  // IAM
  iam_role -> sd_script [label="Assume role", color="${AWS.SECURITY}", style=dashed];

  // Security Groups
  sg_rule [label="SG Rule\\nMonitoring SG → Task SG\\nAllow TCP 3000", shape=diamond, fillcolor="${AWS.SECURITY}", fontcolor="white", fontsize=8];
  sg_rule -> nextjs_app [color="${AWS.SECURITY}", style=dashed];
}
`;

// ============================================================================
// DIAGRAM 2: Two-Phase Discovery Flow
// ============================================================================
const phaseFlowDot = `
digraph PhaseFlow {
  rankdir=TB;
  fontname="Helvetica";
  fontsize=14;
  bgcolor="white";
  pad=0.5;
  nodesep=0.4;
  ranksep=0.6;

  node [
    shape=box, style="rounded,filled",
    fontname="Helvetica", fontsize=10,
    fillcolor="#FAFAFA", color="#CCCCCC", penwidth=1.2
  ];
  edge [fontname="Helvetica", fontsize=9, color="#666666"];

  // ======== Phase 1: Discovery ========
  subgraph cluster_phase1 {
    label="Phase 1: Discovery  (ecs-service-discovery.sh via systemd timer every 30s)";
    style="dashed,rounded"; color="${AWS.ORANGE}"; fontcolor="${AWS.DARK}";
    fontsize=12; bgcolor="#FFFAF0"; penwidth=2;

    timer [label="systemd\\necs-sd.timer\\n(OnUnitActiveSec=30s)", shape=cds, fillcolor="${AWS.SSM}", fontcolor="white"];
    list_tasks [label="aws ecs list-tasks\\n--cluster nextjs-cluster-dev\\n--service nextjs-service-dev\\n--desired-status RUNNING", fillcolor="${AWS.ECS_ORANGE}", fontcolor="white"];
    desc_tasks [label="aws ecs describe-tasks\\n--tasks arn:aws:ecs:...", fillcolor="${AWS.ECS_ORANGE}", fontcolor="white"];
    desc_eni [label="aws ec2 describe-network-interfaces\\n--network-interface-ids eni-...", fillcolor="${AWS.EC2_BLUE}", fontcolor="white"];
    write_json [label="Write JSON\\n[ { targets: [10.0.0.73:3000] } ]", fillcolor="${AWS.STORAGE}", fontcolor="white"];
    atomic_mv [label="mv targets.json.tmp\\ntargets.json\\n(atomic swap)", fillcolor="#FAFAFA", color="${AWS.PROM}"];

    timer -> list_tasks [label="1", color="${AWS.ORANGE}", style=bold];
    list_tasks -> desc_tasks [label="2  task ARNs", color="${AWS.ECS_ORANGE}", style=bold];
    desc_tasks -> desc_eni [label="3  ENI IDs", color="${AWS.EC2_BLUE}", style=bold];
    desc_eni -> write_json [label="4  private IPs", color="${AWS.EC2_BLUE}", style=bold];
    write_json -> atomic_mv [label="5", style=bold];
  }

  // ======== Phase 2: Scrape ========
  subgraph cluster_phase2 {
    label="Phase 2: Scrape  (Prometheus file_sd_configs, refresh_interval: 30s)";
    style="dashed,rounded"; color="${AWS.PROM}"; fontcolor="${AWS.DARK}";
    fontsize=12; bgcolor="#FFF5F0"; penwidth=2;

    prom_read [label="Prometheus reads\\nfile_sd/nextjs-targets.json", fillcolor="${AWS.PROM}", fontcolor="white"];
    prom_target [label="Update target list\\n10.0.0.73:3000", fillcolor="${AWS.PROM}", fontcolor="white"];
    prom_scrape [label="GET http://10.0.0.73:3000/api/metrics\\n(via task ENI private IP)", fillcolor="${AWS.PROM}", fontcolor="white"];
    nextjs [label="Next.js App\\n(prom-client)\\nReturns metrics", fillcolor="${AWS.ECS_ORANGE}", fontcolor="white"];
    grafana_vis [label="Grafana\\nDashboard\\nVisualization", fillcolor="${AWS.GRAFANA}", fontcolor="white"];

    prom_read -> prom_target [label="6", color="${AWS.PROM}", style=bold];
    prom_target -> prom_scrape [label="7", color="${AWS.PROM}", style=bold];
    prom_scrape -> nextjs [label="8  HTTP GET", color="${AWS.PROM}", style=bold, penwidth=2];
    nextjs -> prom_scrape [label="metrics payload", color="${AWS.ECS_ORANGE}", style=dashed];
    prom_scrape -> grafana_vis [label="9  PromQL", color="${AWS.GRAFANA}", style=dashed];
  }

  // Phase link
  atomic_mv -> prom_read [label="file on disk", color="#888888", style=dashed, penwidth=1.5];
}
`;

// ============================================================================
// DIAGRAM 3: awsvpc vs host Networking Context
// ============================================================================
const networkingDot = `
digraph Networking {
  rankdir=TB;
  fontname="Helvetica";
  fontsize=14;
  bgcolor="white";
  pad=0.5;
  nodesep=0.5;
  ranksep=0.8;

  node [
    shape=box, style="rounded,filled",
    fontname="Helvetica", fontsize=10,
    fillcolor="#FAFAFA", color="#CCCCCC", penwidth=1.2
  ];
  edge [fontname="Helvetica", fontsize=9, color="#666666"];

  // ======== awsvpc Mode (Current) ========
  subgraph cluster_awsvpc {
    label="awsvpc Mode (Current Architecture)\\nEach task gets its own ENI + private IP";
    style="rounded,filled"; color="${AWS.NETWORK}"; fontcolor="${AWS.NETWORK}";
    fillcolor="#F5EEFF"; fontsize=12; penwidth=2;

    subgraph cluster_awsvpc_host {
      label="EC2 Instance\\nIP: 10.0.0.8";
      style="rounded,filled"; color="${AWS.EC2_BLUE}"; fontcolor="${AWS.EC2_BLUE}";
      fillcolor="#F0F4FF"; fontsize=10;

      awsvpc_agent [label="ECS Agent", fillcolor="${AWS.EC2_BLUE}", fontcolor="white"];

      subgraph cluster_awsvpc_task {
        label="Task ENI (separate network namespace)\\nIP: 10.0.0.73  |  SG: sg-05c42951fda6b858e";
        style="rounded,dashed"; color="${AWS.NETWORK}"; fontcolor="${AWS.NETWORK}";
        fillcolor="#EDE4FF"; fontsize=9; penwidth=2;

        awsvpc_app [label="Next.js\\n:3000", fillcolor="${AWS.ECS_ORANGE}", fontcolor="white"];
      }
    }

    awsvpc_prom [label="Prometheus\\n(monitoring instance)", fillcolor="${AWS.PROM}", fontcolor="white"];
    awsvpc_prom -> awsvpc_app [label="Scrape 10.0.0.73:3000 ✅\\n(via ENI IP from file_sd)", color="${AWS.PROM}", style=bold, penwidth=2];
    awsvpc_note [label="✅ Task-level SG  ✅ No port conflicts\\n✅ ALB compatible  ✅ Fargate compatible", shape=note, fillcolor="#F0FFF0", color="${AWS.STORAGE}"];
  }

  // ======== host Mode (Alternative) ========
  subgraph cluster_host {
    label="host Mode (Alternative)\\nTask shares EC2 host network stack";
    style="rounded,filled"; color="#888888"; fontcolor="#888888";
    fillcolor="#F5F5F5"; fontsize=12;

    subgraph cluster_host_ec2 {
      label="EC2 Instance\\nIP: 10.0.0.8";
      style="rounded,filled"; color="${AWS.EC2_BLUE}"; fontcolor="${AWS.EC2_BLUE}";
      fillcolor="#F0F4FF"; fontsize=10;

      host_agent [label="ECS Agent", fillcolor="${AWS.EC2_BLUE}", fontcolor="white"];
      host_app [label="Next.js\\n:3000\\n(binds to host)", fillcolor="${AWS.ECS_ORANGE}", fontcolor="white"];
    }

    host_prom [label="Prometheus\\n(monitoring instance)", fillcolor="${AWS.PROM}", fontcolor="white"];
    host_prom -> host_app [label="Scrape 10.0.0.8:3000\\n(host IP = task IP)", color="#888888"];
    host_note [label="❌ No task-level SG  ❌ Port conflicts\\n❌ Only 1 task per port per host🔶 Simpler discovery (host IP = task IP)", shape=note, fillcolor="#FFF0F0", color="${AWS.SECURITY}"];
  }
}
`;

// ============================================================================
// Generate all diagrams
// ============================================================================
console.log('\n🎨 Generating ECS Service Discovery diagrams...\n');
generateDiagram('ecs-service-discovery-architecture', architectureDot);
generateDiagram('ecs-service-discovery-phase-flow', phaseFlowDot);
generateDiagram('ecs-awsvpc-vs-host-networking', networkingDot);
console.log('\n✅ All diagrams generated!\n');
