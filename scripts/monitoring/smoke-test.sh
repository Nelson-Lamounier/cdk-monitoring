#!/bin/bash
# @format
# Production-Ready Smoke Test for Monitoring Stack
#
# Comprehensive verification of all monitoring services, data pipelines,
# and infrastructure health. Runs locally on the EC2 instance via SSM.
#
# Test Categories:
#   1. Container Health     — All 7 containers running
#   2. HTTP Health          — Service-specific health/ready APIs
#   3. Grafana Validation   — Datasource health, dashboard provisioning
#   4. Prometheus Validation — Target scrape status, alert rules, query API
#   5. Data Pipeline        — Loki ingestion, Tempo ready, Promtail targets
#   6. Infrastructure       — EBS mount, disk space, Docker daemon
#
# Exit codes:
#   0 - All checks passed
#   1 - One or more checks failed

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
MAX_RETRIES=${MAX_RETRIES:-6}
RETRY_DELAY=${RETRY_DELAY:-10}
MONITORING_DIR=${MONITORING_DIR:-/opt/monitoring}
DISK_THRESHOLD=${DISK_THRESHOLD:-85}

# Source .env from monitoring directory if available (contains GRAFANA_ADMIN_PASSWORD
# set by SSM document during instance boot). Without this, authenticated Grafana API
# calls fail because the smoke test defaults to admin:admin.
if [ -f "${MONITORING_DIR}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "${MONITORING_DIR}/.env"
  set +a
fi

GRAFANA_URL="http://localhost:3000"
GRAFANA_USER="${GRAFANA_ADMIN_USER:-admin}"
GRAFANA_PASS="${GRAFANA_ADMIN_PASSWORD:-admin}"
PROMETHEUS_URL="http://localhost:9090"
LOKI_URL="http://localhost:3100"
TEMPO_URL="http://localhost:3200"
NODE_EXPORTER_URL="http://localhost:9100"
PROMTAIL_URL="http://localhost:9080"

# Expected counts
EXPECTED_DASHBOARDS=7
EXPECTED_DATASOURCES=5

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Track results
PASSED=0
FAILED=0
WARNINGS=0

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
log_info()    { echo -e "${CYAN}[INFO]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; ((WARNINGS++)) || true; }
log_pass()    { echo -e "${GREEN}[PASS]${NC} $1"; ((PASSED++)) || true; }
log_fail()    { echo -e "${RED}[FAIL]${NC} $1"; ((FAILED++)) || true; }
log_section() { echo -e "\n${BOLD}--- $1 ---${NC}"; }

# ---------------------------------------------------------------------------
# Generic check helpers
# ---------------------------------------------------------------------------

# Check if a Docker container is running
check_container() {
  local name=$1
  if docker ps --format '{{.Names}}' | grep -q "^${name}$"; then
    log_pass "Container '${name}' is running"
  else
    log_fail "Container '${name}' is NOT running"
  fi
}

# Check HTTP endpoint returns expected status code
# NOTE: Do NOT use curl -f here. The -f flag causes curl to exit non-zero on
# HTTP 4xx/5xx, but -w "%{http_code}" still writes the status code to stdout
# before the || fallback appends "000", producing concatenated codes like "503000".
check_http() {
  local label=$1 url=$2
  local expected=${3:-200} timeout=${4:-10}
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout "${timeout}" "${url}" 2>/dev/null || echo "000")
  if [ "${code}" == "${expected}" ]; then
    log_pass "${label} → ${code}"
  else
    log_fail "${label} → ${code} (expected ${expected})"
  fi
}

# Check HTTP endpoint with retries (for services with slow startup)
check_http_retry() {
  local label=$1 url=$2
  local expected=${3:-200} retries=${4:-6} delay=${5:-10}
  local attempt=1 code
  while [ "${attempt}" -le "${retries}" ]; do
    code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 "${url}" 2>/dev/null || echo "000")
    if [ "${code}" == "${expected}" ]; then
      log_pass "${label} → ${code} (ready after ${attempt} attempt(s))"
      return 0
    fi
    if [ "${attempt}" -lt "${retries}" ]; then
      log_info "${label} → ${code} (attempt ${attempt}/${retries}, retrying in ${delay}s...)"
      sleep "${delay}"
    fi
    ((attempt++))
  done
  log_fail "${label} → ${code} (expected ${expected}, failed after ${retries} attempts)"
}

# Check HTTP response body contains a string
check_http_contains() {
  local label=$1 url=$2 text=$3
  local timeout=${4:-10}
  local body
  body=$(curl -s --connect-timeout "${timeout}" "${url}" 2>/dev/null || echo "")
  if echo "${body}" | grep -q "${text}"; then
    log_pass "${label} — contains '${text}'"
  else
    log_fail "${label} — missing '${text}'"
  fi
}

# Grafana API call (with basic auth)
grafana_api() {
  curl -sf -u "${GRAFANA_USER}:${GRAFANA_PASS}" --connect-timeout 10 "${GRAFANA_URL}$1" 2>/dev/null || echo ""
}

# Prometheus API call
prom_api() {
  curl -sf --connect-timeout 10 "${PROMETHEUS_URL}$1" 2>/dev/null || echo ""
}

# ---------------------------------------------------------------------------
# Wait for services to start (post-deployment warm-up)
# ---------------------------------------------------------------------------
wait_for_services() {
  log_info "Waiting for monitoring services to be ready..."
  local attempt=1
  while [ "${attempt}" -le "${MAX_RETRIES}" ]; do
    log_info "Attempt ${attempt}/${MAX_RETRIES}..."
    if docker ps --format '{{.Names}}' | grep -q "grafana" &&
       docker ps --format '{{.Names}}' | grep -q "prometheus"; then
      log_info "Core services detected, proceeding with checks"
      # Brief pause for APIs to initialize
      sleep 5
      return 0
    fi
    log_warn "Services not ready, waiting ${RETRY_DELAY}s..."
    sleep "${RETRY_DELAY}"
    ((attempt++))
  done
  log_fail "Services did not start within timeout"
  return 1
}

# ---------------------------------------------------------------------------
# 1. Container Health
# ---------------------------------------------------------------------------
test_containers() {
  log_section "1. Container Health"

  # Core services (must be running)
  check_container "prometheus"
  check_container "grafana"
  check_container "node-exporter"
  check_container "loki"
  check_container "promtail"
  check_container "tempo"

  # Optional services (warn if missing)
  if docker ps --format '{{.Names}}' | grep -q "^github-actions-exporter$"; then
    log_pass "Container 'github-actions-exporter' is running"
  else
    log_warn "Container 'github-actions-exporter' not running (requires GITHUB_TOKEN)"
  fi
}

# ---------------------------------------------------------------------------
# 2. HTTP Health Endpoints
# ---------------------------------------------------------------------------
test_http_health() {
  log_section "2. HTTP Health Endpoints"

  # Grafana
  check_http "Grafana health" "${GRAFANA_URL}/api/health"
  check_http_contains "Grafana DB" "${GRAFANA_URL}/api/health" "ok"

  # Prometheus
  check_http "Prometheus healthy" "${PROMETHEUS_URL}/-/healthy"
  check_http "Prometheus ready" "${PROMETHEUS_URL}/-/ready"

  # Node Exporter
  check_http "Node Exporter metrics" "${NODE_EXPORTER_URL}/metrics"
  check_http_contains "Node CPU metric" "${NODE_EXPORTER_URL}/metrics" "node_cpu_seconds_total"

  # Loki — ingester/compactor/querier can take 30-60s to initialize
  check_http_retry "Loki ready" "${LOKI_URL}/ready" 200 6 10

  # Tempo — ring/compactor can take 30-60s to initialize
  check_http_retry "Tempo ready" "${TEMPO_URL}/ready" 200 6 10

  # Promtail (targets endpoint)
  check_http "Promtail targets" "${PROMTAIL_URL}/targets"
}

# ---------------------------------------------------------------------------
# 3. Grafana Validation
# ---------------------------------------------------------------------------
test_grafana() {
  log_section "3. Grafana Validation"

  # Datasource health — Grafana API returns status for each datasource
  local ds_response
  ds_response=$(grafana_api "/api/datasources")

  if [ -n "${ds_response}" ] && echo "${ds_response}" | jq -e '.' >/dev/null 2>&1; then
    local ds_count
    ds_count=$(echo "${ds_response}" | jq 'length')

    if [ "${ds_count}" -ge "${EXPECTED_DATASOURCES}" ]; then
      log_pass "Datasources provisioned: ${ds_count} (expected ≥${EXPECTED_DATASOURCES})"
    else
      log_fail "Datasources provisioned: ${ds_count} (expected ≥${EXPECTED_DATASOURCES})"
    fi

    # Test each datasource connectivity via health check API
    local ds_names
    ds_names=$(echo "${ds_response}" | jq -r '.[].uid')
    for uid in ${ds_names}; do
      local ds_name
      ds_name=$(echo "${ds_response}" | jq -r --arg uid "${uid}" '.[] | select(.uid==$uid) | .name')
      local health
      health=$(grafana_api "/api/datasources/uid/${uid}/health" 2>/dev/null || echo "")

      if echo "${health}" | grep -qi "ok\|success\|working"; then
        log_pass "Datasource '${ds_name}' connectivity OK"
      elif [ -z "${health}" ]; then
        # Some datasources (CloudWatch) don't support health check
        log_warn "Datasource '${ds_name}' health check not supported"
      else
        log_fail "Datasource '${ds_name}' health check failed"
      fi
    done
  else
    log_fail "Could not query Grafana datasources API"
  fi

  # Dashboard provisioning count
  local search_response
  search_response=$(grafana_api "/api/search?type=dash-db")

  if [ -n "${search_response}" ] && echo "${search_response}" | jq -e '.' >/dev/null 2>&1; then
    local dash_count
    dash_count=$(echo "${search_response}" | jq 'length')

    if [ "${dash_count}" -ge "${EXPECTED_DASHBOARDS}" ]; then
      log_pass "Dashboards provisioned: ${dash_count} (expected ≥${EXPECTED_DASHBOARDS})"
    else
      log_fail "Dashboards provisioned: ${dash_count} (expected ≥${EXPECTED_DASHBOARDS})"
    fi
  else
    log_fail "Could not query Grafana dashboards API"
  fi
}

# ---------------------------------------------------------------------------
# 4. Prometheus Validation
# ---------------------------------------------------------------------------
test_prometheus() {
  log_section "4. Prometheus Validation"

  # Active targets via API
  local targets_response
  targets_response=$(prom_api "/api/v1/targets")

  if [ -n "${targets_response}" ] && echo "${targets_response}" | jq -e '.data' >/dev/null 2>&1; then
    # Count active targets (up)
    local up_count down_count
    up_count=$(echo "${targets_response}" | jq '[.data.activeTargets[] | select(.health=="up")] | length')
    down_count=$(echo "${targets_response}" | jq '[.data.activeTargets[] | select(.health=="down")] | length')

    if [ "${up_count}" -gt 0 ]; then
      log_pass "Prometheus active targets UP: ${up_count}"
    else
      log_fail "No Prometheus targets are UP"
    fi

    if [ "${down_count}" -gt 0 ]; then
      # List which jobs are down
      local down_jobs
      down_jobs=$(echo "${targets_response}" | jq -r '[.data.activeTargets[] | select(.health=="down") | .labels.job] | unique | join(", ")')
      log_warn "Prometheus targets DOWN: ${down_count} (jobs: ${down_jobs})"
    else
      log_pass "No Prometheus targets are down"
    fi

    # Verify core scrape jobs exist
    local jobs
    jobs=$(echo "${targets_response}" | jq -r '[.data.activeTargets[].labels.job] | unique | .[]')
    for required_job in "prometheus" "node-exporter"; do
      if echo "${jobs}" | grep -q "^${required_job}$"; then
        log_pass "Scrape job '${required_job}' active"
      else
        log_fail "Scrape job '${required_job}' missing"
      fi
    done
  else
    log_fail "Could not query Prometheus targets API"
  fi

  # Alert rules loaded
  local rules_response
  rules_response=$(prom_api "/api/v1/rules")

  if [ -n "${rules_response}" ] && echo "${rules_response}" | jq -e '.data' >/dev/null 2>&1; then
    local rule_count
    rule_count=$(echo "${rules_response}" | jq '[.data.groups[].rules[]] | length')
    if [ "${rule_count}" -gt 0 ]; then
      log_pass "Alert rules loaded: ${rule_count}"
    else
      log_warn "No alert rules loaded"
    fi
  fi

  # Basic query — can Prometheus actually return data?
  local query_result
  query_result=$(prom_api "/api/v1/query?query=up")

  if [ -n "${query_result}" ] && echo "${query_result}" | jq -e '.data.result[0]' >/dev/null 2>&1; then
    log_pass "Prometheus query API functional (up metric returns data)"
  else
    log_fail "Prometheus query API returned no data for 'up' metric"
  fi
}

# ---------------------------------------------------------------------------
# 5. Data Pipeline Validation
# ---------------------------------------------------------------------------
test_data_pipeline() {
  log_section "5. Data Pipeline"

  # Loki — check ingestion by querying for recent log entries
  local loki_query
  loki_query=$(curl -sf --connect-timeout 10 \
    "${LOKI_URL}/loki/api/v1/query?query=%7Bjob%3D~%22.%2B%22%7D&limit=1" 2>/dev/null || echo "")

  if [ -n "${loki_query}" ] && echo "${loki_query}" | jq -e '.data' >/dev/null 2>&1; then
    local stream_count
    stream_count=$(echo "${loki_query}" | jq '.data.result | length')
    if [ "${stream_count}" -gt 0 ]; then
      log_pass "Loki has log streams ingested (${stream_count} active)"
    else
      log_warn "Loki responsive but no log streams found yet"
    fi
  else
    log_fail "Could not query Loki API"
  fi

  # Promtail — verify it has active targets
  local promtail_targets
  promtail_targets=$(curl -sf --connect-timeout 10 "${PROMTAIL_URL}/targets" 2>/dev/null || echo "")

  if [ -n "${promtail_targets}" ]; then
    log_pass "Promtail targets endpoint responsive"
  else
    log_fail "Promtail targets endpoint not responding"
  fi

  # Tempo — verify it accepts OTLP
  local tempo_status
  tempo_status=$(curl -sf --connect-timeout 10 "${TEMPO_URL}/status" 2>/dev/null || echo "")

  if [ -n "${tempo_status}" ]; then
    log_pass "Tempo status endpoint responsive"
  else
    log_warn "Tempo status endpoint not responding (may be initializing)"
  fi
}

# ---------------------------------------------------------------------------
# 6. Infrastructure Health
# ---------------------------------------------------------------------------
test_infrastructure() {
  log_section "6. Infrastructure"

  # EBS volume mount
  if mountpoint -q /data 2>/dev/null; then
    log_pass "EBS volume mounted at /data"
  else
    log_fail "EBS volume NOT mounted at /data"
  fi

  # Monitoring directory exists
  if [ -d "${MONITORING_DIR}" ]; then
    log_pass "Monitoring directory exists: ${MONITORING_DIR}"
  else
    log_fail "Monitoring directory missing: ${MONITORING_DIR}"
  fi

  # Disk space check on /data
  if mountpoint -q /data 2>/dev/null; then
    local usage
    usage=$(df /data | awk 'NR==2 {gsub(/%/,""); print $5}')
    if [ "${usage}" -lt "${DISK_THRESHOLD}" ]; then
      log_pass "Disk usage on /data: ${usage}% (threshold: ${DISK_THRESHOLD}%)"
    else
      log_fail "Disk usage on /data: ${usage}% (exceeds ${DISK_THRESHOLD}% threshold)"
    fi
  fi

  # Root filesystem check
  local root_usage
  root_usage=$(df / | awk 'NR==2 {gsub(/%/,""); print $5}')
  if [ "${root_usage}" -lt 90 ]; then
    log_pass "Root filesystem usage: ${root_usage}%"
  else
    log_fail "Root filesystem usage: ${root_usage}% (critical — above 90%)"
  fi

  # Docker daemon health
  if docker info >/dev/null 2>&1; then
    log_pass "Docker daemon healthy"

    # Container restart count (high restarts = instability)
    local restart_issues
    restart_issues=$(docker ps --format '{{.Names}} {{.Status}}' | grep -c "Restarting" || true)
    if [ "${restart_issues}" -eq 0 ]; then
      log_pass "No containers in restart loop"
    else
      log_fail "${restart_issues} container(s) in restart loop"
    fi
  else
    log_fail "Docker daemon not responding"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  echo "=============================================="
  echo "  Monitoring Stack — Production Smoke Tests"
  echo "=============================================="
  echo "  Host:      $(hostname 2>/dev/null || echo 'unknown')"
  echo "  Time:      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "  Threshold: disk≤${DISK_THRESHOLD}%"
  echo "=============================================="

  # Wait for services to be ready
  if ! wait_for_services; then
    log_fail "Aborting — services not ready after ${MAX_RETRIES} attempts"
    exit 1
  fi

  # Run all test categories
  test_containers
  test_http_health
  test_grafana
  test_prometheus
  test_data_pipeline
  test_infrastructure

  # Summary
  echo ""
  echo "=============================================="
  echo "  Results: ${PASSED} passed, ${FAILED} failed, ${WARNINGS} warnings"
  echo "=============================================="

  if [ "${FAILED}" -gt 0 ]; then
    log_fail "Smoke tests FAILED — ${FAILED} check(s) did not pass"
    exit 1
  else
    log_info "All smoke tests passed!"
    exit 0
  fi
}

main
