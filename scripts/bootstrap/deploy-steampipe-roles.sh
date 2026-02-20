#!/bin/bash
# ============================================================================
# Deploy SteampipeReadOnly IAM Role to a Target Account
# ============================================================================
#
# Creates the SteampipeReadOnly IAM role in the target account using
# direct aws iam commands. Run once per account that needs governance.
#
# The monitoring account ID is read from .env.bootstrap. The target
# account is specified via --profile (defaults to .env.bootstrap PROFILE).
#
# Usage:
#   ./scripts/bootstrap/deploy-steampipe-roles.sh --profile dev-account
#   ./scripts/bootstrap/deploy-steampipe-roles.sh --profile staging-account
#   ./scripts/bootstrap/deploy-steampipe-roles.sh --profile dev-account --dry-run
#
# ============================================================================

set -euo pipefail

# ============================================================================
# CONFIGURATION
# ============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.bootstrap"
TRUST_POLICY_FILE="$SCRIPT_DIR/policies/SteampipeReadOnlyTrust.json"

ROLE_NAME="SteampipeReadOnly"
DRY_RUN=false
TARGET_PROFILE=""

# Managed policies to attach
MANAGED_POLICIES=(
  "arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"
  "arn:aws:iam::aws:policy/SecurityAudit"
)

# Load .env.bootstrap (monitoring account config)
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

# Colours
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# ============================================================================
# PARSE ARGUMENTS
# ============================================================================
while [ $# -gt 0 ]; do
  case "$1" in
    --profile)  TARGET_PROFILE="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=true; shift ;;
    --help|-h)
      echo "Usage: $0 --profile <target-account-profile> [--dry-run]"
      echo ""
      echo "  --profile   AWS CLI profile for the target account (required)"
      echo "  --dry-run   Print commands without executing"
      exit 0
      ;;
    *)          log_error "Unknown option: $1"; exit 1 ;;
  esac
done

if [ -z "$TARGET_PROFILE" ]; then
  log_error "Missing --profile. Usage: $0 --profile dev-account"
  exit 1
fi

# ============================================================================
# PRE-FLIGHT
# ============================================================================
echo ""
echo "============================================"
echo " Deploy SteampipeReadOnly IAM Role"
echo "============================================"
echo " Monitoring Account: $ACCOUNT_ID"
echo " Target Profile:     $TARGET_PROFILE"
echo " Role Name:          $ROLE_NAME"
echo " Dry Run:            $DRY_RUN"
echo "============================================"
echo ""

if [ ! -f "$TRUST_POLICY_FILE" ]; then
  log_error "Trust policy not found: $TRUST_POLICY_FILE"
  exit 1
fi

# Build trust policy with actual monitoring account ID
TRUST_POLICY=$(sed "s/MONITORING_ACCOUNT_ID_PLACEHOLDER/$ACCOUNT_ID/" "$TRUST_POLICY_FILE")

# ============================================================================
# DEPLOY
# ============================================================================
log_info "Deploying $ROLE_NAME via profile: $TARGET_PROFILE..."

if [ "$DRY_RUN" = true ]; then
  echo "  aws iam create-role --role-name $ROLE_NAME --profile $TARGET_PROFILE"
  for policy_arn in "${MANAGED_POLICIES[@]}"; do
    echo "  aws iam attach-role-policy --policy-arn $policy_arn --profile $TARGET_PROFILE"
  done
  exit 0
fi

# Create or update role (idempotent)
if aws iam get-role --role-name "$ROLE_NAME" --profile "$TARGET_PROFILE" &>/dev/null; then
  log_info "Role exists — updating trust policy"
  aws iam update-assume-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-document "$TRUST_POLICY" \
    --profile "$TARGET_PROFILE"
else
  log_info "Creating role: $ROLE_NAME"
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "Read-only access for Steampipe cross-account governance" \
    --profile "$TARGET_PROFILE" > /dev/null
fi

# Attach managed policies (idempotent)
for policy_arn in "${MANAGED_POLICIES[@]}"; do
  aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn "$policy_arn" \
    --profile "$TARGET_PROFILE"
done

log_success "SteampipeReadOnly deployed via $TARGET_PROFILE"
echo ""
echo "Next steps:"
echo "  1. Repeat for other accounts: $0 --profile <other-profile>"
echo "  2. Update OIDC permissions:   ./scripts/bootstrap/update-oidc-cross-account.sh"
echo "  3. Redeploy SSM stack:        yarn cli deploy -p monitoring -s ssm -e production"
