#!/bin/bash
#
# Connect to Monitoring Services via SSM Port Forwarding
#
# This script discovers the monitoring EC2 instance and establishes
# SSM port forwarding for Grafana and/or Prometheus.
#
# Usage:
#   ./connect-monitoring.sh [grafana|prometheus|both]
#
# Environment variables:
#   AWS_PROFILE          - AWS profile to use (default: dev-account)
#   ENVIRONMENT          - Target environment (default: development)
#   LOCAL_GRAFANA_PORT   - Local port for Grafana (default: 3000, auto-remaps on conflict)
#   LOCAL_PROMETHEUS_PORT - Local port for Prometheus (default: 9090, auto-remaps on conflict)
#

set -e

# Configuration
AWS_PROFILE="${AWS_PROFILE:-prod-account}"
ENVIRONMENT="${ENVIRONMENT:-production}"
SERVICE="${1:-grafana}"

# Remote port mappings (fixed — these are the ports on the EC2 instance)
GRAFANA_REMOTE_PORT=3000
PROMETHEUS_REMOTE_PORT=9090

# Local port mappings (configurable — these are the ports on your machine)
LOCAL_GRAFANA_PORT="${LOCAL_GRAFANA_PORT:-$GRAFANA_REMOTE_PORT}"
LOCAL_PROMETHEUS_PORT="${LOCAL_PROMETHEUS_PORT:-$PROMETHEUS_REMOTE_PORT}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}ℹ${NC} $1"; }
log_success() { echo -e "${GREEN}✓${NC} $1"; }
log_warn() { echo -e "${YELLOW}⚠${NC} $1"; }
log_error() { echo -e "${RED}✗${NC} $1"; }

# Check if a local port is available; handle conflicts interactively
# Sets the variable named by $3 to the resolved local port
check_port_available() {
    local port=$1
    local service_name=$2
    local result_var=$3

    # Check if port is in use
    local pid
    pid=$(lsof -ti :"$port" 2>/dev/null | head -1 || true)

    if [[ -z "$pid" ]]; then
        # Port is free
        eval "$result_var=$port"
        return 0
    fi

    # Port is occupied — show details
    local process_info
    process_info=$(lsof -i :"$port" -P -n 2>/dev/null | grep LISTEN | head -1 || echo "unknown process")
    log_warn "Port $port is already in use:"
    echo -e "  ${YELLOW}$process_info${NC}"
    echo ""

    # Offer choices
    local alt_port=$((port + 1))
    echo "  [1] Kill the process (PID $pid) and use port $port"
    echo "  [2] Use alternative port $alt_port instead"
    echo "  [3] Abort"
    echo ""
    read -rp "  Choose [1/2/3]: " choice

    case "$choice" in
        1)
            log_info "Killing process $pid on port $port..."
            kill "$pid" 2>/dev/null || true
            sleep 1
            # Verify it was killed
            if lsof -ti :"$port" &>/dev/null; then
                log_warn "Process still running, sending SIGKILL..."
                kill -9 "$pid" 2>/dev/null || true
                sleep 1
            fi
            if lsof -ti :"$port" &>/dev/null; then
                log_error "Could not free port $port"
                exit 1
            fi
            log_success "Port $port is now free"
            eval "$result_var=$port"
            ;;
        2)
            # Find next available port starting from alt_port
            while lsof -ti :"$alt_port" &>/dev/null; do
                alt_port=$((alt_port + 1))
            done
            log_success "Using alternative local port $alt_port → remote port $port"
            eval "$result_var=$alt_port"
            ;;
        *)
            log_info "Aborted"
            exit 0
            ;;
    esac
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI is not installed"
        exit 1
    fi
    
    if ! aws ssm describe-instance-information --query 'InstanceInformationList[0]' --profile "$AWS_PROFILE" &> /dev/null; then
        log_warn "SSM Session Manager plugin may not be installed or configured"
        echo "Install from: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html"
    fi
    
    log_success "Prerequisites OK"
}

# Find the monitoring EC2 instance
find_instance() {
    log_info "Finding Monitoring instance for environment: $ENVIRONMENT..."
    
    INSTANCE_ID=$(aws ec2 describe-instances \
        --filters \
            "Name=tag:Project,Values=Monitoring" \
            "Name=tag:Environment,Values=$ENVIRONMENT" \
            "Name=instance-state-name,Values=running" \
        --query "Reservations[0].Instances[0].InstanceId" \
        --output text \
        --profile "$AWS_PROFILE" 2>/dev/null)
    
    if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" ]]; then
        # Try without Environment tag (fallback)
        INSTANCE_ID=$(aws ec2 describe-instances \
            --filters \
                "Name=tag:Project,Values=Monitoring" \
                "Name=instance-state-name,Values=running" \
            --query "Reservations[0].Instances[0].InstanceId" \
            --output text \
            --profile "$AWS_PROFILE" 2>/dev/null)
    fi
    
    if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" ]]; then
        log_error "No running Monitoring instance found"
        echo ""
        echo "Make sure the Monitoring stack is deployed:"
        echo "  npx cdk deploy Monitoring-Compute-$ENVIRONMENT -c project=monitoring -c environment=$ENVIRONMENT"
        exit 1
    fi
    
    log_success "Found instance: $INSTANCE_ID"
}

# Check if monitoring services are running on the remote instance
check_services_running() {
    log_info "Checking if monitoring services are running on the instance..."
    
    # Send command to check docker container status
    local cmd_id
    cmd_id=$(aws ssm send-command \
        --instance-ids "$INSTANCE_ID" \
        --document-name "AWS-RunShellScript" \
        --parameters 'commands=["docker compose -f /opt/monitoring/docker-compose.yml ps --format json 2>/dev/null || docker-compose -f /opt/monitoring/docker-compose.yml ps 2>/dev/null || echo NO_CONTAINERS","ss -tlnp 2>/dev/null | grep -cE \"3000|9090\" || echo 0"]' \
        --query "Command.CommandId" \
        --output text \
        --profile "$AWS_PROFILE" 2>/dev/null)
    
    if [[ -z "$cmd_id" ]]; then
        log_warn "Could not check remote services (SSM command failed). Proceeding anyway..."
        return 0
    fi
    
    # Wait for command to complete (up to 15 seconds)
    local attempts=0
    local status=""
    while [[ $attempts -lt 15 ]]; do
        sleep 1
        status=$(aws ssm get-command-invocation \
            --command-id "$cmd_id" \
            --instance-id "$INSTANCE_ID" \
            --query "Status" \
            --output text \
            --profile "$AWS_PROFILE" 2>/dev/null)
        if [[ "$status" == "Success" || "$status" == "Failed" ]]; then
            break
        fi
        attempts=$((attempts + 1))
    done
    
    if [[ "$status" != "Success" ]]; then
        log_warn "Could not verify remote services. Proceeding anyway..."
        return 0
    fi
    
    # Check the output for listening ports
    local output
    output=$(aws ssm get-command-invocation \
        --command-id "$cmd_id" \
        --instance-id "$INSTANCE_ID" \
        --query "StandardOutputContent" \
        --output text \
        --profile "$AWS_PROFILE" 2>/dev/null)
    
    # If output contains NO_CONTAINERS or port count is 0, services aren't running
    if echo "$output" | grep -q "NO_CONTAINERS" || [[ "$(echo "$output" | tail -1)" == "0" ]]; then
        log_warn "Monitoring services are NOT running on the instance"
        echo ""
        echo -e "  ${YELLOW}The monitoring containers (Grafana, Prometheus, etc.) are not started.${NC}"
        echo -e "  This can happen after instance replacement or first boot."
        echo ""
        echo -e "  [1] Start services now (docker compose up -d)"
        echo -e "  [2] Continue anyway (port forwarding will likely fail)"
        echo -e "  [3] Abort"
        echo ""
        read -rp "  Choose [1/2/3]: " choice
        
        case "$choice" in
            1)
                log_info "Starting monitoring services on the instance..."
                local start_cmd_id
                start_cmd_id=$(aws ssm send-command \
                    --instance-ids "$INSTANCE_ID" \
                    --document-name "AWS-RunShellScript" \
                    --parameters 'commands=["cd /opt/monitoring && (docker compose up -d 2>/dev/null || docker-compose up -d) && echo STARTED_OK || echo STARTED_FAIL"]' \
                    --query "Command.CommandId" \
                    --output text \
                    --profile "$AWS_PROFILE" 2>/dev/null)
                
                # Wait for services to start (up to 60 seconds)
                echo -n "  Waiting for services to start"
                local start_attempts=0
                local start_status=""
                while [[ $start_attempts -lt 60 ]]; do
                    sleep 2
                    echo -n "."
                    start_status=$(aws ssm get-command-invocation \
                        --command-id "$start_cmd_id" \
                        --instance-id "$INSTANCE_ID" \
                        --query "Status" \
                        --output text \
                        --profile "$AWS_PROFILE" 2>/dev/null)
                    if [[ "$start_status" == "Success" || "$start_status" == "Failed" ]]; then
                        break
                    fi
                    start_attempts=$((start_attempts + 1))
                done
                echo ""
                
                if [[ "$start_status" == "Success" ]]; then
                    log_success "Monitoring services started successfully"
                    # Give containers a moment to bind ports
                    log_info "Waiting 5s for containers to initialize..."
                    sleep 5
                else
                    log_error "Failed to start services. Check instance logs."
                    exit 1
                fi
                ;;
            2)
                log_warn "Continuing without running services..."
                ;;
            3)
                log_info "Aborted"
                exit 0
                ;;
            *)
                log_error "Invalid choice"
                exit 1
                ;;
        esac
    else
        log_success "Monitoring services are running on the instance"
    fi
}

# Start port forwarding for a specific service
# Args: $1=remote_port  $2=local_port  $3=service_name
start_port_forward() {
    local remote_port=$1
    local local_port=$2
    local service_name=$3
    
    log_info "Starting port forward for $service_name on localhost:$local_port → remote:$remote_port..."
    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "  ${GREEN}$service_name${NC} is available at: ${BLUE}http://localhost:$local_port${NC}"
    
    if [[ "$service_name" == "Grafana" ]]; then
        echo -e "  Default credentials: admin / admin (change on first login)"
    fi
    
    if [[ "$service_name" == "Prometheus" ]]; then
        echo ""
        echo -e "  ${BLUE}Key pages:${NC}"
        echo -e "    Targets  → ${BLUE}http://localhost:$local_port/targets${NC}"
        echo -e "    Graph    → ${BLUE}http://localhost:$local_port/graph${NC}"
        echo -e "    Metrics  → ${BLUE}http://localhost:$local_port/metrics${NC}"
        echo -e "    Config   → ${BLUE}http://localhost:$local_port/config${NC}"
        echo -e "    Rules    → ${BLUE}http://localhost:$local_port/rules${NC}"
    fi
    
    if [[ "$local_port" != "$remote_port" ]]; then
        echo -e "  ${YELLOW}Note:${NC} Remapped from default port $remote_port → $local_port"
    fi
    
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "Press Ctrl+C to disconnect"
    echo ""
    
    aws ssm start-session \
        --target "$INSTANCE_ID" \
        --document-name AWS-StartPortForwardingSession \
        --parameters "{\"portNumber\":[\"$remote_port\"],\"localPortNumber\":[\"$local_port\"]}" \
        --profile "$AWS_PROFILE"
}

# Start both services in background (for 'both' option)
start_both_services() {
    # Resolve local ports (handles conflicts for both)
    check_port_available "$LOCAL_GRAFANA_PORT" "Grafana" LOCAL_GRAFANA_PORT
    check_port_available "$LOCAL_PROMETHEUS_PORT" "Prometheus" LOCAL_PROMETHEUS_PORT

    log_info "Starting port forwarding for both Grafana and Prometheus..."
    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "  ${GREEN}Grafana${NC}    → ${BLUE}http://localhost:$LOCAL_GRAFANA_PORT${NC}"
    echo -e "  ${GREEN}Prometheus${NC} → ${BLUE}http://localhost:$LOCAL_PROMETHEUS_PORT${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "Press Ctrl+C to disconnect both"
    echo ""
    
    # Start Prometheus in background
    aws ssm start-session \
        --target "$INSTANCE_ID" \
        --document-name AWS-StartPortForwardingSession \
        --parameters "{\"portNumber\":[\"$PROMETHEUS_REMOTE_PORT\"],\"localPortNumber\":[\"$LOCAL_PROMETHEUS_PORT\"]}" \
        --profile "$AWS_PROFILE" &
    PROMETHEUS_PID=$!
    
    # Start Grafana in foreground (keeps script running)
    aws ssm start-session \
        --target "$INSTANCE_ID" \
        --document-name AWS-StartPortForwardingSession \
        --parameters "{\"portNumber\":[\"$GRAFANA_REMOTE_PORT\"],\"localPortNumber\":[\"$LOCAL_GRAFANA_PORT\"]}" \
        --profile "$AWS_PROFILE"
    
    # Cleanup background process on exit
    kill $PROMETHEUS_PID 2>/dev/null || true
}

# Show usage
show_usage() {
    echo "Usage: $0 [grafana|prometheus|both]"
    echo ""
    echo "Options:"
    echo "  grafana     Connect to Grafana (port 3000) - default"
    echo "  prometheus  Connect to Prometheus (port 9090)"
    echo "  both        Connect to both services"
    echo ""
    echo "Environment variables:"
    echo "  AWS_PROFILE           AWS profile to use (default: dev-account)"
    echo "  ENVIRONMENT           Target environment (default: development)"
    echo "  LOCAL_GRAFANA_PORT    Local port for Grafana (default: 3000)"
    echo "  LOCAL_PROMETHEUS_PORT Local port for Prometheus (default: 9090)"
    echo ""
    echo "Examples:"
    echo "  $0                                    # Connect to Grafana"
    echo "  $0 prometheus                         # Connect to Prometheus"
    echo "  $0 both                               # Connect to both"
    echo "  LOCAL_GRAFANA_PORT=3001 $0 grafana     # Grafana on port 3001 (avoids conflict)"
    echo "  AWS_PROFILE=prod-account ENVIRONMENT=production $0 grafana"
}

# Main
main() {
    case "$SERVICE" in
        -h|--help|help)
            show_usage
            exit 0
            ;;
        grafana)
            check_prerequisites
            find_instance
            check_services_running
            check_port_available "$LOCAL_GRAFANA_PORT" "Grafana" LOCAL_GRAFANA_PORT
            start_port_forward $GRAFANA_REMOTE_PORT $LOCAL_GRAFANA_PORT "Grafana"
            ;;
        prometheus)
            check_prerequisites
            find_instance
            check_services_running
            check_port_available "$LOCAL_PROMETHEUS_PORT" "Prometheus" LOCAL_PROMETHEUS_PORT
            start_port_forward $PROMETHEUS_REMOTE_PORT $LOCAL_PROMETHEUS_PORT "Prometheus"
            ;;
        both)
            check_prerequisites
            find_instance
            check_services_running
            start_both_services
            ;;
        *)
            log_error "Unknown service: $SERVICE"
            show_usage
            exit 1
            ;;
    esac
}

main "$@"
