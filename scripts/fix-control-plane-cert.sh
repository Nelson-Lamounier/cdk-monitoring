#!/usr/bin/env bash
# =============================================================================
# fix-control-plane-cert.sh
#
# Diagnoses and fixes the API server certificate SAN mismatch that occurs
# after ASG replacement. The DR backup restores certs with the old instance
# IPs, causing kubelet TLS verification to fail and node registration to
# break.
#
# Usage:
#   ./scripts/fix-control-plane-cert.sh
#
# Prerequisites:
#   - AWS CLI configured with 'dev-account' profile
#   - SSM access to the control plane instance
#   - Instance must be running and reachable via SSM
# =============================================================================

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
REGION="eu-west-1"
PROFILE="dev-account"
SSM_PARAM="/k8s/development/instance-id"
KUBECONFIG_PATH="/etc/kubernetes/super-admin.conf"

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; }

# ── Helper: run an SSM command and return output ─────────────────────────────
run_on_instance() {
    local instance_id="$1"
    local commands="$2"
    local timeout="${3:-120}"

    local cmd_id
    cmd_id=$(aws ssm send-command \
        --region "$REGION" \
        --profile "$PROFILE" \
        --instance-ids "$instance_id" \
        --document-name "AWS-RunShellScript" \
        --timeout-seconds "$timeout" \
        --parameters "commands=[\"$commands\"]" \
        --query 'Command.CommandId' \
        --output text)

    # Wait for the command to complete
    local STATUS_IN_PROGRESS="InProgress"
    local status="$STATUS_IN_PROGRESS"
    local attempts=0
    while [[ "$status" == "$STATUS_IN_PROGRESS" ]] && [[ $attempts -lt 60 ]]; do
        sleep 3
        status=$(aws ssm get-command-invocation \
            --region "$REGION" \
            --profile "$PROFILE" \
            --command-id "$cmd_id" \
            --instance-id "$instance_id" \
            --query 'Status' \
            --output text 2>/dev/null || echo "$STATUS_IN_PROGRESS")
        ((attempts++))
    done

    if [[ "$status" == "$STATUS_IN_PROGRESS" ]]; then
        fail "Command timed out after $((attempts * 3))s"
        return 1
    fi

    # Get the output
    aws ssm get-command-invocation \
        --region "$REGION" \
        --profile "$PROFILE" \
        --command-id "$cmd_id" \
        --instance-id "$instance_id" \
        --query 'StandardOutputContent' \
        --output text

    if [[ "$status" != "Success" ]]; then
        warn "Command finished with status: $status"
        # Also show stderr
        aws ssm get-command-invocation \
            --region "$REGION" \
            --profile "$PROFILE" \
            --command-id "$cmd_id" \
            --instance-id "$instance_id" \
            --query 'StandardErrorContent' \
            --output text 2>/dev/null || true
        return 1
    fi
}

# =============================================================================
# Main
# =============================================================================

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Control Plane Certificate Fix Script"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── Step 1: Get instance ID ──────────────────────────────────────────────────
info "Fetching instance ID from SSM parameter: $SSM_PARAM"
INSTANCE_ID=$(aws ssm get-parameter \
    --region "$REGION" \
    --profile "$PROFILE" \
    --name "$SSM_PARAM" \
    --query 'Parameter.Value' \
    --output text)

if [[ -z "$INSTANCE_ID" ]]; then
    fail "Could not retrieve instance ID from $SSM_PARAM"
    exit 1
fi
ok "Instance ID: $INSTANCE_ID"

# ── Step 2: Diagnose current state ──────────────────────────────────────────
info "Diagnosing current certificate and cluster state..."
echo ""

DIAG_OUTPUT=$(run_on_instance "$INSTANCE_ID" "
set +e
PRIVATE_IP=\$(curl -s -H 'X-aws-ec2-metadata-token: '\$(curl -sX PUT http://169.254.169.254/latest/api/token -H X-aws-ec2-metadata-token-ttl-seconds:21600) http://169.254.169.254/latest/meta-data/local-ipv4)
PUBLIC_IP=\$(curl -s -H 'X-aws-ec2-metadata-token: '\$(curl -sX PUT http://169.254.169.254/latest/api/token -H X-aws-ec2-metadata-token-ttl-seconds:21600) http://169.254.169.254/latest/meta-data/public-ipv4)
echo DIAG_PRIVATE_IP=\$PRIVATE_IP
echo DIAG_PUBLIC_IP=\$PUBLIC_IP

echo DIAG_CERT_SANS_START
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -text 2>&1 | grep -A1 'Subject Alternative Name'
echo DIAG_CERT_SANS_END

echo DIAG_KUBELET_STATUS=\$(systemctl is-active kubelet)

echo DIAG_NODES_START
KUBECONFIG=$KUBECONFIG_PATH kubectl get nodes -o wide 2>&1
echo DIAG_NODES_END

echo DIAG_PODS_START
crictl ps --no-trunc 2>&1 | head -10
echo DIAG_PODS_END
")

echo "$DIAG_OUTPUT"
echo ""

# Parse the private IP from diagnostics
CURRENT_IP=$(echo "$DIAG_OUTPUT" | grep "DIAG_PRIVATE_IP=" | cut -d= -f2)
PUBLIC_IP=$(echo "$DIAG_OUTPUT" | grep "DIAG_PUBLIC_IP=" | cut -d= -f2)

# Check if the cert SANs include the current IP
if echo "$DIAG_OUTPUT" | grep -q "IP Address:${CURRENT_IP}"; then
    ok "API server certificate already includes current IP ($CURRENT_IP)"
    info "Checking node registration..."

    if echo "$DIAG_OUTPUT" | grep -q "No resources found"; then
        warn "Node not registered despite valid cert — checking kubelet..."
    else
        ok "Node is registered. No cert fix needed."
        echo ""

        # Show full cluster status
        info "Current cluster state:"
        run_on_instance "$INSTANCE_ID" "
export KUBECONFIG=$KUBECONFIG_PATH
echo '=== Nodes ==='
kubectl get nodes -o wide 2>&1
echo ''
echo '=== All pods ==='
kubectl get pods -A -o wide 2>&1
" 180
        exit 0
    fi
else
    fail "API server certificate does NOT include current IP ($CURRENT_IP)"
    warn "Certificate has old instance IPs — this is the SAN mismatch bug"
    echo ""
fi

# ── Step 3: Fix the certificate ─────────────────────────────────────────────
info "Fixing API server certificate..."
echo ""

FIX_OUTPUT=$(run_on_instance "$INSTANCE_ID" "
set -e
PRIVATE_IP=\$(curl -s -H 'X-aws-ec2-metadata-token: '\$(curl -sX PUT http://169.254.169.254/latest/api/token -H X-aws-ec2-metadata-token-ttl-seconds:21600) http://169.254.169.254/latest/meta-data/local-ipv4)
PUBLIC_IP=\$(curl -s -H 'X-aws-ec2-metadata-token: '\$(curl -sX PUT http://169.254.169.254/latest/api/token -H X-aws-ec2-metadata-token-ttl-seconds:21600) http://169.254.169.254/latest/meta-data/public-ipv4)

echo '>>> Step 3a: Remove stale apiserver cert'
rm -f /etc/kubernetes/pki/apiserver.crt /etc/kubernetes/pki/apiserver.key

echo '>>> Step 3b: Regenerate cert with correct SANs'
kubeadm init phase certs apiserver \\
    --apiserver-advertise-address=\$PRIVATE_IP \\
    --apiserver-cert-extra-sans=127.0.0.1,\$PRIVATE_IP,k8s-api.k8s.internal,\$PUBLIC_IP

echo '>>> Step 3c: Verify new cert SANs'
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -text | grep -A1 'Subject Alternative Name'

echo '>>> Step 3d: Restart kube-apiserver static pod'
crictl rm \$(crictl ps --name kube-apiserver -q) 2>/dev/null || true
sleep 5

echo '>>> Step 3e: Restart kubelet'
systemctl restart kubelet
sleep 15

echo '>>> Step 3f: Check node registration'
KUBECONFIG=$KUBECONFIG_PATH kubectl get nodes -o wide 2>&1
" 180)

echo "$FIX_OUTPUT"
echo ""

if echo "$FIX_OUTPUT" | grep -q "NotReady\|Ready"; then
    ok "Node is now registered!"
else
    warn "Node not yet registered — may need more time"
fi

# ── Step 4: Post-fix — label node and remove taints ─────────────────────────
info "Applying node labels and removing stale taints..."
echo ""

POST_OUTPUT=$(run_on_instance "$INSTANCE_ID" "
set +e
export KUBECONFIG=$KUBECONFIG_PATH
NODE_NAME=\$(hostname -f)

echo '>>> Labelling node as control-plane'
kubectl label node \$NODE_NAME node-role.kubernetes.io/control-plane= --overwrite 2>&1

echo '>>> Removing uninitialized taint (if present)'
kubectl taint nodes \$NODE_NAME node.cloudprovider.kubernetes.io/uninitialized:NoSchedule- 2>&1 || true

echo '>>> Cleaning up failed CCM Helm release (if present)'
helm uninstall aws-cloud-controller-manager -n kube-system 2>&1 || true

echo '>>> Waiting for node Ready (up to 120s)...'
kubectl wait --for=condition=Ready node/\$NODE_NAME --timeout=120s 2>&1

echo ''
echo '=== Final Node Status ==='
kubectl get nodes -o wide 2>&1

echo ''
echo '=== All Pods ==='
kubectl get pods -A -o wide 2>&1
" 300)

echo "$POST_OUTPUT"
echo ""

if echo "$POST_OUTPUT" | grep -q " Ready "; then
    ok "Control plane is fully operational!"
else
    warn "Node may still be stabilising — wait a few minutes and check with:"
    echo "  kubectl get nodes -o wide --context kubernetes-admin@kubernetes"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Fix complete. If the node is Ready, re-trigger the bootstrap"
echo "  automation to install remaining components (CCM, ArgoCD, etc)."
echo "═══════════════════════════════════════════════════════════════"
echo ""
