#!/usr/bin/env bash
# =============================================================================
# k8s Boot Script — Externalized from UserData
#
# All heavy bootstrap logic lives here (downloaded from S3 at boot time)
# to keep the EC2 LaunchTemplate user data under CloudFormation's 16KB limit.
#
# Expected environment variables (set by inline user data):
#   VOLUME_ID        — EBS volume ID to attach
#   MOUNT_POINT      — Mount point for EBS (default: /data)
#   DEVICE_NAME      — EBS device name (default: /dev/xvdf)
#   FS_TYPE          — Filesystem type (default: xfs)
#   STACK_NAME       — CloudFormation stack name (for cfn-signal)
#   ASG_LOGICAL_ID   — ASG logical ID (for cfn-signal)
#   K8S_VERSION      — Kubernetes version
#   DATA_DIR         — kubeadm data directory (default: /data/kubernetes)
#   POD_CIDR         — Pod network CIDR (default: 192.168.0.0/16)
#   SERVICE_CIDR     — Service subnet CIDR (default: 10.96.0.0/12)
#   SSM_PREFIX       — SSM parameter prefix (e.g. /k8s/development)
#   S3_BUCKET        — S3 bucket name for k8s manifests
#   CALICO_VERSION   — Calico CNI version (default: v3.29.3)
#   AWS_REGION       — AWS region
# =============================================================================

set -euxo pipefail

# Defaults
MOUNT_POINT="${MOUNT_POINT:-/data}"
DEVICE_NAME="${DEVICE_NAME:-/dev/xvdf}"
FS_TYPE="${FS_TYPE:-xfs}"
K8S_VERSION="${K8S_VERSION:-1.35.1}"
DATA_DIR="${DATA_DIR:-/data/kubernetes}"
POD_CIDR="${POD_CIDR:-192.168.0.0/16}"
SERVICE_CIDR="${SERVICE_CIDR:-10.96.0.0/12}"
SSM_PREFIX="${SSM_PREFIX:-/k8s/development}"
CALICO_VERSION="${CALICO_VERSION:-v3.29.3}"
AWS_REGION="${AWS_REGION:-eu-west-1}"

# =============================================================================
# 1. Attach and Mount EBS Volume
# =============================================================================

echo "=== Attaching EBS volume ==="

# Get instance metadata using IMDSv2
IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")

INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  http://169.254.169.254/latest/meta-data/placement/region)
AZ=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  http://169.254.169.254/latest/meta-data/placement/availability-zone)

if [ -z "$INSTANCE_ID" ] || [ -z "$REGION" ]; then
    echo "ERROR: Failed to retrieve instance metadata via IMDSv2"
    echo "INSTANCE_ID='$INSTANCE_ID' REGION='$REGION'"
    exit 1
fi

echo "Instance: $INSTANCE_ID, Region: $REGION, AZ: $AZ"
echo "Volume ID: $VOLUME_ID"

# Wait for volume to become available
EBS_MAX_WAIT=300
EBS_FORCE_DETACH_AFTER=120
EBS_POLL_INTERVAL=10
EBS_WAITED=0
EBS_FORCE_DETACHED=false

while true; do
    VOLUME_STATE=$(aws ec2 describe-volumes --volume-ids $VOLUME_ID \
        --query "Volumes[0].State" --output text --region $REGION 2>/dev/null || echo "not-found")
    echo "Volume state: $VOLUME_STATE (waited ${EBS_WAITED}s / ${EBS_MAX_WAIT}s)"

    if [ "$VOLUME_STATE" = "available" ]; then
        echo "Attaching volume $VOLUME_ID to $INSTANCE_ID as ${DEVICE_NAME}..."
        aws ec2 attach-volume --volume-id $VOLUME_ID --instance-id $INSTANCE_ID \
            --device ${DEVICE_NAME} --region $REGION
        echo "Waiting for volume to attach..."
        aws ec2 wait volume-in-use --volume-ids $VOLUME_ID --region $REGION
        sleep 5
        echo "Volume attached successfully"
        break

    elif [ "$VOLUME_STATE" = "in-use" ]; then
        ATTACHED_INSTANCE=$(aws ec2 describe-volumes --volume-ids $VOLUME_ID \
            --query "Volumes[0].Attachments[0].InstanceId" --output text --region $REGION)
        if [ "$ATTACHED_INSTANCE" = "$INSTANCE_ID" ]; then
            echo "Volume is already attached to this instance"
            break
        fi
        if [ $EBS_WAITED -ge $EBS_FORCE_DETACH_AFTER ] && [ "$EBS_FORCE_DETACHED" = "false" ]; then
            echo "WARNING: Volume still attached to $ATTACHED_INSTANCE after ${EBS_FORCE_DETACH_AFTER}s. Force-detaching..."
            aws ec2 detach-volume --volume-id $VOLUME_ID --instance-id $ATTACHED_INSTANCE --force --region $REGION || true
            EBS_FORCE_DETACHED=true
        else
            echo "Volume attached to $ATTACHED_INSTANCE (terminating). Waiting for detach..."
        fi

    elif [ "$VOLUME_STATE" = "detaching" ]; then
        echo "Volume is detaching from old instance. Waiting..."
    else
        echo "ERROR: Volume not found or in unexpected state: $VOLUME_STATE"
        exit 1
    fi

    if [ $EBS_WAITED -ge $EBS_MAX_WAIT ]; then
        echo "ERROR: Volume did not become available after ${EBS_MAX_WAIT}s"
        exit 1
    fi

    sleep $EBS_POLL_INTERVAL
    EBS_WAITED=$((EBS_WAITED + EBS_POLL_INTERVAL))
done

# Wait for device to appear (NVMe remapping)
DEVICE="${DEVICE_NAME}"
NVME_DEVICE=""

for i in {1..30}; do
    if [ -b "$DEVICE" ]; then
        echo "Device $DEVICE is ready"
        break
    fi

    for nvme_dev in /dev/nvme*n1; do
        [ -b "$nvme_dev" ] || continue
        MAPPED_VOL=$(ebsnvme-id -v "$nvme_dev" 2>/dev/null || echo "")
        if [ "$MAPPED_VOL" = "$VOLUME_ID" ]; then
            echo "Found NVMe device via ebsnvme-id: $nvme_dev -> $VOLUME_ID"
            NVME_DEVICE="$nvme_dev"
            break
        fi
    done

    if [ -n "$NVME_DEVICE" ] && [ -b "$NVME_DEVICE" ]; then
        DEVICE="$NVME_DEVICE"
        break
    fi

    echo "Waiting for device... ($i/30)"
    sleep 2
done

if [ ! -b "$DEVICE" ]; then
    echo "ERROR: Device $DEVICE not found after 60 seconds"
    exit 1
fi

FSTYPE=$(blkid -o value -s TYPE $DEVICE 2>/dev/null || echo "")
if [ -z "$FSTYPE" ]; then
    echo "No filesystem found, creating ${FS_TYPE} filesystem..."
    mkfs.${FS_TYPE} $DEVICE
fi

mkdir -p ${MOUNT_POINT}
echo "Mounting $DEVICE to ${MOUNT_POINT}..."
mount $DEVICE ${MOUNT_POINT}

if ! grep -q "${MOUNT_POINT}" /etc/fstab; then
    echo "$DEVICE ${MOUNT_POINT} ${FS_TYPE} defaults,nofail 0 2" >> /etc/fstab
    echo "Added mount to /etc/fstab"
fi

chown -R ec2-user:ec2-user ${MOUNT_POINT}
echo "EBS volume mounted at ${MOUNT_POINT}"

# =============================================================================
# 2. CloudFormation Signal: Infrastructure Ready
# =============================================================================

echo "=== Sending CloudFormation SUCCESS signal (infrastructure ready) ==="

if ! command -v /opt/aws/bin/cfn-signal &> /dev/null; then
    echo "Installing aws-cfn-bootstrap..."
    dnf install -y aws-cfn-bootstrap 2>/dev/null || true
fi

/opt/aws/bin/cfn-signal --success true \
    --stack "${STACK_NAME}" \
    --resource "${ASG_LOGICAL_ID}" \
    --region "${AWS_REGION}" && echo "Signal sent successfully" || echo "WARNING: cfn-signal failed"

echo "=== Infrastructure setup complete, proceeding to app config... ==="

# =============================================================================
# 3. System Update
# =============================================================================

# Ensure /usr/bin/sh exists (required by SSM Agent)
if [ ! -e /usr/bin/sh ]; then
    ln -sf /bin/bash /usr/bin/sh
    echo "Created /usr/bin/sh -> /bin/bash symlink for SSM Agent compatibility"
fi

dnf update -y

# =============================================================================
# 4. Initialize kubeadm Kubernetes Control Plane
# =============================================================================

echo "=== Initializing kubeadm cluster (v${K8S_VERSION}) ==="

mkdir -p ${DATA_DIR}

# Get instance metadata via IMDSv2 (refresh token)
IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || echo "")
PRIVATE_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)

# Start containerd
systemctl start containerd
echo "containerd started"

# Build apiserver cert SANs
CERT_SANS="--apiserver-cert-extra-sans=$PRIVATE_IP"
if [ -n "$PUBLIC_IP" ]; then
    CERT_SANS="$CERT_SANS,$PUBLIC_IP"
fi

echo "Running kubeadm init..."
kubeadm init \
    --kubernetes-version="${K8S_VERSION}" \
    --pod-network-cidr="${POD_CIDR}" \
    --service-cidr="${SERVICE_CIDR}" \
    --control-plane-endpoint="$PRIVATE_IP:6443" \
    $CERT_SANS \
    --upload-certs \
    2>&1 | tee /tmp/kubeadm-init.log

if [ ${PIPESTATUS[0]} -ne 0 ]; then
    echo "ERROR: kubeadm init failed"
    cat /tmp/kubeadm-init.log
    exit 1
fi

# Set up kubeconfig for root
export KUBECONFIG=/etc/kubernetes/admin.conf
mkdir -p /root/.kube
cp -f /etc/kubernetes/admin.conf /root/.kube/config
chmod 600 /root/.kube/config

# Wait for control plane
echo "Waiting for control plane to be ready..."
for i in {1..90}; do
    if kubectl get nodes &>/dev/null; then
        echo "Control plane is ready (waited ${i} seconds)"
        break
    fi
    if [ $i -eq 90 ]; then
        echo "WARNING: Control plane did not become ready in 90s"
    fi
    sleep 1
done

# Remove control plane taint
kubectl taint nodes --all node-role.kubernetes.io/control-plane- 2>/dev/null || true

# Publish join token + CA hash to SSM
JOIN_TOKEN=$(kubeadm token create --ttl 24h)
CA_HASH=$(openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt | \
    openssl rsa -pubin -outform der 2>/dev/null | \
    openssl dgst -sha256 -hex | awk '{print $2}')

aws ssm put-parameter --name "$SSM_PREFIX/join-token" --value "$JOIN_TOKEN" \
    --type "SecureString" --overwrite --region "$REGION" || echo "WARNING: Failed to store join-token in SSM"

aws ssm put-parameter --name "$SSM_PREFIX/ca-hash" --value "sha256:$CA_HASH" \
    --type "String" --overwrite --region "$REGION" || echo "WARNING: Failed to store ca-hash in SSM"

aws ssm put-parameter --name "$SSM_PREFIX/control-plane-endpoint" --value "$PRIVATE_IP:6443" \
    --type "String" --overwrite --region "$REGION" || echo "WARNING: Failed to store control-plane-endpoint in SSM"

aws ssm put-parameter --name "$SSM_PREFIX/instance-id" --value "$INSTANCE_ID" \
    --type "String" --overwrite --region "$REGION" || echo "WARNING: Failed to store instance-id in SSM"

if [ -n "$PUBLIC_IP" ]; then
    aws ssm put-parameter --name "$SSM_PREFIX/elastic-ip" --value "$PUBLIC_IP" \
        --type "String" --overwrite --region "$REGION" || echo "WARNING: Failed to store elastic-ip in SSM"
fi

echo "kubeadm cluster initialized successfully"
echo "Kubernetes version: $(kubectl version --short 2>/dev/null || kubectl version)"
echo "Node status:"
kubectl get nodes -o wide

# =============================================================================
# 5. Install Calico CNI
# =============================================================================

echo "=== Installing Calico CNI ==="

export KUBECONFIG=/etc/kubernetes/admin.conf

OPERATOR_YAML="/opt/calico/tigera-operator.yaml"
echo "Applying Calico operator..."
if [ -f "$OPERATOR_YAML" ]; then
    echo "  Using pre-cached operator from Golden AMI"
    kubectl create -f "$OPERATOR_YAML" 2>/dev/null || \
        kubectl apply -f "$OPERATOR_YAML"
else
    echo "  WARNING: Pre-cached operator not found, downloading from GitHub"
    kubectl create -f "https://raw.githubusercontent.com/projectcalico/calico/$CALICO_VERSION/manifests/tigera-operator.yaml" 2>/dev/null || \
        kubectl apply -f "https://raw.githubusercontent.com/projectcalico/calico/$CALICO_VERSION/manifests/tigera-operator.yaml"
fi

echo "Waiting for Calico operator..."
kubectl wait --for=condition=Available deployment/tigera-operator \
    -n tigera-operator --timeout=120s || echo "WARNING: Operator not ready in 120s"

cat <<CALICO_EOF | kubectl apply -f -
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    ipPools:
      - cidr: ${POD_CIDR}
        encapsulation: VXLANCrossSubnet
        natOutgoing: Enabled
        nodeSelector: all()
    linuxDataplane: Iptables
CALICO_EOF

echo "Waiting for Calico pods to become ready..."
for i in {1..120}; do
    READY=$(kubectl get pods -n calico-system --no-headers 2>/dev/null | grep -c "Running" || echo "0")
    TOTAL=$(kubectl get pods -n calico-system --no-headers 2>/dev/null | wc -l | tr -d ' ')
    if [ "$TOTAL" -gt 0 ] && [ "$READY" -eq "$TOTAL" ]; then
        echo "Calico pods ready (${READY}/${TOTAL}, waited ${i} seconds)"
        break
    fi
    if [ $i -eq 120 ]; then
        echo "WARNING: Calico pods not fully ready after 120s (${READY}/${TOTAL})"
        kubectl get pods -n calico-system
    fi
    sleep 1
done

echo "Calico CNI installed successfully"
kubectl get pods -n calico-system
kubectl get nodes -o wide

# =============================================================================
# 6. Configure kubectl Access
# =============================================================================

echo "=== Configuring kubectl access ==="

KUBECONFIG_SRC="/etc/kubernetes/admin.conf"

mkdir -p /root/.kube
cp -f $KUBECONFIG_SRC /root/.kube/config
chmod 600 /root/.kube/config

mkdir -p /home/ec2-user/.kube
cp -f $KUBECONFIG_SRC /home/ec2-user/.kube/config
chown ec2-user:ec2-user /home/ec2-user/.kube/config
chmod 600 /home/ec2-user/.kube/config

echo "export KUBECONFIG=$KUBECONFIG_SRC" > /etc/profile.d/kubernetes.sh
chmod 644 /etc/profile.d/kubernetes.sh

export KUBECONFIG=$KUBECONFIG_SRC
echo "kubectl configured. Cluster info:"
kubectl cluster-info
kubectl get namespaces

# =============================================================================
# 7. Deploy k8s Monitoring Manifests
# =============================================================================

echo "=== Downloading k8s manifests from S3 ==="
K8S_DIR="${MOUNT_POINT}/k8s"
mkdir -p $K8S_DIR

aws s3 sync s3://${S3_BUCKET}/k8s/ $K8S_DIR/ --region ${AWS_REGION}
echo "k8s bundle downloaded to $K8S_DIR"

# Restore execute permissions lost during S3 sync
find $K8S_DIR -name '*.sh' -exec chmod +x {} +

# Run the deploy script
export KUBECONFIG=/etc/kubernetes/admin.conf
export MANIFESTS_DIR="$K8S_DIR/manifests"

echo "Running deploy-manifests.sh..."
$K8S_DIR/apps/monitoring/deploy-manifests.sh

echo "=== k8s first-boot deployment complete ==="

# =============================================================================
# 8. Pre-seed Next.js Secrets
# =============================================================================

echo "=== Pre-seeding Next.js secrets ==="

export KUBECONFIG=/etc/kubernetes/admin.conf

# Derive frontend SSM prefix: /k8s/development -> /frontend/development
K8S_ENV="${SSM_PREFIX##*/}"
FRONTEND_SSM_PREFIX="/frontend/${K8S_ENV}"

kubectl create namespace nextjs-app --dry-run=client -o yaml | kubectl apply -f -

resolve_frontend_secret() {
    local param_name="$1"
    local ssm_path="${FRONTEND_SSM_PREFIX}/${param_name}"
    aws ssm get-parameter --name "${ssm_path}" --with-decryption \
        --query 'Parameter.Value' --output text \
        --region "${AWS_REGION}" 2>/dev/null || echo ""
}

DYNAMODB_TABLE_NAME=$(resolve_frontend_secret "dynamodb/table-name")
ASSETS_BUCKET_NAME=$(resolve_frontend_secret "s3/assets-bucket-name")
NEXT_PUBLIC_API_URL=$(resolve_frontend_secret "api/gateway-url")

SECRET_ARGS=""
[ -n "${DYNAMODB_TABLE_NAME}" ] && SECRET_ARGS="${SECRET_ARGS} --from-literal=DYNAMODB_TABLE_NAME=${DYNAMODB_TABLE_NAME}"
[ -n "${ASSETS_BUCKET_NAME}" ] && SECRET_ARGS="${SECRET_ARGS} --from-literal=ASSETS_BUCKET_NAME=${ASSETS_BUCKET_NAME}"
[ -n "${NEXT_PUBLIC_API_URL}" ] && SECRET_ARGS="${SECRET_ARGS} --from-literal=NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}"

if [ -n "${SECRET_ARGS}" ]; then
    kubectl create secret generic nextjs-secrets \
        ${SECRET_ARGS} \
        --namespace nextjs-app \
        --dry-run=client -o yaml | kubectl apply -f -
    echo "nextjs-secrets pre-seeded"
else
    echo "No Next.js secrets resolved - skipping"
fi

echo "=== Next.js secret pre-seeding complete ==="

# =============================================================================
# 9. Bootstrap ArgoCD
# =============================================================================

echo "=== Bootstrapping ArgoCD ==="

export KUBECONFIG=/etc/kubernetes/admin.conf
export ARGOCD_DIR="$K8S_DIR/system/argocd"

$K8S_DIR/system/argocd/bootstrap-argocd.sh || echo "WARNING: ArgoCD bootstrap failed -- manifests still applied via deploy scripts above"

echo "=== ArgoCD bootstrap complete ==="

# =============================================================================
# Done
# =============================================================================

echo ""
echo "=============================================="
echo "=== Boot script completed at $(date) ==="
echo "=============================================="
