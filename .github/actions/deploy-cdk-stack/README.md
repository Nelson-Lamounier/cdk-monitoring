# Deploy CDK Stack

Simplified composite action for deploying AWS CDK stacks with inline validation and flexible context passing.

## Purpose

This action provides a clean, reusable interface for CDK stack deployments with:
- Inline input validation (no external scripts)
- Flexible context passing via JSON
- AWS credential verification
- CDK bootstrap checks
- Stack output retrieval

## Features

- Input validation with helpful error messages
- AWS credential and account verification
- Optional CDK bootstrap validation
- Dynamic CDK context building from JSON
- Deployment status tracking
- CloudFormation stack output retrieval
- No project-specific dependencies

## Usage

### Basic Usage

```yaml
- name: Deploy NetworkingStack
  uses: ./.github/actions/deploy-cdk-stack
  with:
    stack-name: "NetworkingStack-monitoring-development"
    environment: "development"
    aws-account-id: ${{ vars.AWS_ACCOUNT_ID_DEV }}
    aws-region: "eu-west-1"
```

### With Additional Context

```yaml
- name: Deploy with VPC Peering Context
  uses: ./.github/actions/deploy-cdk-stack
  with:
    stack-name: "VpcPeeringStack-monitoring-development"
    environment: "development"
    aws-account-id: ${{ vars.AWS_ACCOUNT_ID_DEV }}
    aws-region: "eu-west-1"
    additional-context: '{"devVpcId":"vpc-123456","devAccountId":"123456789012"}'
```

### With Custom CDK Arguments

```yaml
- name: Deploy with Hotswap
  uses: ./.github/actions/deploy-cdk-stack
  with:
    stack-name: "EcsStack-monitoring-development"
    environment: "development"
    aws-account-id: ${{ vars.AWS_ACCOUNT_ID_DEV }}
    aws-region: "eu-west-1"
    additional-args: "--hotswap --require-approval never"
```

### Skip Bootstrap Verification

```yaml
- name: Deploy Without Bootstrap Check
  uses: ./.github/actions/deploy-cdk-stack
  with:
    stack-name: "TestStack-monitoring-development"
    environment: "development"
    aws-account-id: ${{ vars.AWS_ACCOUNT_ID_DEV }}
    aws-region: "eu-west-1"
    verify-bootstrap: "false"
```

### With Output Handling

```yaml
- name: Deploy and Capture Outputs
  id: deploy
  uses: ./.github/actions/deploy-cdk-stack
  with:
    stack-name: "NetworkingStack-monitoring-development"
    environment: "development"
    aws-account-id: ${{ vars.AWS_ACCOUNT_ID_DEV }}
    aws-region: "eu-west-1"

- name: Use Stack Outputs
  run: |
    echo "Deployment Status: ${{ steps.deploy.outputs.deployment-status }}"
    echo "Stack Outputs: ${{ steps.deploy.outputs.stack-outputs }}"
```

## Inputs

| Input                         | Description                                      | Required | Default                       |
| ----------------------------- | ------------------------------------------------ | -------- | ----------------------------- |
| `stack-name`                  | Name of the CDK stack to deploy (should include project context) | Yes | -                    |
| `environment`                 | Target environment (development, staging, production) | Yes | -                       |
| `aws-account-id`              | Target AWS Account ID (12 digits)                | Yes      | -                             |
| `aws-region`                  | AWS Region (e.g., eu-west-1)                     | Yes      | -                             |
| `additional-context`          | Additional CDK context as JSON object            | No       | `{}`                          |
| `additional-args`             | Additional CDK deploy arguments (excluding --require-approval) | No | `""`                |
| `require-approval`            | CDK approval requirement (never, any-change, broadening) | No  | `never`                      |
| `verify-bootstrap`            | Verify CDK bootstrap before deployment           | No       | `false`                       |
| `outputs-directory`           | Directory to save stack outputs (optional)       | No       | `""`                          |

## Outputs

| Output              | Description                                    |
| ------------------- | ---------------------------------------------- |
| `deployment-status` | Status of deployment (`success` or `failure`)  |
| `stack-outputs`     | CloudFormation stack outputs as JSON string    |

## Validation

### Input Validation

The action validates:

1. **Stack Name**: Must not be empty
2. **Environment**: Must be one of: `development`, `staging`, `production`
3. **AWS Account ID**: Must be 12-digit number
4. **AWS Region**: Must match format `xx-xxxx-#` (e.g., `eu-west-1`)
5. **Additional Context**: Must be valid JSON

Note: This action is designed for deploying to target environments. For CI/CD pipeline validation (e.g., CDK synth in CI), use `npx cdk synth` directly in your workflow instead of this action.

### AWS Validation

The action verifies:

1. AWS credentials are configured
2. Can retrieve caller identity via `sts:GetCallerIdentity`
3. Warns if current account differs from target (cross-account scenario)

### CDK Bootstrap Validation

Unless skipped, the action checks:

1. CDKToolkit stack exists in target account/region
2. Stack status contains "COMPLETE" (e.g., CREATE_COMPLETE, UPDATE_COMPLETE)

## Context Building

The action builds CDK context from:

1. **Base Context** (always included):
   - `environment`: From input
   - `project`: From input

2. **Additional Context** (from `additional-context` input):
   - Parsed from JSON
   - Converted to `--context key=value` arguments

### Example Context Building

Input:
```yaml
additional-context: '{"devVpcId":"vpc-123","enableMonitoring":"true","retentionDays":"7"}'
```

Generates:
```bash
--context environment=development \
--context project=monitoring \
--context devVpcId=vpc-123 \
--context enableMonitoring=true \
--context retentionDays=7
```

## Migration Guide

### From Old Version (With Project-Specific Inputs)

**Before:**
```yaml
- name: Deploy NetworkingStack
  uses: ./.github/actions/deploy-cdk-stack
  with:
    stack-name: "NetworkingStack-monitoring-development"
    environment: "development"
    project-name: "monitoring"
    aws-account-id: ${{ needs.validate-setup.outputs.target_account_id }}
    aws-region: "eu-west-1"
    dev-vpc-id: ${{ needs.validate-setup.outputs.dev_vpc_id }}
    dev-account-id: ${{ vars.AWS_ACCOUNT_ID_DEV }}
```

**After:**
```yaml
- name: Deploy NetworkingStack
  uses: ./.github/actions/deploy-cdk-stack
  with:
    stack-name: "NetworkingStack-monitoring-development"
    environment: "development"
    aws-account-id: ${{ needs.validate-setup.outputs.target_account_id }}
    aws-region: "eu-west-1"
    additional-context: '{"devVpcId":"${{ needs.validate-setup.outputs.dev_vpc_id }}","devAccountId":"${{ vars.AWS_ACCOUNT_ID_DEV }}"}'
```

### From External Scripts

**Before:**
```yaml
- name: Validate Environment
  run: npx tsx scripts/deployment/validate-environment.ts ...

- name: Deploy Stack
  run: npx tsx scripts/deployment/deploy-stack.ts ...
```

**After:**
```yaml
- name: Deploy Stack
  uses: ./.github/actions/deploy-cdk-stack
  with:
    stack-name: "NetworkingStack-monitoring-development"
    environment: "development"
    aws-account-id: "123456789012"
    aws-region: "eu-west-1"
```

All validation is now inline within the action.

### For CI/CD Pipeline Validation

If you previously used `environment: pipeline` for CI validation:

**Before:**
```yaml
- name: Validate CDK Stacks
  uses: ./.github/actions/deploy-cdk-stack
  with:
    environment: "pipeline"
    # ... other inputs
```

**After (use CDK synth directly):**
```yaml
- name: Validate CDK Stacks
  run: |
    npx cdk synth --all --quiet
    echo "CDK synthesis validation passed"
```

## Error Handling

### Error Messages

The action provides clear, actionable error messages:

```
ERROR: Invalid environment: prod
Valid environments: development staging production

Note: This action is for deploying to target environments.
For CI/CD pipeline validation, use CDK synth directly.
```

```
ERROR: Invalid AWS account ID format: 12345
Expected: 12-digit number
```

### AWS Errors

Provides troubleshooting guidance:

```
ERROR: Cannot retrieve AWS account information
AWS CLI output: Unable to locate credentials

Troubleshooting:
  1. Verify AWS credentials are configured
  2. Check IAM role trust policy allows GitHub OIDC
  3. Ensure role has sts:GetCallerIdentity permission
```

### Bootstrap Errors

Guides user to resolution:

```
ERROR: CDK bootstrap stack not found

Please bootstrap the CDK environment:
  cdk bootstrap aws://123456789012/eu-west-1

Or skip this check with: skip-bootstrap-verification: 'true'
```

## Environment Variables

The action sets environment variables for the deployment step:

- `CDK_ENVIRONMENT`: From `environment` input
- `AWS_ACCOUNT_ID`: From `aws-account-id` input
- `AWS_REGION`: From `aws-region` input

These are available to CDK code via `process.env`.

Note: Project name is not set as an environment variable since it should be included in the stack name itself (e.g., `NetworkingStack-monitoring-development`).

## Security Considerations

### Credential Handling

- Relies on GitHub OIDC authentication (no long-lived credentials)
- Assumes AWS credentials configured by previous step (e.g., `aws-actions/configure-aws-credentials`)
- Masks account IDs in logs (shows only last 4 digits)

### Context Passing

- Validates JSON format before parsing
- Uses single quotes to prevent shell injection
- Properly escapes values in CDK context

### Output Handling

- Stack outputs retrieved only on successful deployment
- JSON-escaped for safe use in subsequent steps
- Can contain sensitive values - handle with care

## Performance

### Typical Execution Time

- Input validation: ~1 second
- AWS credential verification: ~2 seconds
- CDK bootstrap check: ~3 seconds
- Context building: ~1 second
- Stack deployment: Variable (5-20 minutes depending on resources)
- Output retrieval: ~2 seconds

### Optimisation Tips

1. Use `skip-bootstrap-verification: 'true'` after first deployment
2. Leverage CDK `--hotswap` for development deployments
3. Cache node_modules via `setup-node-yarn` action
4. Use `--exclusively` to deploy single stack

## Examples

### Complete Deployment Flow

```yaml
deploy-networking:
  name: Deploy Networking Stack
  needs: [build, validate-setup]
  runs-on: ubuntu-latest
  environment: development

  steps:
    - name: Checkout
      uses: actions/checkout@v4

    - name: Setup Node.js and Yarn
      uses: ./.github/actions/setup-node-yarn

    - name: Configure AWS Credentials
      uses: aws-actions/configure-aws-credentials@v4
      with:
        role-to-assume: ${{ secrets.AWS_OIDC_ROLE }}
        aws-region: eu-west-1

    - name: Deploy NetworkingStack
      id: deploy
      uses: ./.github/actions/deploy-cdk-stack
      with:
        stack-name: "NetworkingStack-monitoring-development"
        environment: "development"
        aws-account-id: ${{ vars.AWS_ACCOUNT_ID_DEV }}
        aws-region: "eu-west-1"

    - name: Display Outputs
      if: steps.deploy.outputs.deployment-status == 'success'
      run: |
        echo "Deployment successful!"
        echo "Stack outputs: ${{ steps.deploy.outputs.stack-outputs }}"
```

### Multi-Stack Deployment with Context Sharing

```yaml
- name: Deploy Networking
  id: networking
  uses: ./.github/actions/deploy-cdk-stack
  with:
    stack-name: "NetworkingStack-monitoring-development"
    environment: "development"
    aws-account-id: ${{ vars.AWS_ACCOUNT_ID_DEV }}
    aws-region: "eu-west-1"

- name: Extract VPC ID
  id: vpc
  run: |
    VPC_ID=$(echo '${{ steps.networking.outputs.stack-outputs }}' | jq -r '.[] | select(.OutputKey=="VpcId") | .OutputValue')
    echo "vpc_id=$VPC_ID" >> $GITHUB_OUTPUT

- name: Deploy ECS with VPC Context
  uses: ./.github/actions/deploy-cdk-stack
  with:
    stack-name: "EcsStack-monitoring-development"
    environment: "development"
    aws-account-id: ${{ vars.AWS_ACCOUNT_ID_DEV }}
    aws-region: "eu-west-1"
    additional-context: '{"vpcId":"${{ steps.vpc.outputs.vpc_id }}"}'
```

## Troubleshooting

### Issue: Context not being applied

**Problem**: Additional context values not recognised by CDK

**Solution**: 
1. Verify JSON syntax in `additional-context`
2. Check CDK code reads context: `this.node.tryGetContext('key')`
3. Review "Build CDK Context" step logs

### Issue: Bootstrap verification fails

**Problem**: CDKToolkit stack not found

**Solution**:
1. Bootstrap the account: `cdk bootstrap aws://ACCOUNT/REGION`
2. Or skip check: `skip-bootstrap-verification: 'true'`

### Issue: Deployment succeeds but outputs empty

**Problem**: `stack-outputs` is `[]`

**Solution**:
1. Verify stack has `CfnOutput` resources
2. Check stack deployed successfully
3. Review AWS CLI permissions for `cloudformation:DescribeStacks`

## Related Actions

- `setup-node-yarn` - Node.js and Yarn setup with caching
- `setup-cdk-deployment` - Combines Node setup + AWS credentials

## Version History

- **v2.0.0** - Simplified version with inline validation and flexible context
- **v1.0.0** - Original version with external scripts and project-specific inputs
