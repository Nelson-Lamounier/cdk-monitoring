#!/bin/bash
# ============================================================================
# Update OIDC Role — Apply Cross-Account Permissions
# ============================================================================
#
# Reads AssumeCDKRoles.json and applies it as a managed policy to the OIDC
# role. This is the single entry point for updating cross-account permissions.
#
# Workflow:
#   1. Edit policies/AssumeCDKRoles.json (add CDK roles, Steampipe, etc.)
#   2. Run this script
#   3. Pipeline now has the updated permissions via OIDC
#
# Usage:
#   ./scripts/bootstrap/update-oidc-cross-account.sh
#   ./scripts/bootstrap/update-oidc-cross-account.sh --dry-run
#   ./scripts/bootstrap/update-oidc-cross-account.sh --role-name MyOIDCRole
#
# ============================================================================

set -euo pipefail

# ============================================================================
# CONFIGURATION
# ============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.bootstrap"
POLICY_FILE="$SCRIPT_DIR/policies/OIDCCrossAccountAccess.json"
POLICY_NAME="OIDCCrossAccountAccess"

DRY_RUN=false
OIDC_ROLE_NAME=""

# Load .env.bootstrap
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    value="${value%\"}" ; value="${value#\"}"
    value="${value%\'}" ; value="${value#\'}"
    export "$key=$value"
  done < "$ENV_FILE"
else
  echo "Error: .env.bootstrap not found at $ENV_FILE"
  exit 1
fi

: "${ACCOUNT_ID:?ACCOUNT_ID not set in .env.bootstrap}"
: "${REGION:?REGION not set in .env.bootstrap}"
: "${PROFILE:?PROFILE not set in .env.bootstrap}"

# Colours
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# ============================================================================
# PARSE ARGUMENTS
# ============================================================================
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)     DRY_RUN=true; shift ;;
    --role-name)   OIDC_ROLE_NAME="$2"; shift 2 ;;
    --profile)     PROFILE="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] [--role-name ROLE] [--profile PROFILE]"
      exit 0
      ;;
    *) log_error "Unknown option: $1"; exit 1 ;;
  esac
done

# ============================================================================
# DETECT OIDC ROLE (if not provided)
# ============================================================================
if [ -z "$OIDC_ROLE_NAME" ]; then
  # Auto-detect: look for roles containing "OIDC" in the account
  OIDC_ROLE_NAME=$(aws iam list-roles \
    --profile "$PROFILE" \
    --query "Roles[?contains(RoleName, 'OIDC')].RoleName | [0]" \
    --output text 2>/dev/null || echo "")

  if [ -z "$OIDC_ROLE_NAME" ] || [ "$OIDC_ROLE_NAME" == "None" ]; then
    log_error "No OIDC role found. Use --role-name to specify."
    exit 1
  fi
  log_info "Auto-detected OIDC role: $OIDC_ROLE_NAME"
fi

# ============================================================================
# PRE-FLIGHT
# ============================================================================
echo ""
echo "============================================"
echo " Update OIDC Role — Cross-Account Permissions"
echo "============================================"
echo " Profile:    $PROFILE"
echo " Account:    $ACCOUNT_ID"
echo " OIDC Role:  $OIDC_ROLE_NAME"
echo " Policy:     $POLICY_NAME"
echo " Source:     policies/OIDCCrossAccountAccess.json"
echo " Dry Run:    $DRY_RUN"
echo "============================================"
echo ""

# Validate policy file
if [ ! -f "$POLICY_FILE" ]; then
  log_error "Policy file not found: $POLICY_FILE"
  exit 1
fi

if ! jq empty < "$POLICY_FILE" 2>/dev/null; then
  log_error "Invalid JSON in $POLICY_FILE"
  exit 1
fi
log_success "Policy JSON valid"

# Verify credentials
ACTUAL_ACCOUNT=$(aws sts get-caller-identity \
  --profile "$PROFILE" \
  --query 'Account' \
  --output text 2>/dev/null || echo "")

if [ -z "$ACTUAL_ACCOUNT" ]; then
  log_error "Cannot authenticate with profile: $PROFILE"
  exit 1
fi
log_success "Authenticated: account $ACTUAL_ACCOUNT"

# Verify OIDC role exists
aws iam get-role \
  --role-name "$OIDC_ROLE_NAME" \
  --profile "$PROFILE" \
  --query 'Role.Arn' \
  --output text >/dev/null 2>&1 || {
  log_error "OIDC role not found: $OIDC_ROLE_NAME"
  exit 1
}
log_success "OIDC role exists: $OIDC_ROLE_NAME"

# Show what's being applied
log_info "Policy statements:"
jq -r '.Statement[].Sid' "$POLICY_FILE" | while read -r sid; do
  echo "  - $sid"
done

# ============================================================================
# APPLY (reuses pattern from environment-deployment.sh)
# ============================================================================
if [ "$DRY_RUN" = true ]; then
  log_warn "[DRY RUN] Would create/update policy '$POLICY_NAME' and attach to '$OIDC_ROLE_NAME'"
  log_info "Policy contents:"
  jq . "$POLICY_FILE"
  exit 0
fi

# Check if managed policy exists
POLICY_ARN=$(aws iam list-policies \
  --scope Local \
  --query "Policies[?PolicyName=='$POLICY_NAME'].Arn" \
  --output text \
  --profile "$PROFILE" 2>/dev/null || echo "")

if [ -z "$POLICY_ARN" ]; then
  log_info "Creating managed policy: $POLICY_NAME"
  aws iam create-policy \
    --policy-name "$POLICY_NAME" \
    --policy-document "file://$POLICY_FILE" \
    --description "Cross-account AssumeRole permissions for CDK, Steampipe, and pipeline operations" \
    --profile "$PROFILE" > /dev/null

  POLICY_ARN=$(aws iam list-policies \
    --scope Local \
    --query "Policies[?PolicyName=='$POLICY_NAME'].Arn" \
    --output text \
    --profile "$PROFILE")
  log_success "Policy created: $POLICY_ARN"
else
  log_info "Updating managed policy: $POLICY_NAME"

  # Handle AWS 5-version limit
  VERSION_COUNT=$(aws iam list-policy-versions \
    --policy-arn "$POLICY_ARN" \
    --profile "$PROFILE" \
    --query 'length(Versions)' \
    --output text 2>/dev/null || echo "0")

  if [ "$VERSION_COUNT" -ge 5 ]; then
    OLDEST=$(aws iam list-policy-versions \
      --policy-arn "$POLICY_ARN" \
      --profile "$PROFILE" \
      --query 'Versions[?IsDefaultVersion==`false`] | [-1].VersionId' \
      --output text 2>/dev/null)
    if [ -n "$OLDEST" ] && [ "$OLDEST" != "None" ]; then
      aws iam delete-policy-version \
        --policy-arn "$POLICY_ARN" \
        --version-id "$OLDEST" \
        --profile "$PROFILE" 2>/dev/null || true
    fi
  fi

  aws iam create-policy-version \
    --policy-arn "$POLICY_ARN" \
    --policy-document "file://$POLICY_FILE" \
    --set-as-default \
    --profile "$PROFILE" > /dev/null
  log_success "Policy updated: $POLICY_ARN"
fi

# Attach to OIDC role (idempotent)
ATTACHED=$(aws iam list-attached-role-policies \
  --role-name "$OIDC_ROLE_NAME" \
  --profile "$PROFILE" \
  --query "AttachedPolicies[?PolicyName=='$POLICY_NAME'].PolicyName" \
  --output text 2>/dev/null || echo "")

if [ -z "$ATTACHED" ]; then
  aws iam attach-role-policy \
    --role-name "$OIDC_ROLE_NAME" \
    --policy-arn "$POLICY_ARN" \
    --profile "$PROFILE"
  log_success "Policy attached to $OIDC_ROLE_NAME"
else
  log_success "Policy already attached to $OIDC_ROLE_NAME"
fi

# ============================================================================
# DONE
# ============================================================================
echo ""
log_success "OIDC role '$OIDC_ROLE_NAME' updated with cross-account permissions."
echo ""
echo "To add more permissions:"
echo "  1. Edit scripts/bootstrap/policies/OIDCCrossAccountAccess.json"
echo "  2. Re-run: ./scripts/bootstrap/update-oidc-cross-account.sh"
