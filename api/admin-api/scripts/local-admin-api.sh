#!/usr/bin/env bash
# =============================================================================
# scripts/local-admin-api.sh — Local admin-api Docker test cycle
#
# Stops any running admin-api container, builds a fresh image from the current
# source, verifies AWS credentials are reachable, and starts the container.
#
# Usage:
#   ./api/admin-api/scripts/local-admin-api.sh
#   AWS_PROFILE=dev-account ./api/admin-api/scripts/local-admin-api.sh
#
# Prerequisites:
#   - Docker Desktop or colima running
#   - ~/.aws/credentials or ~/.aws/config with a [dev-account] profile
#   - api/admin-api/.env file with all required env vars
#     (copy from api/admin-api/.env.example and fill in real values)
#
# The script must be run from the repo root or any subdirectory.
# It always resolves paths relative to the repo root.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_API_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${ADMIN_API_DIR}/../.." && pwd)"
COMPOSE_FILE="${ADMIN_API_DIR}/docker-compose.yml"
IMAGE_NAME="admin-api:local"
CONTAINER_NAME="admin-api-local"
AWS_PROFILE="${AWS_PROFILE:-dev-account}"
PORT=3002

# Colours
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Colour

log_info()  { echo -e "${BLUE}[admin-api]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[admin-api]${NC} ✓ $*"; }
log_warn()  { echo -e "${YELLOW}[admin-api]${NC} ⚠ $*"; }
log_error() { echo -e "${RED}[admin-api]${NC} ✗ $*" >&2; }

# ---------------------------------------------------------------------------
# 1. Pre-flight: verify required files exist
# ---------------------------------------------------------------------------
log_info "=== Admin API — Local Test Cycle ==="

if [ ! -f "${ADMIN_API_DIR}/.env" ]; then
  log_error ".env not found at ${ADMIN_API_DIR}/.env"
  log_error "Copy .env.example and fill in the values:"
  log_error "  cp api/admin-api/.env.example api/admin-api/.env"
  exit 1
fi

if [ ! -f "${HOME}/.aws/credentials" ] && [ ! -f "${HOME}/.aws/config" ]; then
  log_error "AWS credentials not found at ~/.aws/credentials or ~/.aws/config"
  log_error "Configure the '${AWS_PROFILE}' profile before running this script."
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Stop any running admin-api container
# ---------------------------------------------------------------------------
log_info "Stopping any running admin-api containers..."
if docker compose -f "${COMPOSE_FILE}" ps --quiet 2>/dev/null | grep -q .; then
  docker compose -f "${COMPOSE_FILE}" down --remove-orphans --timeout 10
  log_ok "Existing containers stopped and removed"
else
  log_info "No running containers to stop"
fi

# ---------------------------------------------------------------------------
# 3. Build the Docker image from the repo root
# ---------------------------------------------------------------------------
log_info "Building ${IMAGE_NAME} from repo root..."
docker build \
  --file "${ADMIN_API_DIR}/Dockerfile" \
  --tag "${IMAGE_NAME}" \
  "${REPO_ROOT}"
log_ok "Image built: ${IMAGE_NAME}"

# ---------------------------------------------------------------------------
# 4. Verify AWS credentials are accessible with the selected profile
# ---------------------------------------------------------------------------
log_info "Verifying AWS credentials (profile: ${AWS_PROFILE})..."
CALLER_IDENTITY=$(AWS_PROFILE="${AWS_PROFILE}" aws sts get-caller-identity \
  --output json 2>/dev/null || echo "")

if [ -z "${CALLER_IDENTITY}" ]; then
  log_warn "Could not verify AWS credentials for profile '${AWS_PROFILE}'."
  log_warn "The container will start, but AWS API calls may fail."
  log_warn "Run: aws sso login --profile ${AWS_PROFILE}  (if using SSO)"
else
  ACCOUNT_ID=$(echo "${CALLER_IDENTITY}" | python3 -c "import sys,json; print(json.load(sys.stdin)['Account'])" 2>/dev/null || echo "unknown")
  ARN=$(echo "${CALLER_IDENTITY}"        | python3 -c "import sys,json; print(json.load(sys.stdin)['Arn'])"     2>/dev/null || echo "unknown")
  log_ok "Credentials valid — Account: ${ACCOUNT_ID}, ARN: ${ARN}"
fi

# ---------------------------------------------------------------------------
# 5. Start the container
# ---------------------------------------------------------------------------
log_info "Starting admin-api container on port ${PORT}..."
AWS_PROFILE="${AWS_PROFILE}" docker compose \
  -f "${COMPOSE_FILE}" \
  up \
  --detach \
  --no-build   # image already built in step 3

# ---------------------------------------------------------------------------
# 6. Wait for the health check
# ---------------------------------------------------------------------------
log_info "Waiting for health check at http://localhost:${PORT}/healthz ..."
MAX_RETRIES=20
RETRY_INTERVAL=2
RETRIES=0

until curl --silent --fail "http://localhost:${PORT}/healthz" > /dev/null 2>&1; do
  RETRIES=$((RETRIES + 1))
  if [ "${RETRIES}" -ge "${MAX_RETRIES}" ]; then
    log_error "Health check failed after $((MAX_RETRIES * RETRY_INTERVAL)) seconds."
    log_error "Container logs:"
    docker compose -f "${COMPOSE_FILE}" logs --tail 50
    exit 1
  fi
  sleep "${RETRY_INTERVAL}"
done

log_ok "Health check passed — admin-api is ready at http://localhost:${PORT}"
echo ""
echo "  Health:   curl http://localhost:${PORT}/healthz"
echo "  Logs:     docker compose -f ${COMPOSE_FILE} logs -f"
echo "  Stop:     docker compose -f ${COMPOSE_FILE} down"
echo ""
echo "  Test draft endpoint (requires Cognito token from the admin UI):"
echo "    TOKEN=<paste-from-browser-devtools>"
echo "    curl -X POST http://localhost:${PORT}/api/admin/drafts/my-test-slug \\"
echo "         -H 'Authorization: Bearer \$TOKEN' \\"
echo "         -H 'Content-Type: application/json' \\"
echo "         -d '{\"content\": \"# My Draft\\n\\nTest content.\"}'"
