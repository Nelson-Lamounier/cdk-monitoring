/**
 * @format
 * Golden AMI Pipeline Construct
 *
 * Creates an EC2 Image Builder pipeline that pre-bakes Docker, AWS CLI,
 * k3s binary, and Calico manifests into a Golden AMI. This reduces
 * instance boot time from ~10-15 minutes to ~2 minutes by moving
 * software installation from user-data to AMI build time.
 *
 * Architecture:
 * 1. Component: Shell commands to install Docker, AWS CLI, k3s, Calico
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

import { K3sClusterConfig, K8sImageConfig } from '../../../config/kubernetes/configurations';

// =============================================================================
// PROPS
// =============================================================================

export interface GoldenAmiPipelineProps {
    /** Environment-aware name prefix (e.g., 'k8s-development') */
    readonly namePrefix: string;
    /** Image configuration from K8sConfigs */
    readonly imageConfig: K8sImageConfig;
    /** Cluster configuration for k3s version */
    readonly clusterConfig: K3sClusterConfig;
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
        // 2. Image Builder Component — installs Docker, AWS CLI, k3s, Calico
        // -----------------------------------------------------------------
        const installComponent = new imagebuilder.CfnComponent(this, 'InstallComponent', {
            name: `${namePrefix}-golden-ami-install`,
            platform: 'Linux',
            version: '1.0.0',
            description: 'Installs Docker, AWS CLI, k3s binary, and Calico CNI manifests',
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
        // 5. Distribution Configuration — outputs AMI ID to SSM
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
                            Description: `Golden AMI for ${namePrefix} (k3s ${clusterConfig.channel})`,
                            AmiTags: {
                                'Purpose': 'GoldenAMI',
                                'K3sChannel': clusterConfig.channel,
                                'Component': 'ImageBuilder',
                            },
                        },
                    },
                ],
            },
        );

        // -----------------------------------------------------------------
        // 6. Image Pipeline (on-demand — no schedule)
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

        // -----------------------------------------------------------------
        // 7. SSM Parameter — stores latest AMI ID
        //
        // Initially set to a placeholder. Image Builder updates this
        // after each successful build. The LaunchTemplate looks up this
        // parameter to resolve the AMI at deploy time.
        // -----------------------------------------------------------------
        this.amiSsmParameter = new ssm.StringParameter(this, 'AmiParameter', {
            parameterName: imageConfig.amiSsmPath,
            stringValue: 'PENDING_FIRST_BUILD',
            description: `Latest Golden AMI ID for ${namePrefix}`,
            tier: ssm.ParameterTier.STANDARD,
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
     * This installs Docker, AWS CLI, and k3s binary (but does NOT start k3s).
     * k3s initialization happens at runtime via user-data or SSM State Manager.
     */
    private _buildComponentDocument(
        imageConfig: K8sImageConfig,
        clusterConfig: K3sClusterConfig,
    ): string {
        return `
name: GoldenAmiInstall
description: Install Docker, AWS CLI, k3s binary, and Calico manifests
schemaVersion: 1.0

phases:
  - name: build
    steps:
      - name: UpdateSystem
        action: ExecuteBash
        inputs:
          commands:
            - dnf update -y
            - dnf install -y jq curl unzip tar

      - name: InstallDocker
        action: ExecuteBash
        inputs:
          commands:
            - dnf install -y docker
            - systemctl enable docker
            - usermod -aG docker ec2-user
            - mkdir -p /usr/local/lib/docker/cli-plugins
            - curl -fsSL "https://github.com/docker/compose/releases/download/${imageConfig.bakedVersions.dockerCompose}/docker-compose-linux-x86_64" -o /usr/local/lib/docker/cli-plugins/docker-compose
            - chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

      - name: InstallAwsCli
        action: ExecuteBash
        inputs:
          commands:
            - curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip
            - unzip -qo /tmp/awscli.zip -d /tmp
            - /tmp/aws/install --update
            - rm -rf /tmp/awscli.zip /tmp/aws
            - aws --version

      - name: InstallK3sBinary
        action: ExecuteBash
        inputs:
          commands:
            - |
              # Download k3s binary only (do NOT start k3s — that's a runtime task)
              curl -fsSL https://get.k3s.io -o /usr/local/bin/k3s-install.sh
              chmod +x /usr/local/bin/k3s-install.sh
              INSTALL_K3S_SKIP_START=true INSTALL_K3S_CHANNEL=${clusterConfig.channel} /usr/local/bin/k3s-install.sh
              k3s --version

      - name: PreloadCalicoCNI
        action: ExecuteBash
        inputs:
          commands:
            - |
              # Pre-download Calico manifests to /opt/calico
              mkdir -p /opt/calico
              CALICO_VERSION="v3.29.3"
              curl -fsSL "https://raw.githubusercontent.com/projectcalico/calico/\${CALICO_VERSION}/manifests/calico.yaml" -o /opt/calico/calico.yaml
              echo "\${CALICO_VERSION}" > /opt/calico/version.txt
              echo "Calico \${CALICO_VERSION} manifests cached"

      - name: CreateDataDirectory
        action: ExecuteBash
        inputs:
          commands:
            - mkdir -p /data/k3s /data/k8s/manifests

  - name: validate
    steps:
      - name: VerifyInstallations
        action: ExecuteBash
        inputs:
          commands:
            - docker --version
            - aws --version
            - k3s --version
            - test -f /opt/calico/calico.yaml
            - echo "All components verified"
`;
    }
}
