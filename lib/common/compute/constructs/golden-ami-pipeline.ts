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

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as imagebuilder from 'aws-cdk-lib/aws-imagebuilder';
import * as ssm from 'aws-cdk-lib/aws-ssm';
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
    /** SSM parameter storing the latest Golden AMI ID */
    public readonly amiSsmParameter: ssm.StringParameter;
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
        // -----------------------------------------------------------------
        const installComponent = new imagebuilder.CfnComponent(this, 'InstallComponent', {
            name: `${namePrefix}-golden-ami-install`,
            platform: 'Linux',
            version: '1.0.0',
            description: 'Installs Docker, AWS CLI, kubeadm toolchain, and Calico CNI manifests',
            data: this._buildComponentDocument(imageConfig, clusterConfig),
        });

        // -----------------------------------------------------------------
        // 3. Image Builder Recipe
        // -----------------------------------------------------------------
        const recipe = new imagebuilder.CfnImageRecipe(this, 'Recipe', {
            name: `${namePrefix}-golden-ami-recipe`,
            version: '1.0.0',
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
        // Created before the distribution config so it can be referenced
        // as a target. Initially set to a placeholder; Image Builder
        // overwrites it with the actual AMI ID after each successful build.
        // The LaunchTemplate looks up this parameter to resolve the AMI.
        // -----------------------------------------------------------------
        this.amiSsmParameter = new ssm.StringParameter(this, 'AmiParameter', {
            parameterName: imageConfig.amiSsmPath,
            stringValue: 'PENDING_FIRST_BUILD',
            description: `Latest Golden AMI ID for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
        });

        // Grant Image Builder permission to write the AMI ID to SSM
        this.amiSsmParameter.grantWrite(this.instanceRole);

        // -----------------------------------------------------------------
        // 6. Distribution Configuration — outputs AMI ID to SSM
        //
        // NOTE: amiDistributionConfiguration uses PascalCase raw JSON due to
        // a known CDK/CloudFormation binding issue where camelCase properties
        // fail CloudFormation validation.
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
                        // Write the built AMI ID to the SSM parameter so the
                        // LaunchTemplate can resolve it at deploy time
                        ssmParameterConfigurations: [
                            {
                                parameterName: this.amiSsmParameter.parameterName,
                                dataType: 'aws:ec2:image',
                            },
                        ],
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
              # Persist for subsequent build steps
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
            - dnf install -y jq curl unzip tar iproute-tc conntrack-tools socat

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

              dnf install -y kubelet kubeadm kubectl --disableexcludes=kubernetes
              systemctl enable kubelet

              echo "kubeadm $(kubeadm version -o short) installed"
              echo "kubelet  — enabled (will start after kubeadm init/join)"
              echo "kubectl $(kubectl version --client -o yaml | grep gitVersion)"

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

      - name: CreateDataDirectory
        action: ExecuteBash
        inputs:
          commands:
            - mkdir -p /data/kubernetes /data/k8s/manifests

  - name: validate
    steps:
      - name: VerifyInstallations
        action: ExecuteBash
        inputs:
          commands:
            - docker --version
            - aws --version
            - containerd --version
            - runc --version
            - crictl --version
            - kubeadm version -o short
            - kubelet --version
            - kubectl version --client -o yaml | grep gitVersion
            - test -f /opt/calico/calico.yaml
            - test -f /etc/containerd/config.toml
            - test -f /etc/sysctl.d/k8s.conf
            - echo "All kubeadm components verified"
`;
    }
}
