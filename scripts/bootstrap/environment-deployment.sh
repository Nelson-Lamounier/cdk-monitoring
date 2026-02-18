#!/bin/bash
# ============================================================================
# Complete Development Account Deployment Setup Script
# ============================================================================
#
# This script sets up all IAM permissions required for CDK deployments
# from GitHub Actions to the development account.
#
# What it does:
# 1. Creates/updates the CDKCloudFormationEx policy (CloudFormation execution permissions)
# 2. Creates/updates the AssumeCDKRoles policy (cross-account role assumption)
# 3. Attaches policies to the CDK CloudFormation execution role
# 4. Attaches policies to the OIDC role (if exists)
# 5. Re-bootstraps CDK with the custom execution policy
# 6. Verifies the complete setup
#
# Prerequisites:
# - AWS CLI configured with dev-account profile
# - Admin access to the development account
# - CDK CLI installed (npm install -g aws-cdk)
# - jq installed (brew install jq or apt-get install jq)
#
# Usage:
#   ./scripts/bootstrap/setup-dev-deployment.sh
#
# ============================================================================

set -euo pipefail

# ============================================================================
# CONFIGURATION - Load from .env file
# ============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.bootstrap"

# Load environment variables from .env file
if [ -f "$ENV_FILE" ]; then
    while IFS='=' read -r key value || [[ -n "$key" ]]; do
        # Skip empty lines and comments
        [[ -z "$key" || "$key" =~ ^# ]] && continue
        # Remove surrounding quotes from value
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        export "$key=$value"
    done < "$ENV_FILE"
else
  echo "Error: .env file not found in $ENV_FILE"
  echo "Please copy .env.example to .env and fill in your values"
  exit 1
fi


# validate env variables
: "${ACCOUNT_ID:?Error: ACCOUNT_ID is not set}"
: "${REGION:?Error: REGION is not set}"
: "${PROFILE:?Error: PROFILE is not set}"
: "${CDK_QUALIFIER:?Error: CDK_QUALIFIER is not set}"

# Policy names
CDK_POLICY_NAME="CDKCloudFormationEx"
ASSUME_POLICY_NAME="AssumeCDKRoles"

# Role names
CDK_CFN_ROLE="cdk-${CDK_QUALIFIER}-cfn-exec-role-${ACCOUNT_ID}-${REGION}"
OIDC_ROLE_NAME="DevAccountOIDCRole"

# Policy files - updated path from bootstrap directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_POLICY_FILE="$SCRIPT_DIR/policies/CDKCloudFormationEx.json"
ASSUME_POLICY_FILE="$SCRIPT_DIR/policies/AssumeCDKRoles.json"

# Colours for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Colour

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================
log_info() {
  echo -e "${BLUE}[INFO]${NC} $1" >&2
}

log_success() {
  echo -e "${GREEN}[OK]${NC} $1" >&2
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1" >&2
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1" >&2
}

log_section() {
  echo "" >&2
  echo "========================================" >&2
  echo "$1" >&2
  echo "========================================" >&2
  echo "" >&2
}

check_prerequisites() {
  log_section "Checking Prerequisites"

  # Check AWS CLI
  if ! command -v aws &> /dev/null; then
    log_error "AWS CLI not found. Please install it first."
    exit 1
  fi
  log_success "AWS CLI installed"

  # Check jq
  if ! command -v jq &> /dev/null; then
    log_error "jq not found. Please install it (brew install jq or apt-get install jq)"
    exit 1
  fi
  log_success "jq installed"

  # Check CDK CLI
  if ! command -v cdk &> /dev/null; then
    log_error "CDK CLI not found. Please install it (npm install -g aws-cdk)"
    exit 1
  fi
  CDK_VERSION=$(cdk --version 2>/dev/null || echo "unknown")
  log_success "CDK CLI installed: $CDK_VERSION"

  # Check policy files exist
  if [ ! -f "$CDK_POLICY_FILE" ]; then
    log_error "Policy file not found: $CDK_POLICY_FILE"
    log_error "Please ensure policy files exist in scripts/bootstrap/policies/"
    exit 1
  fi
  log_success "CDK policy file found: $CDK_POLICY_FILE"

  if [ ! -f "$ASSUME_POLICY_FILE" ]; then
    log_error "Policy file not found: $ASSUME_POLICY_FILE"
    exit 1
  fi
  log_success "Assume policy file found: $ASSUME_POLICY_FILE"

  # Validate JSON
  if ! jq empty < "$CDK_POLICY_FILE" 2>/dev/null; then
    log_error "Invalid JSON in $CDK_POLICY_FILE"
    exit 1
  fi
  log_success "CDK policy JSON is valid"

  if ! jq empty < "$ASSUME_POLICY_FILE" 2>/dev/null; then
    log_error "Invalid JSON in $ASSUME_POLICY_FILE"
    exit 1
  fi
  log_success "Assume policy JSON is valid"
}

verify_aws_credentials() {
  log_section "Verifying AWS Credentials"

  log_info "Profile: $PROFILE"
  log_info "Expected Account: $ACCOUNT_ID"
  log_info "Region: $REGION"
  echo ""

  CURRENT_ACCOUNT=$(aws sts get-caller-identity \
    --profile "$PROFILE" \
    --query Account \
    --output text 2>/dev/null || echo "")

  if [ -z "$CURRENT_ACCOUNT" ]; then
    log_error "Cannot authenticate with profile: $PROFILE"
    echo ""
    echo "Please configure AWS CLI:"
    echo "  aws configure --profile $PROFILE"
    echo ""
    echo "Or export credentials:"
    echo "  export AWS_ACCESS_KEY_ID=..."
    echo "  export AWS_SECRET_ACCESS_KEY=..."
    exit 1
  fi

  if [ "$CURRENT_ACCOUNT" != "$ACCOUNT_ID" ]; then
    log_warn "Profile points to account $CURRENT_ACCOUNT, expected $ACCOUNT_ID"
    echo ""
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      exit 1
    fi
    ACCOUNT_ID="$CURRENT_ACCOUNT"
    CDK_CFN_ROLE="cdk-${CDK_QUALIFIER}-cfn-exec-role-${ACCOUNT_ID}-${REGION}"
  fi

  CALLER_ARN=$(aws sts get-caller-identity \
    --profile "$PROFILE" \
    --query Arn \
    --output text)

  log_success "Authenticated to account: $CURRENT_ACCOUNT"
  log_info "Caller: $CALLER_ARN"
}

create_or_update_policy() {
  local policy_name="$1"
  local policy_file="$2"
  local description="$3"

  log_info "Processing policy: $policy_name"

  # Check if policy exists
  local policy_arn
  policy_arn=$(aws iam list-policies \
    --scope Local \
    --query "Policies[?PolicyName=='$policy_name'].Arn" \
    --output text \
    --profile "$PROFILE" 2>/dev/null || echo "")

  if [ -z "$policy_arn" ]; then
    log_info "Creating policy: $policy_name"
    aws iam create-policy \
      --policy-name "$policy_name" \
      --policy-document "file://$policy_file" \
      --description "$description" \
      --profile "$PROFILE" > /dev/null

    policy_arn=$(aws iam list-policies \
      --scope Local \
      --query "Policies[?PolicyName=='$policy_name'].Arn" \
      --output text \
      --profile "$PROFILE")

    log_success "Policy created: $policy_arn"
  else
    log_info "Updating policy: $policy_name"

    # Check version count (AWS limit: 5 versions)
    local version_count
    version_count=$(aws iam list-policy-versions \
      --policy-arn "$policy_arn" \
      --profile "$PROFILE" \
      --query 'length(Versions)' \
      --output text 2>/dev/null || echo "0")

    if [ "$version_count" -ge 5 ]; then
      log_info "Deleting oldest version (AWS limit: 5 versions)"
      local oldest_version
      oldest_version=$(aws iam list-policy-versions \
        --policy-arn "$policy_arn" \
        --profile "$PROFILE" \
        --query 'Versions[?IsDefaultVersion==`false`] | [-1].VersionId' \
        --output text 2>/dev/null)

      if [ -n "$oldest_version" ] && [ "$oldest_version" != "None" ]; then
        aws iam delete-policy-version \
          --policy-arn "$policy_arn" \
          --version-id "$oldest_version" \
          --profile "$PROFILE" 2>/dev/null || true
      fi
    fi

    aws iam create-policy-version \
      --policy-arn "$policy_arn" \
      --policy-document "file://$policy_file" \
      --set-as-default \
      --profile "$PROFILE" > /dev/null

    log_success "Policy updated: $policy_arn"
  fi

  echo "$policy_arn"
}

attach_policy_to_role() {
  local role_name="$1"
  local policy_name="$2"
  local policy_arn="$3"

  # Check if role exists
  local role_exists
  role_exists=$(aws iam get-role \
    --role-name "$role_name" \
    --profile "$PROFILE" \
    --query 'Role.RoleName' \
    --output text 2>/dev/null || echo "")

  if [ -z "$role_exists" ]; then
    log_warn "Role not found: $role_name"
    return 1
  fi

  # Check if already attached
  local attached
  attached=$(aws iam list-attached-role-policies \
    --role-name "$role_name" \
    --profile "$PROFILE" \
    --query "AttachedPolicies[?PolicyName=='$policy_name'].PolicyName" \
    --output text 2>/dev/null || echo "")

  if [ -z "$attached" ]; then
    log_info "Attaching $policy_name to $role_name"
    aws iam attach-role-policy \
      --role-name "$role_name" \
      --policy-arn "$policy_arn" \
      --profile "$PROFILE"
    log_success "Policy attached to $role_name"
  else
    log_success "Policy already attached to $role_name"
  fi

  return 0
}

bootstrap_cdk() {
  log_section "CDK Bootstrap"

  local cdk_policy_arn="$1"
  
  # Sanitize the policy ARN - remove any whitespace/newlines
  cdk_policy_arn=$(echo "$cdk_policy_arn" | tr -d '[:space:]')

  # Validate the policy ARN format
  if [[ ! "$cdk_policy_arn" =~ ^arn:aws:iam::[0-9]+:policy/.+ ]]; then
    log_error "Invalid policy ARN format: $cdk_policy_arn"
    log_error "Expected format: arn:aws:iam::<account>:policy/<policy-name>"
    return 1
  fi

  # Check current bootstrap status
  local stack_status
  stack_status=$(aws cloudformation describe-stacks \
    --stack-name "CDKToolkit" \
    --profile "$PROFILE" \
    --region "$REGION" \
    --query 'Stacks[0].StackStatus' \
    --output text 2>/dev/null || echo "NOT_FOUND")

  if [ "$stack_status" == "NOT_FOUND" ]; then
    log_info "CDK not bootstrapped yet. Running bootstrap..."
  else
    log_info "CDK already bootstrapped (status: $stack_status)"

    # Check if our custom policy is attached to cfn-exec role
    local attached
    attached=$(aws iam list-attached-role-policies \
      --role-name "$CDK_CFN_ROLE" \
      --profile "$PROFILE" \
      --query "AttachedPolicies[?PolicyName=='$CDK_POLICY_NAME'].PolicyName" \
      --output text 2>/dev/null || echo "")

    if [ -n "$attached" ]; then
      log_success "Custom policy already attached to CFN execution role"
      log_info "Skipping re-bootstrap (use --force flag to override)"
      return 0
    else
      log_warn "Custom policy NOT attached to CFN execution role"
      log_info "Re-bootstrapping to attach custom policy..."
    fi
  fi

  echo "" >&2
  log_info "Running CDK bootstrap..."
  log_info "  Account: $ACCOUNT_ID"
  log_info "  Region: $REGION"
  log_info "  Qualifier: $CDK_QUALIFIER"
  log_info "  Execution Policy: $cdk_policy_arn"
  echo "" >&2

  cdk bootstrap "aws://$ACCOUNT_ID/$REGION" \
    --profile "$PROFILE" \
    --cloudformation-execution-policies "$cdk_policy_arn" \
    --qualifier "$CDK_QUALIFIER" \
    --toolkit-stack-name "CDKToolkit"

  log_success "CDK bootstrap complete"
}

verify_setup() {
  log_section "Verification"

  local all_ok=true

  # 1. Verify CDKToolkit stack
  log_info "1. CDKToolkit Stack:"
  local stack_status
  stack_status=$(aws cloudformation describe-stacks \
    --stack-name "CDKToolkit" \
    --profile "$PROFILE" \
    --region "$REGION" \
    --query 'Stacks[0].StackStatus' \
    --output text 2>/dev/null || echo "NOT_FOUND")

  if [ "$stack_status" == "CREATE_COMPLETE" ] || [ "$stack_status" == "UPDATE_COMPLETE" ]; then
    log_success "   CDKToolkit: $stack_status"
  else
    log_warn "   CDKToolkit: $stack_status"
    all_ok=false
  fi

  # 2. Verify CDK roles exist
  log_info "2. CDK Bootstrap Roles:"
  local roles=(
    "cdk-${CDK_QUALIFIER}-deploy-role-${ACCOUNT_ID}-${REGION}"
    "cdk-${CDK_QUALIFIER}-cfn-exec-role-${ACCOUNT_ID}-${REGION}"
    "cdk-${CDK_QUALIFIER}-lookup-role-${ACCOUNT_ID}-${REGION}"
    "cdk-${CDK_QUALIFIER}-file-publishing-role-${ACCOUNT_ID}-${REGION}"
    "cdk-${CDK_QUALIFIER}-image-publishing-role-${ACCOUNT_ID}-${REGION}"
  )

  for role in "${roles[@]}"; do
    local exists
    exists=$(aws iam get-role \
      --role-name "$role" \
      --profile "$PROFILE" \
      --query 'Role.RoleName' \
      --output text 2>/dev/null || echo "")

    if [ -n "$exists" ]; then
      log_success "   $role"
    else
      log_error "   $role (NOT FOUND)"
      all_ok=false
    fi
  done

  # 3. Verify custom policy attached to CFN execution role
  log_info "3. Custom Policy Attachment:"
  local attached
  attached=$(aws iam list-attached-role-policies \
    --role-name "$CDK_CFN_ROLE" \
    --profile "$PROFILE" \
    --query "AttachedPolicies[?PolicyName=='$CDK_POLICY_NAME'].PolicyName" \
    --output text 2>/dev/null || echo "")

  if [ -n "$attached" ]; then
    log_success "   $CDK_POLICY_NAME attached to $CDK_CFN_ROLE"
  else
    log_error "   $CDK_POLICY_NAME NOT attached to $CDK_CFN_ROLE"
    all_ok=false
  fi

  # 4. Verify OIDC role (if exists)
  log_info "4. OIDC Role Configuration:"
  local oidc_exists
  oidc_exists=$(aws iam get-role \
    --role-name "$OIDC_ROLE_NAME" \
    --profile "$PROFILE" \
    --query 'Role.RoleName' \
    --output text 2>/dev/null || echo "")

  if [ -n "$oidc_exists" ]; then
    log_success "   OIDC role exists: $OIDC_ROLE_NAME"

    # Check attached policies
    local oidc_policies
    oidc_policies=$(aws iam list-attached-role-policies \
      --role-name "$OIDC_ROLE_NAME" \
      --profile "$PROFILE" \
      --query "AttachedPolicies[*].PolicyName" \
      --output text 2>/dev/null || echo "")

    if echo "$oidc_policies" | grep -q "$ASSUME_POLICY_NAME"; then
      log_success "   $ASSUME_POLICY_NAME attached to OIDC role"
    else
      log_warn "   $ASSUME_POLICY_NAME not attached to OIDC role"
    fi
  else
    log_warn "   OIDC role not found: $OIDC_ROLE_NAME"
    log_info "   (This is expected if using pipeline account OIDC)"
  fi

  echo "" >&2
  if [ "$all_ok" = true ]; then
    log_success "All verifications passed"
    return 0
  else
    log_warn "Some verifications failed - review above"
    return 1
  fi
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================
main() {
  echo ""
  echo "============================================================================"
  echo " Complete Development Account Deployment Setup"
  echo "============================================================================"
  echo ""
  echo " Account: $ACCOUNT_ID"
  echo " Region:  $REGION"
  echo " Profile: $PROFILE"
  echo ""
  echo "============================================================================"

  # Step 1: Check prerequisites
  check_prerequisites

  # Step 2: Verify AWS credentials
  verify_aws_credentials

  # Step 3: Create/update CDKCloudFormationEx policy
  log_section "Step 1: CloudFormation Execution Policy"
  local cdk_policy_arn
  cdk_policy_arn=$(create_or_update_policy \
    "$CDK_POLICY_NAME" \
    "$CDK_POLICY_FILE" \
    "CloudFormation execution policy for CDK deployments - includes SSM Document, Lambda, and all required permissions")

  # Step 4: Create/update AssumeCDKRoles policy
  log_section "Step 2: Assume CDK Roles Policy"
  local assume_policy_arn
  assume_policy_arn=$(create_or_update_policy \
    "$ASSUME_POLICY_NAME" \
    "$ASSUME_POLICY_FILE" \
    "Allow OIDC role to assume CDK bootstrap roles for cross-account deployments")

  # Step 5: Bootstrap CDK with custom execution policy
  bootstrap_cdk "$cdk_policy_arn"

  # Step 6: Attach policies to OIDC role (if exists)
  log_section "Step 3: OIDC Role Policy Attachments"
  if attach_policy_to_role "$OIDC_ROLE_NAME" "$ASSUME_POLICY_NAME" "$assume_policy_arn"; then
    log_success "OIDC role configured"
  else
    log_info "OIDC role not found in this account"
    log_info "(Expected if using pipeline account OIDC role)"
  fi

  # Step 7: Verify complete setup
  verify_setup
  local verify_status=$?

  # Summary
  log_section "Setup Complete"

  if [ $verify_status -eq 0 ]; then
    echo "The development account is now configured for CDK deployments."
    echo ""
    echo "Next steps:"
    echo ""
    echo "  1. If you have a failed stack, delete it first:"
    echo "     aws cloudformation delete-stack \\"
    echo "       --stack-name development-MonitoringEfs \\"
    echo "       --profile $PROFILE"
    echo ""
    echo "  2. Wait for deletion to complete:"
    echo "     aws cloudformation wait stack-delete-complete \\"
    echo "       --stack-name development-MonitoringEfs \\"
    echo "       --profile $PROFILE"
    echo ""
    echo "  3. Re-run your GitHub Actions workflow or deploy locally:"
    echo "     cdk deploy development-MonitoringEfs --profile $PROFILE"
    echo ""
  else
    echo "Some setup steps may have issues. Please review the verification output above."
    echo ""
  fi
}

# Run main function
main "$@"
