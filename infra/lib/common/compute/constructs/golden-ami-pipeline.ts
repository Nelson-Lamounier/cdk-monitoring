/**
 * @format
 * Golden AMI Pipeline Construct
 *
 * Creates an EC2 Image Builder pipeline that pre-bakes Docker, AWS CLI,
 * kubeadm toolchain, and Calico manifests into a Golden AMI. This reduces
 * instance boot time from ~10-15 minutes to ~2 minutes by moving
 * software installation from user-data to AMI build time.
 *
 * Architecture:
 * 1. Component: Shell commands to install Docker, AWS CLI, kubeadm, kubelet, kubectl, containerd, Calico
 * 2. Recipe: Combines components with parent Amazon Linux 2023 AMI
 * 3. Infrastructure Config: Defines instance type, subnet, security group
 * 4. Pipeline: Orchestrates the build (on-demand trigger)
 * 5. SSM Parameter: Stores the latest AMI ID for LaunchTemplate lookup
 *
 * Design Decision: On-demand builds (not scheduled) — triggered when
 * base software versions need updating. The SSM parameter path serves
 * as the stable reference point for the LaunchTemplate.
 *
 * @example
 * ```typescript
 * const goldenAmi = new GoldenAmiPipelineConstruct(this, 'GoldenAmi', {
 *     namePrefix: 'k8s-development',
 *     imageConfig: configs.image,
 *     clusterConfig: configs.cluster,
 *     vpc,
 *     subnetId: vpc.publicSubnets[0].subnetId,
 *     securityGroupId: sg.securityGroupId,
 * });
 * ```
 */

import * as crypto from 'crypto';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as imagebuilder from 'aws-cdk-lib/aws-imagebuilder';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { KubernetesClusterConfig, K8sImageConfig } from '../../../config/kubernetes/configurations';

// =============================================================================
// PROPS
// =============================================================================

export interface GoldenAmiPipelineProps {
    /** Environment-aware name prefix (e.g., 'k8s-development') */
    readonly namePrefix: string;
    /** Image configuration from K8sConfigs */
    readonly imageConfig: K8sImageConfig;
    /** Cluster configuration for Kubernetes version */
    readonly clusterConfig: KubernetesClusterConfig;
    /** VPC for the Image Builder infrastructure */
    readonly vpc: ec2.IVpc;
    /** Subnet ID for Image Builder instances */
    readonly subnetId: string;
    /** Security group ID for Image Builder instances */
    readonly securityGroupId: string;
}

// =============================================================================
// CONSTRUCT
// =============================================================================

export class GoldenAmiPipelineConstruct extends Construct {

    /** The Image Builder pipeline */
    public readonly pipeline: imagebuilder.CfnImagePipeline;
    /** IAM role used by Image Builder instances */
    public readonly instanceRole: iam.Role;
    /** Instance profile used by Image Builder */
    public readonly instanceProfile: iam.CfnInstanceProfile;

    constructor(scope: Construct, id: string, props: GoldenAmiPipelineProps) {
        super(scope, id);

        const {
            namePrefix,
            imageConfig,
            clusterConfig,
            vpc: _vpc,
            subnetId,
            securityGroupId,
        } = props;

        // -----------------------------------------------------------------
        // 1. IAM Role for Image Builder instances
        // -----------------------------------------------------------------
        this.instanceRole = new iam.Role(this, 'InstanceRole', {
            roleName: `${namePrefix}-image-builder-role`,
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    'AmazonSSMManagedInstanceCore',
                ),
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    'EC2InstanceProfileForImageBuilder',
                ),
            ],
            description: 'IAM role for EC2 Image Builder instances (Golden AMI)',
        });

        this.instanceProfile = new iam.CfnInstanceProfile(this, 'InstanceProfile', {
            instanceProfileName: `${namePrefix}-image-builder-profile`,
            roles: [this.instanceRole.roleName],
        });

        // -----------------------------------------------------------------
        // 2. Image Builder Component — installs Docker, AWS CLI, kubeadm toolchain, Calico
        //
        // Image Builder components are IMMUTABLE — same name + version
        // cannot be updated. We derive the version from a content hash
        // so it auto-bumps whenever install steps or software versions change.
        // -----------------------------------------------------------------
        const componentDoc = this._buildComponentDocument(imageConfig, clusterConfig);

        // Deterministic semver from SHA-256 of component content.
        // First 3 bytes → x.y.z (0-255 each). Same content = same version.
        const contentHash = crypto.createHash('sha256').update(componentDoc).digest();
        const componentVersion = `${contentHash[0]}.${contentHash[1]}.${contentHash[2]}`;

        const installComponent = new imagebuilder.CfnComponent(this, 'InstallComponent', {
            name: `${namePrefix}-golden-ami-install`,
            platform: 'Linux',
            version: componentVersion,
            description: 'Installs Docker, AWS CLI, kubeadm toolchain, and Calico CNI manifests',
            data: componentDoc,
        });

        // -----------------------------------------------------------------
        // 3. Image Builder Recipe
        // -----------------------------------------------------------------
        const recipe = new imagebuilder.CfnImageRecipe(this, 'Recipe', {
            name: `${namePrefix}-golden-ami-recipe`,
            version: componentVersion,
            parentImage: `ssm:${imageConfig.parentImageSsmPath}`,
            components: [
                {
                    componentArn: installComponent.attrArn,
                },
            ],
            blockDeviceMappings: [
                {
                    deviceName: '/dev/xvda',
                    ebs: {
                        volumeSize: 30,
                        volumeType: 'gp3',
                        deleteOnTermination: true,
                        encrypted: true,
                    },
                },
            ],
        });

        // -----------------------------------------------------------------
        // 4. Infrastructure Configuration
        // -----------------------------------------------------------------
        const infraConfig = new imagebuilder.CfnInfrastructureConfiguration(
            this,
            'InfraConfig',
            {
                name: `${namePrefix}-golden-ami-infra`,
                instanceProfileName: this.instanceProfile.instanceProfileName!,
                instanceTypes: ['t3.medium'],
                subnetId,
                securityGroupIds: [securityGroupId],
                terminateInstanceOnFailure: true,
            },
        );
        infraConfig.addDependency(this.instanceProfile);

        // -----------------------------------------------------------------
        // 5. SSM Parameter — stores latest AMI ID
        //
        // The SSM parameter (dataType 'aws:ec2:image') is seeded by the
        // DATA STACK (deployed first) to avoid a Day-0 circular dependency:
        // - LaunchTemplate uses fromSsmParameter() → {{resolve:ssm:...}}
        // - CloudFormation resolves this BEFORE creating any resources
        // - If the parameter doesn't exist → ValidationError
        //
        // Image Builder overwrites the parameter value after each
        // successful build via ssmParameterConfigurations in the
        // distribution config below.
        // -----------------------------------------------------------------

        // Grant Image Builder permission to write the AMI ID to SSM.
        // NOTE: We build the ARN manually instead of using
        // ssm.StringParameter.fromStringParameterName() + grantWrite() because
        // the import creates a {{resolve:ssm:...}} token that CloudFormation
        // tries to resolve at deploy time — failing if the parameter doesn't
        // exist yet (Day-0 or after parameter deletion).
        this.instanceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'SsmWriteGoldenAmi',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:PutParameter',
                'ssm:AddTagsToResource',
                'ssm:GetParameters',
            ],
            resources: [
                cdk.Arn.format({
                    service: 'ssm',
                    resource: 'parameter',
                    resourceName: imageConfig.amiSsmPath.replace(/^\//, ''),
                }, cdk.Stack.of(this)),
            ],
        }));

        // -----------------------------------------------------------------
        // 6. Distribution Configuration — AMI tagging & naming
        //
        // NOTE: amiDistributionConfiguration uses PascalCase raw JSON due to
        // a known CDK/CloudFormation binding issue where camelCase properties
        // fail CloudFormation validation.
        //
        // SSM parameter update is handled by the CI pipeline
        // (_build-golden-ami.yml) after a successful build, because the
        // Image Builder service-linked role (AWSServiceRoleForImageBuilder)
        // does not have ssm:PutParameter on custom parameter paths.
        // -----------------------------------------------------------------
        const distribution = new imagebuilder.CfnDistributionConfiguration(
            this,
            'Distribution',
            {
                name: `${namePrefix}-golden-ami-dist`,
                distributions: [
                    {
                        region: cdk.Stack.of(this).region,
                        amiDistributionConfiguration: {
                            Name: `${namePrefix}-golden-ami-{{ imagebuilder:buildDate }}`,
                            Description: `Golden AMI for ${namePrefix} (kubeadm ${clusterConfig.kubernetesVersion})`,
                            AmiTags: {
                                'Purpose': 'GoldenAMI',
                                'KubernetesVersion': clusterConfig.kubernetesVersion,
                                'Component': 'ImageBuilder',
                            },
                        },
                    },
                ],
            },
        );

        // -----------------------------------------------------------------
        // 7. Image Pipeline (on-demand — no schedule)
        // -----------------------------------------------------------------
        this.pipeline = new imagebuilder.CfnImagePipeline(this, 'Pipeline', {
            name: `${namePrefix}-golden-ami-pipeline`,
            imageRecipeArn: recipe.attrArn,
            infrastructureConfigurationArn: infraConfig.attrArn,
            distributionConfigurationArn: distribution.attrArn,
            status: 'ENABLED',
            imageTestsConfiguration: {
                imageTestsEnabled: true,
                timeoutMinutes: 60,
            },
            // No schedule — on-demand builds only
        });

        // Tag for identification
        cdk.Tags.of(this).add('Component', 'GoldenAmiPipeline');
    }

    // =====================================================================
    // PRIVATE METHODS
    // =====================================================================

    /**
     * Builds the EC2 Image Builder component YAML document.
     *
     * This installs containerd, kubeadm, kubelet, kubectl, and pre-downloads
     * Calico CNI manifests. Kubernetes components are installed but NOT started.
     * Cluster initialization happens at runtime via user-data (kubeadm init/join).
     */
    private _buildComponentDocument(
        imageConfig: K8sImageConfig,
        clusterConfig: KubernetesClusterConfig,
    ): string {
        // Extract major.minor for Kubernetes apt repo (e.g., '1.35')
        const k8sMinorVersion = clusterConfig.kubernetesVersion.split('.').slice(0, 2).join('.');
        return `
name: GoldenAmiInstall
description: Install containerd, kubeadm, kubelet, kubectl, and Calico manifests
schemaVersion: 1.0

phases:
  - name: build
    steps:
      - name: DetectArchitecture
        action: ExecuteBash
        inputs:
          commands:
            - |
              # Detect CPU architecture for multi-arch support (x86_64 / aarch64 Graviton)
              UNAME_ARCH=$(uname -m)
              case $UNAME_ARCH in
                x86_64)  ARCH=amd64; COMPOSE_ARCH=x86_64; CLI_ARCH=x86_64 ;;
                aarch64) ARCH=arm64; COMPOSE_ARCH=aarch64; CLI_ARCH=aarch64 ;;
                *) echo "ERROR: Unsupported architecture: $UNAME_ARCH"; exit 1 ;;
              esac
              # Persist for subsequent build steps (idempotent: strip old values first)
              sed -i '/^ARCH=/d; /^COMPOSE_ARCH=/d; /^CLI_ARCH=/d' /etc/environment
              echo "ARCH=$ARCH" >> /etc/environment
              echo "COMPOSE_ARCH=$COMPOSE_ARCH" >> /etc/environment
              echo "CLI_ARCH=$CLI_ARCH" >> /etc/environment
              echo "Detected architecture: $UNAME_ARCH → ARCH=$ARCH, COMPOSE_ARCH=$COMPOSE_ARCH, CLI_ARCH=$CLI_ARCH"

      - name: UpdateSystem
        action: ExecuteBash
        inputs:
          commands:
            - source /etc/environment
            - dnf update -y
            - dnf install -y jq unzip tar iproute-tc conntrack-tools socat

      - name: InstallDocker
        action: ExecuteBash
        inputs:
          commands:
            - source /etc/environment
            - dnf install -y docker
            - systemctl enable docker
            - usermod -aG docker ec2-user
            - mkdir -p /usr/local/lib/docker/cli-plugins
            - curl -fsSL "https://github.com/docker/compose/releases/download/${imageConfig.bakedVersions.dockerCompose}/docker-compose-linux-$COMPOSE_ARCH" -o /usr/local/lib/docker/cli-plugins/docker-compose
            - chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

      - name: InstallAwsCli
        action: ExecuteBash
        inputs:
          commands:
            - source /etc/environment
            - curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$CLI_ARCH.zip" -o /tmp/awscli.zip
            - unzip -qo /tmp/awscli.zip -d /tmp
            - /tmp/aws/install --update
            - rm -rf /tmp/awscli.zip /tmp/aws
            - aws --version

      - name: InstallCloudWatchAgent
        action: ExecuteBash
        inputs:
          commands:
            - |
              source /etc/environment
              # Install CloudWatch Agent (streams boot logs to CloudWatch in real-time)
              dnf install -y amazon-cloudwatch-agent

              # Bake agent config — the boot script replaces __LOG_GROUP_NAME__ and
              # __AWS_REGION__ at runtime before starting the agent
              mkdir -p /opt/aws/amazon-cloudwatch-agent/etc
              cat > /opt/aws/amazon-cloudwatch-agent/etc/boot-logs.json <<'CWAGENT_EOF'
              {
                "agent": {
                  "run_as_user": "root",
                  "logfile": "/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log"
                },
                "logs": {
                  "logs_collected": {
                    "files": {
                      "collect_list": [
                        {
                          "file_path": "/var/log/user-data.log",
                          "log_group_name": "__LOG_GROUP_NAME__",
                          "log_stream_name": "{instance_id}/user-data",
                          "timestamp_format": "%Y-%m-%d %H:%M:%S",
                          "retention_in_days": 30
                        },
                        {
                          "file_path": "/var/log/cloud-init-output.log",
                          "log_group_name": "__LOG_GROUP_NAME__",
                          "log_stream_name": "{instance_id}/cloud-init-output",
                          "timestamp_format": "%Y-%m-%d %H:%M:%S",
                          "retention_in_days": 30
                        },
                        {
                          "file_path": "/var/log/messages",
                          "log_group_name": "__LOG_GROUP_NAME__",
                          "log_stream_name": "{instance_id}/syslog",
                          "timestamp_format": "%b %d %H:%M:%S",
                          "retention_in_days": 30
                        }
                      ]
                    }
                  }
                }
              }
              CWAGENT_EOF
              echo "CloudWatch Agent installed and config baked"

      - name: KernelModulesAndSysctl
        action: ExecuteBash
        inputs:
          commands:
            - |
              # Load required kernel modules for Kubernetes networking
              cat > /etc/modules-load.d/k8s.conf <<EOF
              overlay
              br_netfilter
              EOF
              modprobe overlay
              modprobe br_netfilter

              # Set required sysctl parameters (persist across reboots)
              cat > /etc/sysctl.d/k8s.conf <<EOF
              net.bridge.bridge-nf-call-iptables  = 1
              net.bridge.bridge-nf-call-ip6tables = 1
              net.ipv4.ip_forward                 = 1
              EOF
              sysctl --system

              echo "Kernel modules and sysctl configured for Kubernetes"

      - name: InstallContainerd
        action: ExecuteBash
        inputs:
          commands:
            - |
              source /etc/environment  # ARCH set by DetectArchitecture step

              # Install containerd as the container runtime
              CONTAINERD_VERSION="${imageConfig.bakedVersions.containerd}"
              curl -fsSL "https://github.com/containerd/containerd/releases/download/v\${CONTAINERD_VERSION}/containerd-\${CONTAINERD_VERSION}-linux-\${ARCH}.tar.gz" \
                -o /tmp/containerd.tar.gz
              tar -C /usr/local -xzf /tmp/containerd.tar.gz
              rm /tmp/containerd.tar.gz

              # Install containerd systemd service
              mkdir -p /usr/local/lib/systemd/system
              curl -fsSL "https://raw.githubusercontent.com/containerd/containerd/main/containerd.service" \
                -o /usr/local/lib/systemd/system/containerd.service

              # Configure containerd with SystemdCgroup
              mkdir -p /etc/containerd
              containerd config default > /etc/containerd/config.toml
              sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml

              systemctl daemon-reload
              systemctl enable containerd

              # Install runc
              RUNC_VERSION="${imageConfig.bakedVersions.runc}"
              curl -fsSL "https://github.com/opencontainers/runc/releases/download/v\${RUNC_VERSION}/runc.\${ARCH}" \
                -o /usr/local/sbin/runc
              chmod +x /usr/local/sbin/runc

              # Install CNI plugins
              CNI_VERSION="${imageConfig.bakedVersions.cniPlugins}"
              mkdir -p /opt/cni/bin
              curl -fsSL "https://github.com/containernetworking/plugins/releases/download/v\${CNI_VERSION}/cni-plugins-linux-\${ARCH}-v\${CNI_VERSION}.tgz" \
                -o /tmp/cni-plugins.tgz
              tar -C /opt/cni/bin -xzf /tmp/cni-plugins.tgz
              rm /tmp/cni-plugins.tgz

              # Install crictl
              CRICTL_VERSION="${imageConfig.bakedVersions.crictl}"
              curl -fsSL "https://github.com/kubernetes-sigs/cri-tools/releases/download/v\${CRICTL_VERSION}/crictl-v\${CRICTL_VERSION}-linux-\${ARCH}.tar.gz" \
                -o /tmp/crictl.tar.gz
              tar -C /usr/local/bin -xzf /tmp/crictl.tar.gz
              rm /tmp/crictl.tar.gz
              crictl config --set runtime-endpoint=unix:///run/containerd/containerd.sock

              echo "containerd, runc, CNI plugins, and crictl installed (arch: \${ARCH})"

      - name: InstallKubeadmKubeletKubectl
        action: ExecuteBash
        inputs:
          commands:
            - |
              # Install kubeadm, kubelet, kubectl via Kubernetes yum repo
              cat > /etc/yum.repos.d/kubernetes.repo <<EOF
              [kubernetes]
              name=Kubernetes
              baseurl=https://pkgs.k8s.io/core:/stable:/v${k8sMinorVersion}/rpm/
              enabled=1
              gpgcheck=1
              gpgkey=https://pkgs.k8s.io/core:/stable:/v${k8sMinorVersion}/rpm/repodata/repomd.xml.key
              EOF

              dnf install -y kubelet-${clusterConfig.kubernetesVersion} kubeadm-${clusterConfig.kubernetesVersion} kubectl-${clusterConfig.kubernetesVersion} --disableexcludes=kubernetes
              systemctl enable kubelet

              echo "kubeadm $(kubeadm version -o short) installed"
              echo "kubelet  — enabled (will start after kubeadm init/join)"
              echo "kubectl $(kubectl version --client -o yaml | grep gitVersion)"

      - name: InstallEcrCredentialProvider
        action: ExecuteBash
        inputs:
          commands:
            - |
              source /etc/environment  # ARCH set by DetectArchitecture step

              # Install ecr-credential-provider for kubelet ECR authentication
              # This allows kubelet to pull container images from private ECR repositories
              # without pre-configured docker credentials or cron-based token refresh.
              ECR_PROVIDER_VERSION="v1.31.1"
              curl -fsSL "https://artifacts.k8s.io/binaries/cloud-provider-aws/\${ECR_PROVIDER_VERSION}/linux/\${ARCH}/ecr-credential-provider-linux-\${ARCH}" \
                -o /usr/local/bin/ecr-credential-provider
              chmod +x /usr/local/bin/ecr-credential-provider
              echo "ecr-credential-provider \${ECR_PROVIDER_VERSION} installed"

              # Create kubelet credential provider config
              mkdir -p /etc/kubernetes
              cat > /etc/kubernetes/image-credential-provider-config.yaml <<CREDEOF
              apiVersion: kubelet.config.k8s.io/v1
              kind: CredentialProviderConfig
              providers:
                - name: ecr-credential-provider
                  matchImages:
                    - "*.dkr.ecr.*.amazonaws.com"
                  defaultCacheDuration: "12h"
                  apiVersion: credentialprovider.kubelet.k8s.io/v1
              CREDEOF
              echo "Kubelet credential provider config created"

      - name: PreloadCalicoCNI
        action: ExecuteBash
        inputs:
          commands:
            - |
              # Pre-download Calico manifests to /opt/calico (avoids GitHub fetch at boot)
              mkdir -p /opt/calico
              CALICO_VERSION="${imageConfig.bakedVersions.calico}"
              curl -fsSL "https://raw.githubusercontent.com/projectcalico/calico/\${CALICO_VERSION}/manifests/tigera-operator.yaml" -o /opt/calico/tigera-operator.yaml
              curl -fsSL "https://raw.githubusercontent.com/projectcalico/calico/\${CALICO_VERSION}/manifests/calico.yaml" -o /opt/calico/calico.yaml
              echo "\${CALICO_VERSION}" > /opt/calico/version.txt
              echo "Calico \${CALICO_VERSION} manifests cached (operator + standalone)"

      - name: InstallCfnBootstrap
        action: ExecuteBash
        inputs:
          commands:
            - |
              # Install aws-cfn-bootstrap for CloudFormation signaling (cfn-signal)
              # Previously installed at runtime by bootstrap scripts
              dnf install -y aws-cfn-bootstrap
              test -f /opt/aws/bin/cfn-signal
              echo "aws-cfn-bootstrap installed (cfn-signal available)"

      - name: InstallHelm
        action: ExecuteBash
        inputs:
          commands:
            - |
              # Install Helm for Traefik ingress controller deployment
              # Previously downloaded at runtime by bootstrap scripts via get-helm-3 script
              curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
              helm version --short
              echo "Helm installed"

      - name: InstallPythonDependencies
        action: ExecuteBash
        inputs:
          commands:
            - |
              # Install pip and Python packages required by deploy.py and bootstrap_argocd.py
              dnf install -y python3-pip
              pip3 install boto3 pyyaml
              python3 -c "import boto3; print('boto3', boto3.__version__)"
              echo "Python dependencies installed"

      - name: CreateDataDirectory
        action: ExecuteBash
        inputs:
          commands:
            - mkdir -p /data/kubernetes /data/k8s-bootstrap /data/app-deploy

  - name: validate
    steps:
      - name: VerifyInstallations
        action: ExecuteBash
        inputs:
          commands:
            - docker --version
            - aws --version
            - /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a status || echo "CloudWatch Agent installed (not running — starts at boot)"
            - test -f /opt/aws/amazon-cloudwatch-agent/etc/boot-logs.json
            - containerd --version
            - runc --version
            - crictl --version
            - kubeadm version -o short
            - kubelet --version
            - kubectl version --client -o yaml | grep gitVersion
            - test -f /opt/calico/calico.yaml
            - test -f /etc/containerd/config.toml
            - test -f /etc/sysctl.d/k8s.conf
            - test -f /opt/aws/bin/cfn-signal
            - helm version --short
            - python3 -c "import boto3; print('boto3', boto3.__version__)"
            - python3 -c "import yaml; print('pyyaml available')"
            - test -f /usr/local/bin/ecr-credential-provider
            - test -f /etc/kubernetes/image-credential-provider-config.yaml
            - echo "All kubeadm components verified"
`;
    }
}
