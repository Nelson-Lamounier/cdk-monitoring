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
 * ## Kubernetes (k3s) Methods
 * - `installK3s()` - Install k3s lightweight Kubernetes
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
 * Configuration for k3s installation.
 * Used by `installK3s()` method.
 */
export interface K3sInstallConfig {
    /** k3s release channel (e.g., 'v1.31') @default 'v1.31' */
    channel?: string;
    /** k3s data directory (should be on persistent volume) @default '/data/k3s' */
    dataDir?: string;
    /** Whether to disable the built-in Traefik ingress @default false */
    disableTraefik?: boolean;
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

# Install Docker Compose v2 plugin (preferred: 'docker compose' syntax)
DOCKER_COMPOSE_VERSION="${composeVersion}"
mkdir -p /usr/local/lib/docker/cli-plugins
curl -SL "https://github.com/docker/compose/releases/download/\${DOCKER_COMPOSE_VERSION}/docker-compose-linux-x86_64" \\
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
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "/tmp/awscliv2.zip"
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
IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" \\
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")

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
EBS_MAX_WAIT=120
EBS_POLL_INTERVAL=10
EBS_WAITED=0

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
        echo "Volume attached to $ATTACHED_INSTANCE (terminating). Waiting for detach..."

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
    // KUBERNETES (k3s) METHODS
    // =========================================================================

    /**
     * Install k3s lightweight Kubernetes.
     *
     * Installs k3s via the official install script with configurable:
     * - Release channel (pinned version)
     * - Data directory (persistent volume)
     * - TLS SAN (Elastic IP for external access)
     * - Traefik ingress (built-in, can be disabled)
     *
     * Also stores the instance ID in SSM for CI/CD pipeline access.
     *
     * @param config - k3s installation configuration
     * @remarks **k8s project** - For other projects, use `addCustomScript()`.
     * @returns this - for method chaining
     */
    installK3s(config: K3sInstallConfig = {}): this {
        const channel = config.channel ?? 'v1.31';
        const dataDir = config.dataDir ?? '/data/k3s';
        const disableTraefik = config.disableTraefik ?? false;
        const ssmPrefix = config.ssmPrefix ?? '/k8s/development';

        const traefikFlag = disableTraefik ? '--disable traefik' : '';

        this.userData.addCommands(`
# =============================================================================
# Install k3s Kubernetes
# =============================================================================

echo "=== Installing k3s (channel: ${channel}) ==="

# Ensure data directory exists on persistent volume
mkdir -p ${dataDir}

# Get public IP for TLS SAN (so kubectl works from outside)
if [ -z "\${IMDS_TOKEN:-}" ]; then
    IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
fi
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || echo "")
PRIVATE_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)

# Build TLS SAN from public and private IPs
TLS_SAN="--tls-san $PRIVATE_IP"
if [ -n "$PUBLIC_IP" ]; then
    TLS_SAN="$TLS_SAN --tls-san $PUBLIC_IP"
fi

# Install k3s server
export INSTALL_K3S_CHANNEL="${channel}"
curl -sfL https://get.k3s.io | sh -s - server \\
    --data-dir ${dataDir} \\
    --write-kubeconfig-mode 644 \\
    $TLS_SAN \\
    ${traefikFlag}

# Wait for k3s to be ready
echo "Waiting for k3s to be ready..."
for i in {1..60}; do
    if ${dataDir}/server/bin/kubectl --kubeconfig ${dataDir}/server/cred/admin.kubeconfig get nodes &>/dev/null; then
        echo "k3s is ready (waited \${i} seconds)"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "WARNING: k3s did not become ready in 60s"
    fi
    sleep 1
done

# Store instance info in SSM for CI/CD access
SSM_PREFIX="${ssmPrefix}"
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

echo "k3s installed successfully"
echo "k3s version: $(k3s --version)"
echo "Node status:"
k3s kubectl get nodes -o wide`);
        return this;
    }

    /**
     * Configure kubectl access for ec2-user and root.
     *
     * Sets up KUBECONFIG environment variable and copies the kubeconfig
     * to standard locations for both root and ec2-user.
     *
     * @param config - Optional k3s data directory @default '/data/k3s'
     * @remarks **k8s project** - Requires k3s to be installed first.
     * @returns this - for method chaining
     */
    configureKubeconfig(dataDir = '/data/k3s'): this {
        this.userData.addCommands(`
# =============================================================================
# Configure kubectl Access
# =============================================================================

echo "=== Configuring kubectl access ==="

K3S_KUBECONFIG="${dataDir}/server/cred/admin.kubeconfig"

# Set up for root
mkdir -p /root/.kube
cp $K3S_KUBECONFIG /root/.kube/config
chmod 600 /root/.kube/config

# Set up for ec2-user
mkdir -p /home/ec2-user/.kube
cp $K3S_KUBECONFIG /home/ec2-user/.kube/config
chown ec2-user:ec2-user /home/ec2-user/.kube/config
chmod 600 /home/ec2-user/.kube/config

# Add KUBECONFIG to shell profiles for both users
echo "export KUBECONFIG=$K3S_KUBECONFIG" > /etc/profile.d/k3s.sh
chmod 644 /etc/profile.d/k3s.sh

# Add kubectl alias
echo "alias kubectl='k3s kubectl'" >> /etc/profile.d/k3s.sh

# Verify kubectl works
export KUBECONFIG=$K3S_KUBECONFIG
echo "kubectl configured. Cluster info:"
k3s kubectl cluster-info
k3s kubectl get namespaces`);
        return this;
    }

    /**
     * Download k8s manifests from S3 and deploy to k3s.
     *
     * Downloads the k8s bundle from S3 (synced via CDK BucketDeployment)
     * and delegates to `deploy-manifests.sh` for secret resolution,
     * manifest application, and SSM endpoint registration.
     *
     * This keeps UserData slim — all k8s logic lives in the deploy
     * script which can also be triggered via SSM Run Command from CI/CD.
     *
     * @param config - S3 bucket and manifest configuration
     * @remarks **k8s project** - Requires k3s and kubectl to be configured.
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
export KUBECONFIG=/data/k3s/server/cred/admin.kubeconfig
export SSM_PREFIX="${ssmPrefix}"
export AWS_REGION="${region}"
export MANIFESTS_DIR="$K8S_DIR/manifests"

echo "Running deploy-manifests.sh..."
$K8S_DIR/deploy-manifests.sh

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

# Get instance ID and private IP using IMDSv2
if [ -z "\${IMDS_TOKEN:-}" ]; then
    IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
fi
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

# Get instance ID from IMDS v2
if [ -z "\${IMDS_TOKEN:-}" ]; then
    IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
fi
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

# Get instance ID from IMDS v2
if [ -z "\${IMDS_TOKEN:-}" ]; then
    IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
fi
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
}
