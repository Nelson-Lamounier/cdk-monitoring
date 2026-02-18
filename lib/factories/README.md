# Project Factory Pattern

This document describes the Project Factory pattern used in the `cdk-monitoring` project for creating and managing multi-project CDK infrastructure.

## Overview

The factory pattern provides a consistent interface for creating project-specific stacks while sharing common infrastructure (like VPC). Each project implements the `IProjectFactory` interface to create its stacks.

```
┌─────────────────────────────────────────────────────────────────┐
│                          app.ts                                  │
│  - Parse context (project, environment)                         │
│  - Get project factory from registry                            │
│  - Create shared infrastructure (VPC)                           │
│  - Call factory.createAllStacks()                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Project Registry                             │
│  projectFactoryRegistry = {                                      │
│    [Project.MONITORING]: MonitoringProjectFactory,              │
│    [Project.NEXTJS]:     NextJSProjectFactory,                  │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌────────────────────────┐     ┌────────────────────────┐
│ MonitoringProjectFactory│     │  NextJSProjectFactory  │
├────────────────────────┤     ├────────────────────────┤
│ - SecurityGroupStack   │     │ - EcrStack             │
│ - EbsStack             │     │ - EcsClusterStack      │
│ - ComputeStack         │     │ (uses shared VPC)      │
│ - EbsLifecycleStack*   │     └────────────────────────┘
│ (* ASG mode only)      │
└────────────────────────┘
```

## Directory Structure

```
lib/
├── factories/                    # Core factory infrastructure
│   ├── index.ts                  # Barrel export
│   ├── project-interfaces.ts     # Core interfaces
│   └── project-registry.ts       # Factory registry & lookup
│
├── projects/                     # Project implementations
│   ├── monitoring/
│   │   ├── factory.ts            # MonitoringProjectFactory
│   │   └── index.ts
│   └── nextjs/
│       ├── factory.ts            # NextJSProjectFactory
│       └── index.ts
│
└── stacks/                       # Stack implementations
    ├── monitoring/               # Modular monitoring stacks
    │   ├── security-group-stack.ts
    │   ├── ebs-stack.ts
    │   ├── compute-stack.ts
    │   ├── ebs-lifecycle-stack.ts
    │   └── index.ts
    └── nextjs/
        ├── ecr-stack.ts
        ├── ecs-cluster-stack.ts
        └── index.ts
```

---

## Core Interfaces

### IProjectFactory

The main interface that all project factories must implement:

```typescript
interface IProjectFactory {
  /** The project this factory creates stacks for */
  readonly project: Project;

  /** The target environment */
  readonly environment: Environment;

  /** The namespace prefix for stack names */
  readonly namespace: string;

  /**
   * Create all stacks for this project.
   */
  createAllStacks(
    scope: cdk.App,
    context: ProjectFactoryContext,
  ): ProjectStackFamily;
}
```

### ProjectFactoryContext

Context passed to factories containing shared infrastructure and configuration:

```typescript
interface ProjectFactoryContext {
  /** Target environment */
  readonly environment: Environment;

  /** Shared infrastructure (VPC) */
  readonly shared: SharedInfrastructure;

  /** Trusted CIDRs for security groups */
  readonly trustedCidrs: string[];

  /** Additional project-specific configuration */
  readonly [key: string]: unknown;
}
```

### ProjectStackFamily

Return type from `createAllStacks()`:

```typescript
interface ProjectStackFamily {
  /** All stacks created by the factory */
  readonly stacks: cdk.Stack[];

  /** Map of stack name to stack instance */
  readonly stackMap: Record<string, cdk.Stack>;
}
```

---

## Using the Factory Pattern

### From CDK Context

The typical usage in `app.ts`:

```typescript
import { getProjectFactoryFromContext } from './lib/factories';

const app = new cdk.App();

// Get context values
const projectStr = app.node.tryGetContext('project');      // e.g., 'monitoring'
const environmentStr = app.node.tryGetContext('environment'); // e.g., 'dev'

// Get factory from registry
const factory = getProjectFactoryFromContext(projectStr, environmentStr);

// Create shared infrastructure
const vpcStack = new SharedVpcStack(app, 'Shared-VpcStack-dev', { ... });

// Create project stacks
const { stacks, stackMap } = factory.createAllStacks(app, {
    environment: factory.environment,
    shared: { vpc: vpcStack.vpc },
    trustedCidrs: ['10.0.0.0/8'],
    // Project-specific config
    grafanaPassword: 'secret',
    computeMode: ComputeMode.SINGLE_INSTANCE,
});
```

### Programmatically

```typescript
import { getProjectFactory } from "./lib/factories";
import { Project } from "./lib/config/projects";
import { Environment } from "./lib/config/environments";

// Get factory by enum values
const factory = getProjectFactory(Project.MONITORING, Environment.PROD);

// Create stacks
const result = factory.createAllStacks(app, context);

// Access specific stacks
const computeStack = result.stackMap.compute;
```

---

## Implementing a New Project Factory

### Step 1: Add Project to Config

In `lib/config/projects.ts`:

```typescript
export enum Project {
  MONITORING = "monitoring",
  NEXTJS = "nextjs",
  MY_NEW_PROJECT = "my-new-project", // Add new project
}

// Add project configuration
const projectConfigs: Record<Project, ProjectConfig> = {
  // ...existing projects...
  [Project.MY_NEW_PROJECT]: {
    namespace: "MyNewProject",
    description: "Description of my new project",
  },
};
```

### Step 2: Create Stacks

Create stacks in `lib/stacks/my-new-project/`:

```typescript
// lib/stacks/my-new-project/my-stack.ts
export class MyNewStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MyNewStackProps) {
    super(scope, id, props);
    // ... stack resources
  }
}

// lib/stacks/my-new-project/index.ts
export * from "./my-stack";
```

### Step 3: Create Factory

Create factory in `lib/projects/my-new-project/`:

```typescript
// lib/projects/my-new-project/factory.ts
import {
  IProjectFactory,
  ProjectFactoryContext,
  ProjectStackFamily,
} from "../../factories";
import { Project, getProjectConfig } from "../../config/projects";
import { Environment } from "../../config/environments";
import { MyNewStack } from "../../stacks/my-new-project";

export class MyNewProjectFactory implements IProjectFactory {
  readonly project = Project.MY_NEW_PROJECT;
  readonly environment: Environment;
  readonly namespace: string;

  constructor(environment: Environment) {
    this.environment = environment;
    this.namespace = getProjectConfig(Project.MY_NEW_PROJECT).namespace;
  }

  private stackId(resource: string): string {
    return `${this.namespace}-${resource}Stack-${this.environment}`;
  }

  createAllStacks(
    scope: cdk.App,
    context: ProjectFactoryContext,
  ): ProjectStackFamily {
    const env = {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    };

    const myStack = new MyNewStack(scope, this.stackId("Main"), {
      vpc: context.shared.vpc,
      env,
    });

    return {
      stacks: [myStack],
      stackMap: { main: myStack },
    };
  }
}

// lib/projects/my-new-project/index.ts
export * from "./factory";
```

### Step 4: Register Factory

In `lib/factories/project-registry.ts`:

```typescript
import { MyNewProjectFactory } from "../projects/my-new-project";

const projectFactoryRegistry: Record<Project, ProjectFactoryConstructor> = {
  [Project.MONITORING]: MonitoringProjectFactory,
  [Project.NEXTJS]: NextJSProjectFactory,
  [Project.MY_NEW_PROJECT]: MyNewProjectFactory, // Add here
};
```

### Step 5: Use With CDK

```bash
# List stacks
cdk list -c project=my-new-project -c environment=dev

# Deploy
cdk deploy --all -c project=my-new-project -c environment=dev
```

---

## Existing Factories

### MonitoringProjectFactory

Creates Grafana/Prometheus monitoring infrastructure.

| Stack                | Description                                     |
| -------------------- | ----------------------------------------------- |
| `SecurityGroupStack` | Network access rules (Grafana, Prometheus, SSH) |
| `EbsStack`           | Encrypted EBS volume for data persistence       |
| `ComputeStack`       | EC2 instance or ASG for monitoring services     |
| `EbsLifecycleStack`  | Lambda + EventBridge for auto-detach (ASG only) |

**Context Options:**

```typescript
{
    grafanaPassword: string,    // Grafana admin password
    computeMode: ComputeMode,   // SINGLE_INSTANCE or AUTO_SCALING
}
```

**Stack Count:**

- Single Instance Mode: 3 stacks (SG + EBS + Compute)
- Auto Scaling Mode: 4 stacks (SG + EBS + Compute + Lifecycle)

### NextJSProjectFactory

Creates infrastructure for Next.js web application.

| Stack             | Description                         |
| ----------------- | ----------------------------------- |
| `EcrStack`        | ECR repository for container images |
| `EcsClusterStack` | ECS Fargate cluster with ALB        |

**Context Options:**

```typescript
{
  // Uses shared VPC from Monitoring project
}
```

---

## Registry Functions

### getProjectFactory

Get factory by enum values:

```typescript
const factory = getProjectFactory(Project.MONITORING, Environment.DEV);
```

### getProjectFactoryFromContext

Get factory from string context values (used in app.ts):

```typescript
const factory = getProjectFactoryFromContext("monitoring", "dev");
```

### hasProjectFactory

Check if a factory exists:

```typescript
if (hasProjectFactory(Project.MY_PROJECT)) {
  // Factory is registered
}
```

### registerProjectFactory

Dynamically register a factory (useful for extensions):

```typescript
registerProjectFactory(Project.CUSTOM, CustomProjectFactory);
```

---

## Best Practices

### 1. Stack Naming Convention

Use consistent stack IDs: `{Namespace}-{Resource}Stack-{environment}`

```typescript
private stackId(resource: string): string {
    return `${this.namespace}-${resource}Stack-${this.environment}`;
}
// Output: "Monitoring-ComputeStack-dev"
```

### 2. Dependency Management

Explicitly declare stack dependencies:

```typescript
const sgStack = new SecurityGroupStack(...);
const ebsStack = new EbsStack(...);
ebsStack.addDependency(sgStack);

const computeStack = new ComputeStack(...);
computeStack.addDependency(ebsStack);
```

### 3. Cross-Stack References

Pass values through stack props, not exports:

```typescript
// Good: Pass security group directly
const computeStack = new ComputeStack(scope, id, {
  securityGroup: sgStack.securityGroup,
});

// Avoid: Relying on CloudFormation exports
```

### 4. Environment-Specific Configuration

Use environment to determine configuration:

```typescript
createEncryptionKey: this.environment === Environment.PROD,
allowSsh: this.environment !== Environment.PROD,
```

### 5. Logging

Log created stacks for visibility:

```typescript
console.log(`Factory created ${stacks.length} stacks:`);
stacks.forEach((s) => console.log(`  - ${s.stackName}`));
```

---

## Troubleshooting

### "Unknown project" Error

Ensure the project is registered in `project-registry.ts`:

```typescript
const projectFactoryRegistry: Record<Project, ProjectFactoryConstructor> = {
  [Project.MONITORING]: MonitoringProjectFactory,
  [Project.NEXTJS]: NextJSProjectFactory,
  // Missing project here?
};
```

### "Invalid environment" Error

Use valid environment values: `dev`, `staging`, `prod`

```bash
# Wrong
cdk list -c project=monitoring -c environment=development

# Correct
cdk list -c project=monitoring -c environment=dev
```

### Missing Shared Infrastructure

Ensure VPC is created before calling factory:

```typescript
// Create VPC first
const vpcStack = new SharedVpcStack(app, 'VpcStack', { ... });

// Then pass to factory
factory.createAllStacks(app, {
    shared: { vpc: vpcStack.vpc },  // Must have VPC
    ...
});
```
