/**
 * @format
 * User Data Script Builder
 *
 * Fluent interface for constructing EC2 user data scripts.
 * Operates directly on a CDK `ec2.UserData` object so that CDK Tokens
 * (e.g. `props.volumeId`, `this.stackName`) resolve correctly via
 * CloudFormation's `Fn::Join`.
 *
 * ## Generic Methods (use in any project)
 * - `updateSystem()` - Run system package updates
 * - `installDocker()` - Install Docker and Docker Compose
 * - `installAwsCli()` - Install AWS CLI v2
 * - `attachEbsVolume()` - Attach and mount an EBS volume
 * - `sendCfnSignal()` - Send CloudFormation signal for ASG validation
 * - `triggerSsmConfiguration()` - Fire SSM Run Command (fire-and-forget)
 * - `addCustomScript()` - Add any custom script section
 * - `addCompletionMarker()` - Add final success banner
 *
 * ## Kubernetes (kubeadm) Methods
 * - `initKubeadmCluster()` - Initialize kubeadm control plane
 * - `joinKubeadmCluster()` - Join a node to an existing kubeadm cluster
 * - `configureKubeconfig()` - Set up kubectl access
 *
 * ## Monitoring-Specific Methods
 * - `downloadAndStartMonitoringStack()` - Download monitoring stack from S3 and start it
 *
 * @example Monitoring project usage
 * ```typescript
 * const userData = ec2.UserData.forLinux();
 * new UserDataBuilder(userData)
 *     .updateSystem()
 *     .installDocker()
 *     .installAwsCli()
 *     .attachEbsVolume({ volumeId: props.volumeId, mountPoint: '/data' })
 *     .sendCfnSignal({ stackName: stack.stackName, asgLogicalId })
 *     .triggerSsmConfiguration({
 *         documentName: ssmDocumentName,
 *         region: stack.region,
 *         fireAndForget: true,
 *     })
 *     .addCompletionMarker();
 * ```
 *
 * @example Other project usage
 * ```typescript
 * const userData = ec2.UserData.forLinux();
 * new UserDataBuilder(userData)
 *     .updateSystem()
 *     .installDocker()
 *     .addCustomScript(`
 *         docker pull my-registry/nextjs-app:latest
 *         docker run -d -p 3000:3000 my-registry/nextjs-app:latest
 *     `)
 *     .addCompletionMarker();
 * ```
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

/**
 * Configuration for EBS volume attachment.
 * Used by `attachEbsVolume()` method.
 */
export interface EbsVolumeConfig {
    /** EBS volume ID (supports CDK Tokens) */
    volumeId: string;
    /** Mount point path */
    mountPoint: string;
    /** Device name @default '/dev/xvdf' */
    deviceName?: string;
    /** Filesystem type @default 'xfs' */
    fsType?: string;
    /** SSM parameter path to look up volume ID dynamically */
    ssmParameterPath?: string;
}

/**
 * Configuration for downloading and starting the monitoring stack from S3.
 * Used by `downloadAndStartMonitoringStack()` method.
 */
export interface MonitoringStackS3Config {
    /** S3 bucket name containing the monitoring stack bundle */
    s3BucketName: string;
    /** S3 key prefix where monitoring files are stored @default 'scripts' */
    s3KeyPrefix?: string;
    /** Local directory to sync monitoring stack into @default '/opt/monitoring' */
    monitoringDir?: string;
    /** Grafana admin password @default 'admin' */
    grafanaPassword?: string;
    /** AWS region @default 'eu-west-1' */
    region?: string;
    /**
     * SSM parameter prefix for storing monitoring endpoints.
     * Uses the monitoring prefix convention: /monitoring-{environment}
     * @example '/monitoring-production'
     */
    ssmPrefix: string;
}

/**
 * Configuration for triggering an SSM Run Command document.
 * Used by `triggerSsmConfiguration()` method.
 */
export interface SsmTriggerConfig {
    /** SSM Document name to execute (supports CDK Tokens) */
    documentName: string;

    /** Parameters to pass to the SSM document */
    parameters?: Record<string, string>;

    /** AWS region (supports CDK Tokens) @default 'eu-west-1' */
    region?: string;

    /** Timeout in seconds to wait for completion @default 600 */
    timeoutSeconds?: number;

    /**
     * When true, sends the SSM command without polling for completion.
     * Non-fatal: failures are logged but don't exit the script.
     * @default false
     */
    fireAndForget?: boolean;
}

/**
 * Options for the UserDataBuilder constructor.
 */
export interface UserDataBuilderOptions {
    /**
     * Skip the bash preamble (shebang, set -euxo pipefail, exec logging).
     * Set to true when the caller has already added preamble to the UserData.
     * @default false
     */
    skipPreamble?: boolean;
}

/**
 * Configuration for kubeadm cluster initialization.
 * Used by `initKubeadmCluster()` method.
 */
export interface KubeadmInitConfig {
    /** Kubernetes version (e.g., '1.35.1') @default '1.35.1' */
    kubernetesVersion?: string;
    /** Kubernetes data directory (etcd, kubelet) @default '/data/kubernetes' */
    dataDir?: string;
    /** Pod network CIDR for Calico CNI @default '192.168.0.0/16' */
    podNetworkCidr?: string;
    /** Service subnet CIDR @default '10.96.0.0/12' */
    serviceSubnet?: string;
    /** SSM parameter prefix for storing cluster info @default '/k8s/development' */
    ssmPrefix?: string;
}

/**
 * Configuration for downloading and deploying k8s manifests from S3.
 * Used by `deployK8sManifests()` method.
 */
export interface K8sManifestsS3Config {
    /** S3 bucket name containing the k8s scripts/manifests */
    readonly s3BucketName: string;
    /** S3 key prefix for the k8s directory @default 'k8s' */
    readonly s3KeyPrefix?: string;
    /** Local directory to store manifests @default '/data/k8s' */
    readonly manifestsDir?: string;
    /** SSM prefix for resolving secrets @default '/k8s/development' */
    readonly ssmPrefix?: string;
    /** AWS region @default 'eu-west-1' */
    readonly region?: string;
}

/**
 * Configuration for kubeadm join (worker node).
 * Used by `joinKubeadmCluster()` method.
 *
 * The worker joins an existing kubeadm cluster using the bootstrap
 * token and CA certificate hash published to SSM by the control plane.
 */
export interface KubeadmJoinConfig {
    /** Control plane endpoint (e.g., '10.0.0.10:6443') */
    readonly controlPlaneEndpoint: string;
    /** SSM parameter path where the join token is stored */
    readonly tokenSsmPath: string;
    /** SSM parameter path where the CA certificate hash is stored */
    readonly caHashSsmPath: string;
    /** Kubernetes node label for workload isolation (e.g., 'role=application') */
    readonly nodeLabel: string;
    /** Kubernetes node taint for workload isolation (e.g., 'role=application:NoSchedule') */
    readonly nodeTaint: string;
    /** AWS region for SSM lookups @default 'eu-west-1' */
    readonly region?: string;
}

// =============================================================================
// USER DATA BUILDER CLASS
// =============================================================================

/**
 * Builder class for EC2 user data scripts.
 *
 * Operates directly on a CDK `ec2.UserData` object, so CDK Tokens
 * (CloudFormation references like `props.volumeId`, `this.stackName`)
 * resolve correctly at synth time via `Fn::Join`.
 *
 * Provides a fluent interface — each method returns `this` for chaining.
 *
 * @remarks
 * - All methods are generic and can be used by any project
 * - `downloadAndStartMonitoringStack()` is designed for the Monitoring project
 * - Use `addCustomScript()` for project-specific setup
 */
export class UserDataBuilder {
    private readonly userData: ec2.UserData;

    constructor(userData: ec2.UserData, options?: UserDataBuilderOptions) {
        this.userData = userData;

        if (!options?.skipPreamble) {
            this.userData.addCommands(
                '#!/bin/bash',
                'set -euxo pipefail',
                '',
                '# Log all output',
                'exec > >(tee /var/log/user-data.log) 2>&1',
                '',
                'echo "=== User data script started at $(date) ==="',
            );
        }
    }

    // =========================================================================
    // GENERIC METHODS - Use in any project
    // =========================================================================

    /**
     * Add system update commands.
     *
     * @remarks Generic - can be used by any project.
     * @returns this - for method chaining
     */
    updateSystem(): this {
        this.userData.addCommands(`
# Ensure /usr/bin/sh exists (required by SSM Agent's aws:runShellScript action).
# Amazon Linux 2023 only has /bin/bash and /bin/sh; the SSM agent expects
# /usr/bin/sh and fails with "fork/exec /usr/bin/sh: no such file or directory"
# if the symlink is missing.
if [ ! -e /usr/bin/sh ]; then
    ln -sf /bin/bash /usr/bin/sh
    echo "Created /usr/bin/sh -> /bin/bash symlink for SSM Agent compatibility"
fi

# Update system packages
dnf update -y`);
        return this;
    }

    /**
     * Install Docker and Docker Compose.
     *
     * @param composeVersion - Docker Compose version to install
     * @remarks Generic - can be used by any project.
     * @returns this - for method chaining
     */
    installDocker(composeVersion = 'v2.24.0'): this {
        this.userData.addCommands(`
# Install Docker
dnf install -y docker
systemctl start docker
systemctl enable docker
usermod -aG docker ec2-user

# Detect architecture for multi-arch support (x86_64 / aarch64 Graviton)
COMPOSE_ARCH=$(uname -m)

# Install Docker Compose v2 plugin (preferred: 'docker compose' syntax)
DOCKER_COMPOSE_VERSION="${composeVersion}"
mkdir -p /usr/local/lib/docker/cli-plugins
curl -SL "https://github.com/docker/compose/releases/download/\${DOCKER_COMPOSE_VERSION}/docker-compose-linux-\${COMPOSE_ARCH}" \\
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Also install v1 standalone binary for backward compatibility
cp /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose
ln -sf /usr/local/bin/docker-compose /usr/bin/docker-compose

# Verify installation
echo "Docker Compose plugin: $(docker compose version 2>/dev/null || echo 'NOT AVAILABLE')"
echo "Docker Compose standalone: $(docker-compose --version 2>/dev/null || echo 'NOT AVAILABLE')"`);
        return this;
    }

    /**
     * Install AWS CLI v2 (if not already installed).
     *
     * @remarks Generic - can be used by any project.
     * @returns this - for method chaining
     */
    installAwsCli(): this {
        this.userData.addCommands(`
# Install AWS CLI v2
if ! command -v aws &> /dev/null; then
    echo "Installing AWS CLI v2..."
    # Detect architecture for multi-arch support
    CLI_ARCH=$(uname -m)
    curl "https://awscli.amazonaws.com/awscli-exe-linux-\${CLI_ARCH}.zip" -o "/tmp/awscliv2.zip"
    unzip -q /tmp/awscliv2.zip -d /tmp
    /tmp/aws/install
    rm -rf /tmp/aws /tmp/awscliv2.zip
    echo "AWS CLI installed: $(aws --version)"
else
    echo "AWS CLI already installed: $(aws --version)"
fi`);
        return this;
    }

    /**
     * Attach and mount an EBS volume.
     *
     * Handles:
     * - Attaching the volume to the instance
     * - Waiting for the device to appear (including NVMe mapping)
     * - Creating filesystem if needed
     * - Mounting and adding to fstab
     *
     * @param config - EBS volume configuration (volumeId supports CDK Tokens)
     * @remarks Generic - can be used by any project.
     * @returns this - for method chaining
     */
    attachEbsVolume(config: EbsVolumeConfig): this {
        const deviceName = config.deviceName ?? '/dev/xvdf';
        const fsType = config.fsType ?? 'xfs';
        const mountPoint = config.mountPoint;

        // Use SSM parameter if provided, otherwise use direct volume ID
        const volumeIdScript = config.ssmParameterPath
            ? `VOLUME_ID=$(aws ssm get-parameter --name "${config.ssmParameterPath}" --query "Parameter.Value" --output text --region $REGION)`
            : `VOLUME_ID="${config.volumeId}"`;

        this.userData.addCommands(`
# Attach and mount EBS volume
echo "=== Attaching EBS volume ==="

# Get instance metadata using IMDSv2 (required for HttpTokens: required)
# Always fetch a fresh token with max TTL (6h) to avoid expiration across methods
IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" \\
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")

INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \\
  http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \\
  http://169.254.169.254/latest/meta-data/placement/region)
AZ=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \\
  http://169.254.169.254/latest/meta-data/placement/availability-zone)

# Validate metadata was retrieved (fail fast if empty)
if [ -z "$INSTANCE_ID" ] || [ -z "$REGION" ]; then
    echo "ERROR: Failed to retrieve instance metadata via IMDSv2"
    echo "INSTANCE_ID='$INSTANCE_ID' REGION='$REGION'"
    exit 1
fi

${volumeIdScript}

echo "Instance: $INSTANCE_ID, Region: $REGION, AZ: $AZ"
echo "Volume ID: $VOLUME_ID"

# Wait for volume to become available (handles ASG rolling update race condition).
# During rolling updates the lifecycle hook Lambda detaches the volume from the
# old instance. This may take 10-30s. Poll until the volume is available.
# If it's still attached after 120s, force-detach it.
EBS_MAX_WAIT=300
EBS_FORCE_DETACH_AFTER=120
EBS_POLL_INTERVAL=10
EBS_WAITED=0
EBS_FORCE_DETACHED=false

while true; do
    VOLUME_STATE=$(aws ec2 describe-volumes --volume-ids $VOLUME_ID --query "Volumes[0].State" --output text --region $REGION 2>/dev/null || echo "not-found")
    echo "Volume state: $VOLUME_STATE (waited \${EBS_WAITED}s / \${EBS_MAX_WAIT}s)"

    if [ "$VOLUME_STATE" = "available" ]; then
        echo "Attaching volume $VOLUME_ID to $INSTANCE_ID as ${deviceName}..."
        aws ec2 attach-volume --volume-id $VOLUME_ID --instance-id $INSTANCE_ID --device ${deviceName} --region $REGION

        echo "Waiting for volume to attach..."
        aws ec2 wait volume-in-use --volume-ids $VOLUME_ID --region $REGION
        sleep 5
        echo "Volume attached successfully"
        break

    elif [ "$VOLUME_STATE" = "in-use" ]; then
        ATTACHED_INSTANCE=$(aws ec2 describe-volumes --volume-ids $VOLUME_ID --query "Volumes[0].Attachments[0].InstanceId" --output text --region $REGION)
        if [ "$ATTACHED_INSTANCE" = "$INSTANCE_ID" ]; then
            echo "Volume is already attached to this instance"
            break
        fi

        # Force-detach if the old instance hasn't released the volume after 120s
        if [ $EBS_WAITED -ge $EBS_FORCE_DETACH_AFTER ] && [ "$EBS_FORCE_DETACHED" = "false" ]; then
            echo "WARNING: Volume still attached to $ATTACHED_INSTANCE after \${EBS_FORCE_DETACH_AFTER}s. Force-detaching..."
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
        echo "ERROR: Volume did not become available after \${EBS_MAX_WAIT}s"
        exit 1
    fi

    sleep $EBS_POLL_INTERVAL
    EBS_WAITED=$((EBS_WAITED + EBS_POLL_INTERVAL))
done

# Wait for device to appear
DEVICE="${deviceName}"
NVME_DEVICE=""

for i in {1..30}; do
    if [ -b "$DEVICE" ]; then
        echo "Device $DEVICE is ready"
        break
    fi
    NVME_DEVICE=$(lsblk -o NAME,SERIAL -d | grep $(echo $VOLUME_ID | tr -d '-') | awk '{print "/dev/"$1}' | head -1)
    if [ -n "$NVME_DEVICE" ] && [ -b "$NVME_DEVICE" ]; then
        echo "Found NVMe device: $NVME_DEVICE"
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
    echo "No filesystem found, creating ${fsType} filesystem..."
    mkfs.${fsType} $DEVICE
fi

mkdir -p ${mountPoint}
echo "Mounting $DEVICE to ${mountPoint}..."
mount $DEVICE ${mountPoint}

if ! grep -q "${mountPoint}" /etc/fstab; then
    echo "$DEVICE ${mountPoint} ${fsType} defaults,nofail 0 2" >> /etc/fstab
    echo "Added mount to /etc/fstab"
fi

chown -R ec2-user:ec2-user ${mountPoint}
echo "EBS volume mounted at ${mountPoint}"`);
        return this;
    }

    /**
     * Send CloudFormation signal for ASG deployment validation.
     *
     * Signals SUCCESS to CloudFormation, indicating infrastructure is ready.
     * Should be called after critical setup (EBS attach) but before
     * non-critical steps (SSM app config).
     *
     * @param config - CFN signal configuration (supports CDK Tokens)
     * @remarks Generic - use when deploying with Auto Scaling Groups.
     * @returns this - for method chaining
     */
    sendCfnSignal(config: { stackName: string; asgLogicalId: string; region: string }): this {
        this.userData.addCommands(`
# =============================================================================
# CloudFormation Signal: Infrastructure Ready
# =============================================================================
# Signal SUCCESS now — instance booted, Docker installed, EBS attached.
# Application config (SSM) runs afterward as best-effort and can be
# re-executed independently: aws ssm send-command --document-name ...

echo "=== Sending CloudFormation SUCCESS signal (infrastructure ready) ==="

# Install cfn-bootstrap if needed (Amazon Linux 2023)
if ! command -v /opt/aws/bin/cfn-signal &> /dev/null; then
    echo "Installing aws-cfn-bootstrap..."
    dnf install -y aws-cfn-bootstrap 2>/dev/null || true
fi

/opt/aws/bin/cfn-signal --success true \\
    --stack "${config.stackName}" \\
    --resource "${config.asgLogicalId}" \\
    --region "${config.region}" && echo "Signal sent successfully" || echo "WARNING: cfn-signal failed"

echo "=== Infrastructure setup complete, proceeding to app config... ==="`);
        return this;
    }

    /**
     * Trigger an SSM Run Command document from within user-data.
     *
     * This is the "slim user-data" pattern: user-data handles OS bootstrap
     * (Docker, CLI, EBS) then delegates application configuration to an SSM
     * document that can be re-executed independently without EC2 replacement.
     *
     * When `fireAndForget: true`, the command is sent without polling for
     * completion. Non-fatal: failures are logged but don't exit the script.
     *
     * @param config - SSM document configuration (supports CDK Tokens)
     * @remarks Generic - can be used by any project.
     * @returns this - for method chaining
     */
    triggerSsmConfiguration(config: SsmTriggerConfig): this {
        const region = config.region ?? 'eu-west-1';
        const timeoutSeconds = config.timeoutSeconds ?? 600;

        if (config.fireAndForget) {
            this._addFireAndForgetSsmTrigger(config.documentName, region);
        } else {
            this._addBlockingSsmTrigger(config.documentName, region, timeoutSeconds, config.parameters);
        }

        return this;
    }

    /**
     * Add a custom script section.
     *
     * Use this method to add project-specific setup scripts that are not
     * covered by the built-in methods.
     *
     * @param script - Shell script to add (do not include shebang)
     * @remarks Generic - can be used by any project.
     * @returns this - for method chaining
     */
    addCustomScript(script: string): this {
        this.userData.addCommands(script);
        return this;
    }

    /**
     * Add a completion marker to the end of user-data.
     *
     * @returns this - for method chaining
     */
    addCompletionMarker(): this {
        this.userData.addCommands(`
echo ""
echo "=============================================="
echo "=== User data completed at $(date) ==="
echo "=============================================="`);
        return this;
    }

    // =========================================================================
    // KUBERNETES (kubeadm) METHODS
    // =========================================================================

    /**
     * Initialize a kubeadm Kubernetes control plane.
     *
     * Runs `kubeadm init` to bootstrap the control plane with:
     * - Configurable Kubernetes version
     * - Pod network CIDR (for Calico)
     * - Service subnet CIDR
     * - TLS SAN (Elastic IP for external kubectl access)
     *
     * Also publishes the join token and CA certificate hash to SSM
     * so worker nodes can join the cluster.
     *
     * @param config - kubeadm init configuration
     * @remarks **k8s project** - For other projects, use `addCustomScript()`.
     * @returns this - for method chaining
     */
    initKubeadmCluster(config: KubeadmInitConfig = {}): this {
        const kubernetesVersion = config.kubernetesVersion ?? '1.35.1';
        const dataDir = config.dataDir ?? '/data/kubernetes';
        const podNetworkCidr = config.podNetworkCidr ?? '192.168.0.0/16';
        const serviceSubnet = config.serviceSubnet ?? '10.96.0.0/12';
        const ssmPrefix = config.ssmPrefix ?? '/k8s/development';

        this.userData.addCommands(`
# =============================================================================
# Initialize kubeadm Kubernetes Control Plane
# =============================================================================

echo "=== Initializing kubeadm cluster (v${kubernetesVersion}) ==="

# Ensure data directory exists on persistent volume
mkdir -p ${dataDir}

# Get instance metadata via IMDSv2 (always fetch fresh token to avoid TTL expiration)
IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || echo "")
PRIVATE_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)

# Start containerd (required before kubeadm init)
systemctl start containerd
echo "containerd started"

# Build apiserver cert SANs
CERT_SANS="--apiserver-cert-extra-sans=$PRIVATE_IP"
if [ -n "$PUBLIC_IP" ]; then
    CERT_SANS="$CERT_SANS,$PUBLIC_IP"
fi

# Run kubeadm init
echo "Running kubeadm init..."
kubeadm init \\
    --kubernetes-version="${kubernetesVersion}" \\
    --pod-network-cidr="${podNetworkCidr}" \\
    --service-cidr="${serviceSubnet}" \\
    --control-plane-endpoint="$PRIVATE_IP:6443" \\
    $CERT_SANS \\
    --upload-certs \\
    2>&1 | tee /tmp/kubeadm-init.log

if [ \${PIPESTATUS[0]} -ne 0 ]; then
    echo "ERROR: kubeadm init failed"
    cat /tmp/kubeadm-init.log
    exit 1
fi

# Set up kubeconfig for root (immediate use)
export KUBECONFIG=/etc/kubernetes/admin.conf
mkdir -p /root/.kube
cp -f /etc/kubernetes/admin.conf /root/.kube/config
chmod 600 /root/.kube/config

# Wait for control plane components to be ready
echo "Waiting for control plane to be ready..."
for i in {1..90}; do
    if kubectl get nodes &>/dev/null; then
        echo "Control plane is ready (waited \${i} seconds)"
        break
    fi
    if [ $i -eq 90 ]; then
        echo "WARNING: Control plane did not become ready in 90s"
    fi
    sleep 1
done

# Remove control plane taint so pods can schedule on this node
# (needed during bootstrap before worker nodes join)
kubectl taint nodes --all node-role.kubernetes.io/control-plane- 2>/dev/null || true

# Generate and publish join token + CA hash to SSM for worker nodes
SSM_PREFIX="${ssmPrefix}"
JOIN_TOKEN=$(kubeadm token create --ttl 24h)
CA_HASH=$(openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt | \\
    openssl rsa -pubin -outform der 2>/dev/null | \\
    openssl dgst -sha256 -hex | awk '{print $2}')

aws ssm put-parameter \\
    --name "$SSM_PREFIX/join-token" \\
    --value "$JOIN_TOKEN" \\
    --type "SecureString" \\
    --overwrite \\
    --region "$REGION" || echo "WARNING: Failed to store join-token in SSM"

aws ssm put-parameter \\
    --name "$SSM_PREFIX/ca-hash" \\
    --value "sha256:$CA_HASH" \\
    --type "String" \\
    --overwrite \\
    --region "$REGION" || echo "WARNING: Failed to store ca-hash in SSM"

aws ssm put-parameter \\
    --name "$SSM_PREFIX/control-plane-endpoint" \\
    --value "$PRIVATE_IP:6443" \\
    --type "String" \\
    --overwrite \\
    --region "$REGION" || echo "WARNING: Failed to store control-plane-endpoint in SSM"

# Store instance info in SSM for CI/CD access
aws ssm put-parameter \\
    --name "$SSM_PREFIX/instance-id" \\
    --value "$INSTANCE_ID" \\
    --type "String" \\
    --overwrite \\
    --region "$REGION" || echo "WARNING: Failed to store instance-id in SSM"

if [ -n "$PUBLIC_IP" ]; then
    aws ssm put-parameter \\
        --name "$SSM_PREFIX/elastic-ip" \\
        --value "$PUBLIC_IP" \\
        --type "String" \\
        --overwrite \\
        --region "$REGION" || echo "WARNING: Failed to store elastic-ip in SSM"
fi

echo "kubeadm cluster initialized successfully"
echo "Kubernetes version: $(kubectl version --short 2>/dev/null || kubectl version)"
echo "Node status:"
kubectl get nodes -o wide`);
        return this;
    }

    /**
     * Join a worker node to an existing kubeadm cluster.
     *
     * Retrieves the join token and CA certificate hash from SSM
     * (published by the control plane node), then runs `kubeadm join`.
     * Applies node labels and taints for workload isolation.
     *
     * @param config - kubeadm join configuration
     * @remarks **k8s project** - Requires a running kubeadm control plane.
     * @returns this - for method chaining
     */
    joinKubeadmCluster(config: KubeadmJoinConfig): this {
        const region = config.region ?? 'eu-west-1';

        this.userData.addCommands(`
# =============================================================================
# Join kubeadm Cluster (Worker Node)
# =============================================================================

echo "=== Joining kubeadm cluster as worker node ==="

# Get instance metadata via IMDSv2 (always fetch fresh token to avoid TTL expiration)
IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
PRIVATE_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)

echo "Instance: $INSTANCE_ID, Private IP: $PRIVATE_IP"

# Start containerd
systemctl start containerd
echo "containerd started"

# Retrieve join token from SSM (published by control plane at boot)
echo "Retrieving join token from SSM: ${config.tokenSsmPath}"
JOIN_TOKEN=$(aws ssm get-parameter \\
    --name "${config.tokenSsmPath}" \\
    --with-decryption \\
    --query "Parameter.Value" \\
    --output text \\
    --region "${region}" 2>/dev/null || echo "")

if [ -z "$JOIN_TOKEN" ]; then
    echo "ERROR: Failed to retrieve join token from SSM"
    echo "Ensure the control plane has started and published its token to ${config.tokenSsmPath}"
    exit 1
fi
echo "Join token retrieved successfully"

# Retrieve CA certificate hash from SSM
echo "Retrieving CA hash from SSM: ${config.caHashSsmPath}"
CA_HASH=$(aws ssm get-parameter \\
    --name "${config.caHashSsmPath}" \\
    --query "Parameter.Value" \\
    --output text \\
    --region "${region}" 2>/dev/null || echo "")

if [ -z "$CA_HASH" ]; then
    echo "ERROR: Failed to retrieve CA hash from SSM"
    exit 1
fi
echo "CA hash retrieved successfully"

# Join the cluster
echo "Running kubeadm join..."
kubeadm join "${config.controlPlaneEndpoint}" \\
    --token "$JOIN_TOKEN" \\
    --discovery-token-ca-cert-hash "$CA_HASH" \\
    2>&1 | tee /tmp/kubeadm-join.log

if [ \${PIPESTATUS[0]} -ne 0 ]; then
    echo "ERROR: kubeadm join failed"
    cat /tmp/kubeadm-join.log
    exit 1
fi

# Wait for kubelet to be active
echo "Waiting for kubelet to become active..."
for i in {1..60}; do
    if systemctl is-active --quiet kubelet; then
        echo "kubelet is active (waited \${i} seconds)"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "WARNING: kubelet did not become active in 60s"
        journalctl -u kubelet --no-pager -n 20
    fi
    sleep 1
done

echo "Worker node joined cluster successfully"
echo "kubelet version: $(kubelet --version)"
echo "Service status: $(systemctl is-active kubelet)"`);
        return this;
    }

    /**
     * Install Calico CNI for pod networking and NetworkPolicy enforcement.
     *
     * Must be called AFTER `initKubeadmCluster()`.
     * Applies the Calico operator and custom resource, then waits for
     * the CNI to become healthy before proceeding.
     *
     * @param podNetworkCidr - Pod network CIDR to use @default '192.168.0.0/16'
     * @remarks **k8s project** - Requires kubeadm cluster initialized.
     * @returns this - for method chaining
     */
    installCalicoCNI(podNetworkCidr = '192.168.0.0/16'): this {
        this.userData.addCommands(`
# =============================================================================
# Install Calico CNI (NetworkPolicy enforcement)
# =============================================================================

echo "=== Installing Calico CNI ==="

export KUBECONFIG=/etc/kubernetes/admin.conf

# Install Calico operator (prefer pre-cached from Golden AMI, fallback to GitHub)
CALICO_VERSION="v3.29.3"
OPERATOR_YAML="/opt/calico/tigera-operator.yaml"
echo "Applying Calico operator..."
if [ -f "$OPERATOR_YAML" ]; then
    echo "  Using pre-cached operator from Golden AMI"
    kubectl create -f "$OPERATOR_YAML" 2>/dev/null || \\
    kubectl apply -f "$OPERATOR_YAML"
else
    echo "  WARNING: Pre-cached operator not found, downloading from GitHub"
    kubectl create -f "https://raw.githubusercontent.com/projectcalico/calico/$CALICO_VERSION/manifests/tigera-operator.yaml" 2>/dev/null || \\
    kubectl apply -f "https://raw.githubusercontent.com/projectcalico/calico/$CALICO_VERSION/manifests/tigera-operator.yaml"
fi

# Wait for operator to be available
echo "Waiting for Calico operator..."
kubectl wait --for=condition=Available deployment/tigera-operator \\
    -n tigera-operator --timeout=120s || echo "WARNING: Operator not ready in 120s"

# Apply Calico custom resource with the configured pod CIDR
cat <<CALICO_EOF | kubectl apply -f -
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    ipPools:
      - cidr: ${podNetworkCidr}
        encapsulation: VXLANCrossSubnet
        natOutgoing: Enabled
        nodeSelector: all()
    linuxDataplane: Iptables
CALICO_EOF

# Wait for Calico pods to be ready
echo "Waiting for Calico pods to become ready..."
for i in {1..120}; do
    READY=$(kubectl get pods -n calico-system --no-headers 2>/dev/null | grep -c "Running" || echo "0")
    TOTAL=$(kubectl get pods -n calico-system --no-headers 2>/dev/null | wc -l | tr -d ' ')
    if [ "$TOTAL" -gt 0 ] && [ "$READY" -eq "$TOTAL" ]; then
        echo "Calico pods ready (\${READY}/\${TOTAL}, waited \${i} seconds)"
        break
    fi
    if [ $i -eq 120 ]; then
        echo "WARNING: Calico pods not fully ready after 120s (\${READY}/\${TOTAL})"
        kubectl get pods -n calico-system
    fi
    sleep 1
done

echo "Calico CNI installed successfully"
kubectl get pods -n calico-system
kubectl get nodes -o wide`);
        return this;
    }

    /**
     * Configure kubectl access for ec2-user and root.
     *
     * Sets up KUBECONFIG environment variable and copies the kubeconfig
     * to standard locations for both root and ec2-user.
     *
     * @remarks **k8s project** - Requires kubeadm cluster initialized.
     * @returns this - for method chaining
     */
    configureKubeconfig(): this {
        this.userData.addCommands(`
# =============================================================================
# Configure kubectl Access
# =============================================================================

echo "=== Configuring kubectl access ==="

KUBECONFIG_SRC="/etc/kubernetes/admin.conf"

# Set up for root
mkdir -p /root/.kube
cp -f $KUBECONFIG_SRC /root/.kube/config
chmod 600 /root/.kube/config

# Set up for ec2-user
mkdir -p /home/ec2-user/.kube
cp -f $KUBECONFIG_SRC /home/ec2-user/.kube/config
chown ec2-user:ec2-user /home/ec2-user/.kube/config
chmod 600 /home/ec2-user/.kube/config

# Add KUBECONFIG to shell profiles for both users
echo "export KUBECONFIG=$KUBECONFIG_SRC" > /etc/profile.d/kubernetes.sh
chmod 644 /etc/profile.d/kubernetes.sh

# Verify kubectl works
export KUBECONFIG=$KUBECONFIG_SRC
echo "kubectl configured. Cluster info:"
kubectl cluster-info
kubectl get namespaces`);
        return this;
    }

    /**
     * Download k8s manifests from S3 and deploy to the cluster.
     *
     * Downloads the k8s bundle from S3 (synced via CDK BucketDeployment)
     * and delegates to `deploy-manifests.sh` for secret resolution,
     * manifest application, and SSM endpoint registration.
     *
     * This keeps UserData slim — all k8s logic lives in the deploy
     * script which can also be triggered via SSM Run Command from CI/CD.
     *
     * @param config - S3 bucket and manifest configuration
     * @remarks **k8s project** - Requires kubectl to be configured.
     * @returns this - for method chaining
     */
    deployK8sManifests(config: K8sManifestsS3Config): this {
        const s3KeyPrefix = config.s3KeyPrefix ?? 'k8s';
        const manifestsDir = config.manifestsDir ?? '/data/k8s';
        const region = config.region ?? 'eu-west-1';
        const ssmPrefix = config.ssmPrefix ?? '/k8s/development';

        this.userData.addCommands(`
# =============================================================================
# Deploy k8s Monitoring Manifests (first boot)
# Downloads bundle from S3, then delegates to deploy-manifests.sh
# Subsequent deployments are triggered via SSM Run Command from CI/CD
# =============================================================================

echo "=== Downloading k8s manifests from S3 ==="
K8S_DIR="${manifestsDir}"
mkdir -p $K8S_DIR

aws s3 sync s3://${config.s3BucketName}/${s3KeyPrefix}/ $K8S_DIR/ --region ${region}
echo "k8s bundle downloaded to $K8S_DIR"

# Restore execute permissions lost during S3 sync
find $K8S_DIR -name '*.sh' -exec chmod +x {} +

# Run the deploy script (handles secrets, kubectl apply, SSM endpoints)
export KUBECONFIG=/etc/kubernetes/admin.conf
export SSM_PREFIX="${ssmPrefix}"
export AWS_REGION="${region}"
export MANIFESTS_DIR="$K8S_DIR/manifests"

echo "Running deploy-manifests.sh..."
$K8S_DIR/apps/monitoring/deploy-manifests.sh

echo "=== k8s first-boot deployment complete ==="`);
        return this;
    }


    // =========================================================================
    // MONITORING-SPECIFIC METHODS
    // =========================================================================

    /**
     * Download monitoring stack from S3 and start it.
     *
     * The monitoring stack (docker-compose.yml + all configs) is maintained
     * as static files in `scripts/monitoring/` and synced to S3 via CDK
     * BucketDeployment. This method downloads the bundle and starts the stack.
     *
     * @param config - S3 bucket and monitoring configuration
     * @remarks **Monitoring project only** - For other projects, use `addCustomScript()`.
     * @returns this - for method chaining
     */
    downloadAndStartMonitoringStack(config: MonitoringStackS3Config): this {
        const s3KeyPrefix = config.s3KeyPrefix ?? 'scripts';
        const monitoringDir = config.monitoringDir ?? '/opt/monitoring';
        const region = config.region ?? 'eu-west-1';

        this.userData.addCommands(`
# =============================================================================
# Download and Start Monitoring Stack
# =============================================================================

echo "=== Downloading monitoring stack from S3 ==="
MONITORING_DIR="${monitoringDir}"
mkdir -p \${MONITORING_DIR}

# Sync the complete monitoring bundle from S3
aws s3 sync s3://${config.s3BucketName}/${s3KeyPrefix}/ \${MONITORING_DIR}/ --region ${region}
echo "Monitoring stack downloaded to \${MONITORING_DIR}"

# Restore execute permissions lost during S3 sync
find \${MONITORING_DIR} -name '*.sh' -exec chmod +x {} +
echo "Restored execute permissions on shell scripts"

# Start the monitoring stack
cd \${MONITORING_DIR}
docker compose up -d

echo "=== Monitoring stack started ==="

# Create systemd service for auto-start on reboot
cat > /etc/systemd/system/monitoring-stack.service << 'SYSTEMD_SERVICE'
[Unit]
Description=Monitoring Stack (Prometheus + Grafana + Loki)
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${monitoringDir}
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
SYSTEMD_SERVICE

systemctl daemon-reload
systemctl enable monitoring-stack.service

# Get instance ID and private IP using IMDSv2 (always fetch fresh token to avoid TTL expiration)
IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
PRIVATE_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
SSM_PREFIX="${config.ssmPrefix}"

# Store Loki and Tempo endpoints in SSM for cross-stack discovery
# SSM path uses the monitoring prefix convention: /monitoring-{environment}
LOKI_ENDPOINT="http://$PRIVATE_IP:3100/loki/api/v1/push"
TEMPO_ENDPOINT="http://$PRIVATE_IP:4317"
echo "=== Storing monitoring endpoints in SSM ==="
echo "Loki endpoint: $LOKI_ENDPOINT"
echo "Tempo endpoint: $TEMPO_ENDPOINT"
aws ssm put-parameter \\
  --name "$SSM_PREFIX/loki/endpoint" \\
  --value "$LOKI_ENDPOINT" \\
  --type "String" \\
  --overwrite \\
  --region "$REGION" || echo "WARNING: Failed to store Loki endpoint in SSM"
aws ssm put-parameter \\
  --name "$SSM_PREFIX/tempo/endpoint" \\
  --value "$TEMPO_ENDPOINT" \\
  --type "String" \\
  --overwrite \\
  --region "$REGION" || echo "WARNING: Failed to store Tempo endpoint in SSM"

echo "=== Monitoring stack setup complete ==="
echo "Access via SSM port forwarding (SSM-only security model):"
echo '  Grafana:    aws ssm start-session --target '$INSTANCE_ID' --document-name AWS-StartPortForwardingSession --parameters '"'"'{"portNumber":["3000"],"localPortNumber":["3000"]}'"'"''
echo '  Prometheus: aws ssm start-session --target '$INSTANCE_ID' --document-name AWS-StartPortForwardingSession --parameters '"'"'{"portNumber":["9090"],"localPortNumber":["9090"]}'"'"''
echo '  Loki:       aws ssm start-session --target '$INSTANCE_ID' --document-name AWS-StartPortForwardingSession --parameters '"'"'{"portNumber":["3100"],"localPortNumber":["3100"]}'"'"''`);

        return this;
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Fire-and-forget SSM trigger: sends the command without polling.
     * Non-fatal — failures are logged but don't exit the script.
     */
    private _addFireAndForgetSsmTrigger(documentName: string, region: string): void {
        this.userData.addCommands(`
# =============================================================================
# Trigger SSM Run Command (BEST-EFFORT — cfn-signal already sent)
# Fire-and-forget: send the command and let SSM handle execution.
# Results are visible in the SSM console. Re-run manually if needed.
# =============================================================================

# Disable exit-on-error for the SSM section — failures are non-fatal
set +e

echo "=== Triggering SSM document: ${documentName} (best-effort) ==="

# Get instance ID from IMDSv2 (always fetch fresh token to avoid TTL expiration)
IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)

# Wait for SSM Agent to register this instance (may take 15-30s after boot)
SSM_MAX_WAIT=120
SSM_WAITED=0
echo "Waiting for SSM Agent to register instance $INSTANCE_ID..."
while true; do
    SSM_STATUS=$(aws ssm describe-instance-information \\
        --filters "Key=InstanceIds,Values=$INSTANCE_ID" \\
        --query "InstanceInformationList[0].PingStatus" \\
        --output text --region ${region} 2>/dev/null || echo "NotFound")

    if [ "$SSM_STATUS" = "Online" ]; then
        echo "SSM Agent is online (waited \${SSM_WAITED}s)"
        break
    fi

    if [ $SSM_WAITED -ge $SSM_MAX_WAIT ]; then
        echo "WARNING: SSM Agent did not come online after \${SSM_MAX_WAIT}s — skipping app config"
        echo "Re-run manually: aws ssm send-command --document-name ${documentName} --targets Key=instanceids,Values=$INSTANCE_ID --region ${region}"
        break
    fi

    sleep 5
    SSM_WAITED=$((SSM_WAITED + 5))
done

# Fire-and-forget: send the SSM command without polling for completion
if [ "$SSM_STATUS" = "Online" ]; then
    COMMAND_ID=$(aws ssm send-command \\
        --document-name "${documentName}" \\
        --targets "Key=instanceids,Values=$INSTANCE_ID" \\
        --timeout-seconds 600 \\
        --query "Command.CommandId" \\
        --output text \\
        --region ${region} 2>/dev/null || echo "")

    if [ -n "$COMMAND_ID" ]; then
        echo "SSM Command sent: $COMMAND_ID (fire-and-forget)"
        echo "Check status: aws ssm get-command-invocation --command-id $COMMAND_ID --instance-id $INSTANCE_ID --region ${region}"
    else
        echo "WARNING: Failed to send SSM command"
        echo "Re-run manually: aws ssm send-command --document-name ${documentName} --targets Key=instanceids,Values=$INSTANCE_ID --region ${region}"
    fi
fi

# Re-enable exit-on-error
set -e`);
    }

    /**
     * Blocking SSM trigger: sends the command and polls until completion.
     * Exits with error on failure.
     */
    private _addBlockingSsmTrigger(
        documentName: string,
        region: string,
        timeoutSeconds: number,
        parameters?: Record<string, string>,
    ): void {
        const paramEntries = parameters
            ? Object.entries(parameters)
                .map(([key, val]) => `"${key}":["${val}"]`)
                .join(',')
            : '';
        const paramFlag = paramEntries
            ? `--parameters '{${paramEntries}}'`
            : '';

        this.userData.addCommands(`
# =============================================================================
# Trigger SSM Run Command: ${documentName}
# Delegates application configuration to an SSM document that can be
# re-executed independently without EC2 replacement.
# =============================================================================

echo "=== Triggering SSM document: ${documentName} ==="

# Get instance ID from IMDSv2 (always fetch fresh token to avoid TTL expiration)
IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)

# Wait for SSM Agent to register this instance (may take 15-30s after boot)
SSM_MAX_WAIT=120
SSM_WAITED=0
echo "Waiting for SSM Agent to register instance $INSTANCE_ID..."
while true; do
    SSM_STATUS=$(aws ssm describe-instance-information \\
        --filters "Key=InstanceIds,Values=$INSTANCE_ID" \\
        --query "InstanceInformationList[0].PingStatus" \\
        --output text --region ${region} 2>/dev/null || echo "NotFound")

    if [ "$SSM_STATUS" = "Online" ]; then
        echo "SSM Agent is online (waited \${SSM_WAITED}s)"
        break
    fi

    if [ $SSM_WAITED -ge $SSM_MAX_WAIT ]; then
        echo "ERROR: SSM Agent did not come online after \${SSM_MAX_WAIT}s"
        exit 1
    fi

    sleep 5
    SSM_WAITED=$((SSM_WAITED + 5))
done

# Send the SSM Run Command
COMMAND_ID=$(aws ssm send-command \\
    --document-name "${documentName}" \\
    --targets "Key=instanceids,Values=$INSTANCE_ID" \\
    ${paramFlag} \\
    --timeout-seconds ${timeoutSeconds} \\
    --query "Command.CommandId" \\
    --output text \\
    --region ${region})

echo "SSM Command sent: $COMMAND_ID"

# Wait for completion
SSM_CMD_WAITED=0
while true; do
    CMD_STATUS=$(aws ssm get-command-invocation \\
        --command-id "$COMMAND_ID" \\
        --instance-id "$INSTANCE_ID" \\
        --query "Status" \\
        --output text \\
        --region ${region} 2>/dev/null || echo "InProgress")

    if [ "$CMD_STATUS" = "Success" ]; then
        echo "=== SSM document completed successfully ==="
        break
    elif [ "$CMD_STATUS" = "Failed" ] || [ "$CMD_STATUS" = "Cancelled" ] || [ "$CMD_STATUS" = "TimedOut" ]; then
        echo "ERROR: SSM command $CMD_STATUS"
        aws ssm get-command-invocation \\
            --command-id "$COMMAND_ID" \\
            --instance-id "$INSTANCE_ID" \\
            --region ${region} 2>/dev/null || true
        exit 1
    fi

    if [ $SSM_CMD_WAITED -ge ${timeoutSeconds} ]; then
        echo "ERROR: SSM command timed out after \${SSM_CMD_WAITED}s"
        exit 1
    fi

    sleep 10
    SSM_CMD_WAITED=$((SSM_CMD_WAITED + 10))
done`);
    }

    // =====================================================================
    // STATIC FACTORY METHODS
    // =====================================================================

    /**
     * Build a "light" user data script for the hybrid bootstrap strategy.
     *
     * Layer 2 of the 4-layer architecture:
     * - Layer 1: Golden AMI (pre-baked Docker, AWS CLI, kubeadm toolchain, Calico)
     * - **Layer 2: Light User Data (THIS)** — EBS attach, EIP, kubeadm start, cfn-signal
     * - Layer 3: SSM State Manager (post-boot config, CNI, manifests)
     * - Layer 4: SSM Documents (on-demand runbooks)
     *
     * This method creates a minimal script that:
     * 1. Attaches and mounts the EBS data volume
     * 2. Associates the Elastic IP for stable CloudFront origin
     * 3. Starts kubeadm (toolchain pre-installed in Golden AMI)
     * 4. Sends cfn-signal to the ASG
     *
     * Total boot time target: ~2 minutes (vs ~10-15 min with full user-data)
     *
     * @param config - Configuration for the light user data
     * @returns Configured ec2.UserData object
     */
    static buildLightUserData(config: {
        /** EBS volume attachment config */
        ebsVolume: EbsVolumeConfig;
        /** Elastic IP allocation ID */
        eipAllocationId: string;
        /** CloudFormation stack name (CDK Token) */
        stackName: string;
        /** ASG logical ID for cfn-signal (CDK Token) */
        asgLogicalId: string;
        /** kubeadm configuration */
        k3s: {
            /** Kubernetes version */
            channel: string;
            /** Kubernetes data directory */
            dataDir: string;
            /** Whether to disable Flannel (for Calico) */
            disableFlannel: boolean;
        };
        /** AWS region */
        region: string;
    }): ec2.UserData {
        const userData = ec2.UserData.forLinux();
        const builder = new UserDataBuilder(userData);

        // Step 1: Attach EBS volume (critical for Kubernetes data persistence)
        builder.attachEbsVolume(config.ebsVolume);

        // Step 2: Associate Elastic IP for stable CloudFront origin
        builder.addCustomScript(`
# ============================================================
# LIGHT USER DATA — Layer 2 (Hybrid Bootstrap)
# Golden AMI provides: Docker, AWS CLI, kubeadm toolchain, Calico manifests
# This script only does: EBS + EIP + kubeadm start + cfn-signal
# ============================================================

# --- Associate Elastic IP ---
echo "=== Associating Elastic IP ==="
INSTANCE_ID=$(ec2-metadata -i | cut -d' ' -f2)
aws ec2 associate-address \\
    --instance-id "$INSTANCE_ID" \\
    --allocation-id "${config.eipAllocationId}" \\
    --allow-reassociation \\
    --region ${config.region}
echo "✓ Elastic IP associated"
`);

        // Step 3: Start kubeadm (toolchain pre-installed in Golden AMI)
        const flannelFlags = config.k3s.disableFlannel
            ? '--flannel-backend=none --disable-network-policy'
            : '';

        builder.addCustomScript(`
# --- Start k3s (binary pre-installed in Golden AMI) ---
echo "=== Starting k3s ==="
if ! systemctl is-active --quiet k3s; then
    # k3s binary is installed but service may not be configured yet
    INSTALL_K3S_SKIP_DOWNLOAD=true \\
    INSTALL_K3S_CHANNEL=${config.k3s.channel} \\
    K3S_DATA_DIR=${config.k3s.dataDir} \\
    /usr/local/bin/k3s-install.sh server \\
        --data-dir ${config.k3s.dataDir} \\
        ${flannelFlags} \\
        --write-kubeconfig-mode 644

    # Wait for k3s to be ready (max 120s)
    echo "Waiting for k3s API server..."
    WAIT_COUNT=0
    until kubectl get nodes &>/dev/null; do
        sleep 5
        WAIT_COUNT=$((WAIT_COUNT + 1))
        if [ $WAIT_COUNT -ge 24 ]; then
            echo "ERROR: k3s not ready after 120s"
            break
        fi
    done
    echo "✓ k3s started"
else
    echo "✓ k3s already running"
fi
`);

        // Step 4: Send cfn-signal (success or failure)
        builder.sendCfnSignal({
            stackName: config.stackName,
            asgLogicalId: config.asgLogicalId,
            region: config.region,
        });

        builder.addCompletionMarker();

        return userData;
    }
}
