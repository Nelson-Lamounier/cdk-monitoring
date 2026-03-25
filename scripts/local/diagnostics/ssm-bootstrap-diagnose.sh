#!/usr/bin/env bash
# ============================================================================
# SSM Bootstrap Diagnostic Script
# ============================================================================
#
# Consolidates the troubleshooting justfile recipes into a single,
# runnable diagnostic report:
#
#   1. Execution Status   — recent SSM Automation runs & per-step status
#   2. Step Logs          — stdout / stderr for the latest execution's steps
#   3. S3 Sync Status     — checks for stale bootstrap scripts in the bucket
#   4. CloudWatch Logs    — last N lines from each SSM document's log group
#   5. Summary & Next Steps
#
# Usage:
#   ./scripts/local/diagnostics/ssm-bootstrap-diagnose.sh
#   ./scripts/local/diagnostics/ssm-bootstrap-diagnose.sh --env staging --region eu-west-1
#   ./scripts/local/diagnostics/ssm-bootstrap-diagnose.sh --env development --profile dev-account --tail 100
#
# See also:
#   docs/runbooks/ssm-automation-deployment.md
# ============================================================================

set -euo pipefail

# ============================================================================
# LOG OUTPUT DIRECTORY
# ============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${SCRIPT_DIR}/.troubleshoot-logs"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/ssm-diagnose-$(date -u '+%Y%m%d-%H%M%S').log"

# Redirect all output to both terminal and log file (strip ANSI for file)
exec > >(tee >(sed 's/\x1b\[[0-9;]*m//g' > "${LOG_FILE}")) 2>&1

# ============================================================================
# DEFAULTS
# ============================================================================
ENV="${ENV:-development}"
REGION="${REGION:-eu-west-1}"
PROFILE="${PROFILE:-dev-account}"
TAIL_LINES="${TAIL_LINES:-50}"
S3_FILE_COUNT="${S3_FILE_COUNT:-10}"
EXEC_COUNT="${EXEC_COUNT:-3}"

# ============================================================================
# COLOUR PALETTE
# ============================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ============================================================================
# CLI ARGUMENT PARSING
# ============================================================================
while [[ $# -gt 0 ]]; do
    case "$1" in
        --env)       ENV="$2";        shift 2 ;;
        --region)    REGION="$2";     shift 2 ;;
        --profile)   PROFILE="$2";   shift 2 ;;
        --tail)      TAIL_LINES="$2"; shift 2 ;;
        --s3-count)  S3_FILE_COUNT="$2"; shift 2 ;;
        --exec-count) EXEC_COUNT="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --env NAME        Environment name (default: development)"
            echo "  --region REGION   AWS region (default: eu-west-1)"
            echo "  --profile NAME    AWS CLI profile (default: dev-account)"
            echo "  --tail N          Number of log lines to show (default: 50)"
            echo "  --s3-count N      Number of S3 objects to show (default: 10)"
            echo "  --exec-count N    Number of executions to show (default: 3)"
            echo "  -h, --help        Show this help message"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Map environment to short env prefix used by CDK
case "${ENV}" in
    development) SHORT_ENV="dev" ;;
    staging)     SHORT_ENV="stg" ;;
    production)  SHORT_ENV="prd" ;;
    *)           SHORT_ENV="${ENV}" ;;
esac

# SSM document names follow the pattern: k8s-{shortEnv}-bootstrap-{role}
DOC_PREFIX="k8s-${SHORT_ENV}-bootstrap"
DOCUMENTS=("${DOC_PREFIX}-control-plane" "${DOC_PREFIX}-worker")

# S3 bucket — resolved from SSM parameter at runtime
SSM_BUCKET_KEY="/k8s/${ENV}/scripts-bucket"
S3_PREFIXES=("k8s-bootstrap/" "platform/charts/" "workloads/charts/")

# Common AWS CLI flags
AWS_FLAGS="--region ${REGION} --profile ${PROFILE}"

# ============================================================================
# HELPERS
# ============================================================================

# Print a section banner
banner() {
    local title="$1"
    local width=60
    echo ""
    echo -e "${CYAN}$(printf '═%.0s' $(seq 1 $width))${NC}"
    echo -e "${CYAN}  ${BOLD}$title${NC}"
    echo -e "${CYAN}$(printf '═%.0s' $(seq 1 $width))${NC}"
    echo ""
}

# Print a sub-section header
sub_header() {
    local title="$1"
    echo ""
    echo -e "  ${BOLD}▸ $title${NC}"
    echo -e "  ${DIM}$(printf '─%.0s' $(seq 1 50))${NC}"
}

# ============================================================================
# SECTION 1: EXECUTION STATUS
# ============================================================================
banner "1. SSM Automation Execution Status"

for doc in "${DOCUMENTS[@]}"; do
    sub_header "📄  ${doc}"
    echo ""

    # Fetch last N executions using the correct AWS CLI command
    EXEC_DATA=$(aws ssm describe-automation-executions \
        ${AWS_FLAGS} \
        --filters "Key=DocumentNamePrefix,Values=${doc}" \
        --max-results "${EXEC_COUNT}" \
        --query "AutomationExecutionMetadataList[*].[AutomationExecutionId,AutomationExecutionStatus,ExecutionStartTime,ExecutionEndTime]" \
        --output text 2>/dev/null || echo "")

    if [[ -z "$EXEC_DATA" ]]; then
        echo -e "  ${DIM}(no executions found)${NC}"
        continue
    fi

    while IFS=$'\t' read -r EXEC_ID STATUS START END; do
        echo -e "  ▸ ${EXEC_ID}"
        echo -e "    Status: ${STATUS}  |  Start: ${START}  |  End: ${END:-—}"
        echo "    Steps:"

        aws ssm get-automation-execution \
            ${AWS_FLAGS} \
            --automation-execution-id "${EXEC_ID}" \
            --query "AutomationExecution.StepExecutions[*].[StepName,StepStatus]" \
            --output text 2>/dev/null | \
            while IFS=$'\t' read -r STEP_NAME STEP_STATUS; do
                case "${STEP_STATUS}" in
                    Success)    ICON="✅" ;;
                    Failed)     ICON="❌" ;;
                    InProgress) ICON="🔄" ;;
                    Cancelled)  ICON="⛔" ;;
                    TimedOut)   ICON="⏰" ;;
                    *)          ICON="⬜" ;;
                esac
                printf "      %s  %-40s %s\n" "${ICON}" "${STEP_NAME}" "${STEP_STATUS}"
            done || echo -e "  ${DIM}(could not fetch step details)${NC}"
        echo ""
    done <<< "$EXEC_DATA"
done

# ============================================================================
# SECTION 2: STEP LOGS (stdout / stderr)
# ============================================================================
banner "2. SSM Step Logs (Latest Execution)"

for doc in "${DOCUMENTS[@]}"; do
    sub_header "📄  ${doc} — Output"
    echo ""

    # Get latest execution ID
    latest_id=$(aws ssm describe-automation-executions \
        ${AWS_FLAGS} \
        --filters "Key=DocumentNamePrefix,Values=${doc}" \
        --max-results 1 \
        --query "AutomationExecutionMetadataList[0].AutomationExecutionId" \
        --output text 2>/dev/null || true)

    if [[ -z "$latest_id" ]] || [[ "$latest_id" == "None" ]]; then
        echo -e "  ${DIM}(no execution found)${NC}"
        continue
    fi

    # Get all steps and their outputs
    aws ssm get-automation-execution \
        ${AWS_FLAGS} \
        --automation-execution-id "${latest_id}" \
        --output json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
steps = data.get('AutomationExecution', {}).get('StepExecutions', [])
for step in steps:
    name = step.get('StepName', 'N/A')
    status = step.get('StepStatus', 'Unknown')
    outputs = step.get('Outputs', {})
    print(f'  ┌─ {name} [{status}]')

    # Try to get RunShellScript outputs
    stdout_key = 'RunShellScript.Output'
    if stdout_key in outputs:
        stdout = outputs[stdout_key][0] if outputs[stdout_key] else ''
    else:
        stdout = ''
    if stdout:
        lines = stdout.strip().split('\n')
        for line in lines[-10:]:
            print(f'  │  {line}')
    else:
        # Try other output keys
        for key, val in outputs.items():
            v = val[0] if isinstance(val, list) and val else str(val)
            if v:
                truncated = v[:200] + '...' if len(v) > 200 else v
                print(f'  │  {key}: {truncated}')

    failure = step.get('FailureMessage', '')
    if failure:
        print(f'  │  ⚠ FAILURE: {failure}')
    print(f'  └─')
    print()
" 2>/dev/null || echo -e "  ${DIM}(could not fetch step logs)${NC}"
done

# ============================================================================
# SECTION 3: S3 SYNC STATUS
# ============================================================================
banner "3. S3 Bootstrap Scripts — Sync Status"

# Resolve bucket name from SSM parameter
BUCKET_NAME=$(aws ssm get-parameter \
    ${AWS_FLAGS} \
    --name "${SSM_BUCKET_KEY}" \
    --query 'Parameter.Value' \
    --output text 2>/dev/null | sed 's|^s3://||;s|/$||' || true)

if [[ -z "$BUCKET_NAME" ]]; then
    echo -e "  ${RED}❌ SSM parameter ${SSM_BUCKET_KEY} not found.${NC}"
    echo -e "  ${DIM}Has the infrastructure pipeline been deployed?${NC}"
else
    echo -e "  ${BOLD}Bucket:${NC} s3://${BUCKET_NAME}"
    echo ""

    for prefix in "${S3_PREFIXES[@]}"; do
        sub_header "🪣  s3://${BUCKET_NAME}/${prefix}"
        echo ""

        LISTING=$(aws s3api list-objects-v2 \
            ${AWS_FLAGS} \
            --bucket "${BUCKET_NAME}" \
            --prefix "${prefix}" \
            --query "Contents[*].{Key:Key,Modified:LastModified,Size:Size}" \
            --output json 2>/dev/null || echo "[]")

        count=$(echo "$LISTING" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(len(d) if isinstance(d, list) else 0)
" 2>/dev/null || echo "0")

        if [[ "$count" == "0" ]] || [[ "$count" == "null" ]]; then
            echo -e "  ${RED}⚠  No objects found — scripts may not have been synced${NC}"
            continue
        fi

        # Show newest modification and total count
        echo "$LISTING" | python3 -c "
import sys, json
from datetime import datetime, timezone
data = json.load(sys.stdin)
if not isinstance(data, list):
    sys.exit(0)
now = datetime.now(timezone.utc)
newest_ts = None
for obj in data:
    key = obj.get('Key', 'N/A')
    size = obj.get('Size', 0)
    modified = obj.get('Modified', 'N/A')

    try:
        mod_dt = datetime.fromisoformat(modified.replace('Z', '+00:00'))
        age = now - mod_dt
        hours = age.total_seconds() / 3600
        if hours < 1:
            age_str = f'{int(age.total_seconds() / 60)}m ago'
        elif hours < 24:
            age_str = f'{int(hours)}h ago'
        else:
            age_str = f'{int(hours / 24)}d ago'
        if newest_ts is None or mod_dt > newest_ts:
            newest_ts = mod_dt
    except Exception:
        age_str = 'unknown'

    size_kb = size / 1024
    print(f'    {key:<55}  {size_kb:>6.1f} KB  {age_str:>8}')

print()
total = len(data)
print(f'    Total: {total} file(s)')
" 2>/dev/null
    done
fi

# ============================================================================
# SECTION 4: CLOUDWATCH LOGS
# ============================================================================
banner "4. CloudWatch Logs (last ${TAIL_LINES} lines)"

# Log groups match the CDK-configured CloudWatchOutputConfig in automation-document.ts
# Bootstrap: /ssm/k8s/{env}/bootstrap  |  Deploy: /ssm/k8s/{env}/deploy
SSM_LOG_GROUPS=(
    "/ssm/k8s/${ENV}/bootstrap"
    "/ssm/k8s/${ENV}/deploy"
)

for log_group in "${SSM_LOG_GROUPS[@]}"; do
    sub_header "📋  ${log_group}"
    echo ""

    # Check if the log group exists
    group_exists=$(aws logs describe-log-groups \
        ${AWS_FLAGS} \
        --log-group-name-prefix "${log_group}" \
        --output json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
groups = data.get('logGroups', [])
for g in groups:
    if g.get('logGroupName') == '${log_group}':
        print('yes')
        break
else:
    print('no')
" 2>/dev/null || echo "no")

    if [[ "$group_exists" != "yes" ]]; then
        echo -e "  ${DIM}(log group not found — deploy SSM Automation stack first)${NC}"
        continue
    fi

    # Get the latest log stream
    latest_stream=$(aws logs describe-log-streams \
        ${AWS_FLAGS} \
        --log-group-name "${log_group}" \
        --order-by "LastEventTime" \
        --descending \
        --max-items 1 \
        --output json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
streams = data.get('logStreams', [])
if streams:
    print(streams[0].get('logStreamName', ''))
" 2>/dev/null || true)

    if [[ -z "$latest_stream" ]]; then
        echo -e "  ${DIM}(no log streams found — automation may not have run yet)${NC}"
        continue
    fi

    echo -e "  ${DIM}Stream: ${latest_stream}${NC}"
    echo ""

    aws logs get-log-events \
        ${AWS_FLAGS} \
        --log-group-name "${log_group}" \
        --log-stream-name "${latest_stream}" \
        --limit "${TAIL_LINES}" \
        --output json 2>/dev/null | python3 -c "
import sys, json
from datetime import datetime, timezone
data = json.load(sys.stdin)
events = data.get('events', [])
for event in events:
    ts = event.get('timestamp', 0)
    msg = event.get('message', '').rstrip()
    dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
    time_str = dt.strftime('%H:%M:%S')
    print(f'    {time_str}  {msg}')
" 2>/dev/null || echo -e "  ${DIM}(could not fetch log events)${NC}"
done

# ============================================================================
# SECTION 5: SUMMARY & NEXT STEPS
# ============================================================================
banner "5. Summary & Next Steps"

echo -e "  ${BOLD}Environment:${NC}  ${ENV} (${SHORT_ENV})"
echo -e "  ${BOLD}Region:${NC}       ${REGION}"
echo -e "  ${BOLD}Profile:${NC}      ${PROFILE}"
echo -e "  ${BOLD}Documents:${NC}    ${DOCUMENTS[*]}"
echo ""
echo -e "  ${BOLD}Troubleshooting Checklist:${NC}"
echo ""
echo -e "  ${DIM}1.${NC} Check execution status above — are there ${RED}Failed${NC} steps?"
echo -e "  ${DIM}2.${NC} Review step logs for ${RED}⚠ FAILURE${NC} messages"
echo -e "  ${DIM}3.${NC} Verify S3 scripts are recent — stale scripts cause drift"
echo -e "  ${DIM}4.${NC} Check CloudWatch logs for detailed error output"
echo ""
echo -e "  ${BOLD}Common Fixes:${NC}"
echo ""
echo -e "  ${DIM}•${NC} Stale S3 scripts    → Re-run CDK deploy or \`just cdk-deploy\`"
echo -e "  ${DIM}•${NC} Missing SSM params   → Check EC2 user data published instance IDs"
echo -e "  ${DIM}•${NC} Timeout on steps     → Increase timeout in SSM document definition"
echo -e "  ${DIM}•${NC} Permission errors    → Verify instance role has required policies"
echo ""
echo -e "  ${BOLD}Useful Commands:${NC}"
echo ""
echo -e "  ${DIM}•${NC} just ssm-bootstrap-status   — Quick status check"
echo -e "  ${DIM}•${NC} just ssm-diagnose            — Run this script"
echo -e "  ${DIM}•${NC} just ssm-s3-sync-status      — S3 sync details"
echo -e "  ${DIM}•${NC} just ssm-bootstrap-logs      — CloudWatch log tail"

echo ""
echo -e "${DIM}Report generated at $(date -u '+%Y-%m-%d %H:%M:%S UTC')${NC}"
echo -e "${DIM}Log saved to: ${LOG_FILE}${NC}"
echo ""
