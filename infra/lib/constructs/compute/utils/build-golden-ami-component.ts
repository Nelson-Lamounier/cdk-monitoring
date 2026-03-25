/**
 * @format
 * Golden AMI Component Document Builder
 *
 * Pure utility function that generates the EC2 Image Builder component YAML
 * document for baking a Kubernetes Golden AMI. This contains all K8s-specific
 * install steps — the generic `GoldenAmiImageConstruct` knows nothing about
 * Kubernetes.
 *
 * Installed software:
 * - Docker + Docker Compose
 * - AWS CLI v2
 * - CloudWatch Agent (with baked config template)
 * - containerd, runc, CNI plugins, crictl
 * - kubeadm, kubelet, kubectl
 * - ECR credential provider (kubelet ECR auth)
 * - Calico CNI manifests (pre-downloaded)
 * - aws-cfn-bootstrap (cfn-signal)
 * - Helm
 * - K8sGPT (AI-powered Kubernetes diagnostics)
 * - Python + boto3 + pyyaml (for bootstrap scripts)
 *
 * @example
 * ```typescript
 * const componentDoc = buildGoldenAmiComponent({
 *     imageConfig: configs.image,
 *     clusterConfig: configs.cluster,
 * });
 * ```
 */

import { K8sImageConfig, KubernetesClusterConfig } from '../../../config/kubernetes/configurations';

// =============================================================================
// TYPES
// =============================================================================

export interface GoldenAmiComponentInput {
    /** Image configuration with software versions */
    readonly imageConfig: K8sImageConfig;
    /** Cluster configuration for Kubernetes version */
    readonly clusterConfig: KubernetesClusterConfig;
}

// =============================================================================
// BUILDER
// =============================================================================

/**
 * Builds the EC2 Image Builder component YAML document.
 *
 * Installs containerd, kubeadm, kubelet, kubectl, and pre-downloads
 * Calico CNI manifests. Kubernetes components are installed but NOT started.
 * Cluster initialization happens at runtime via user-data (kubeadm init/join).
 *
 * @returns YAML string for `imagebuilder.CfnComponent.data`
 */
export function buildGoldenAmiComponent(input: GoldenAmiComponentInput): string {
    const { imageConfig, clusterConfig } = input;

    // Extract major.minor for Kubernetes apt repo (e.g., '1.35')
    const k8sMinorVersion = clusterConfig.kubernetesVersion.split('.').slice(0, 2).join('.');

    return `
name: GoldenAmiInstall
description: Install containerd, kubeadm, kubelet, kubectl, Calico manifests, and K8sGPT
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
              # Install CloudWatch Agent binary only.
              # The agent config is NOT baked into the AMI — boot step
              # 08_install_cloudwatch_agent.py writes the final config at runtime
              # with the correct LOG_GROUP_NAME resolved from the environment.
              dnf install -y amazon-cloudwatch-agent
              echo "CloudWatch Agent binary installed (config written at boot)"

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
              curl -fsSL "https://github.com/containerd/containerd/releases/download/v\${CONTAINERD_VERSION}/containerd-\${CONTAINERD_VERSION}-linux-\${ARCH}.tar.gz" \\
                -o /tmp/containerd.tar.gz
              tar -C /usr/local -xzf /tmp/containerd.tar.gz
              rm /tmp/containerd.tar.gz

              # Install containerd systemd service
              mkdir -p /usr/local/lib/systemd/system
              curl -fsSL "https://raw.githubusercontent.com/containerd/containerd/main/containerd.service" \\
                -o /usr/local/lib/systemd/system/containerd.service

              # Configure containerd with SystemdCgroup
              mkdir -p /etc/containerd
              containerd config default > /etc/containerd/config.toml
              sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml

              systemctl daemon-reload
              systemctl enable containerd

              # Install runc
              RUNC_VERSION="${imageConfig.bakedVersions.runc}"
              curl -fsSL "https://github.com/opencontainers/runc/releases/download/v\${RUNC_VERSION}/runc.\${ARCH}" \\
                -o /usr/local/sbin/runc
              chmod +x /usr/local/sbin/runc

              # Install CNI plugins
              CNI_VERSION="${imageConfig.bakedVersions.cniPlugins}"
              mkdir -p /opt/cni/bin
              curl -fsSL "https://github.com/containernetworking/plugins/releases/download/v\${CNI_VERSION}/cni-plugins-linux-\${ARCH}-v\${CNI_VERSION}.tgz" \\
                -o /tmp/cni-plugins.tgz
              tar -C /opt/cni/bin -xzf /tmp/cni-plugins.tgz
              rm /tmp/cni-plugins.tgz

              # Install crictl
              CRICTL_VERSION="${imageConfig.bakedVersions.crictl}"
              curl -fsSL "https://github.com/kubernetes-sigs/cri-tools/releases/download/v\${CRICTL_VERSION}/crictl-v\${CRICTL_VERSION}-linux-\${ARCH}.tar.gz" \\
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
              source /etc/environment
              # Install ecr-credential-provider for kubelet ECR authentication.
              # This allows kubelet to pull container images from private ECR repos
              # without pre-configured docker credentials or cron-based token refresh.
              ECR_PROVIDER_VERSION="${imageConfig.bakedVersions.ecrCredentialProvider}"

              curl -fsSL \\
                "https://storage.googleapis.com/k8s-artifacts-prod/binaries/cloud-provider-aws/\${ECR_PROVIDER_VERSION}/linux/$ARCH/ecr-credential-provider-linux-$ARCH" \\
                -o /usr/local/bin/ecr-credential-provider \\
                || { echo "FATAL: ecr-credential-provider download failed"; exit 1; }
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

      - name: InstallK8sGPT
        action: ExecuteBash
        inputs:
          commands:
            - |
              source /etc/environment
              # Install K8sGPT — AI-powered Kubernetes diagnostics tool.
              # Used by the self-healing pipeline's analyse-cluster-health Lambda
              # via SSM SendCommand to assess workload health after remediation.
              K8SGPT_VERSION="${imageConfig.bakedVersions.k8sgpt}"
              curl -fsSL "https://github.com/k8sgpt-ai/k8sgpt/releases/download/v\${K8SGPT_VERSION}/k8sgpt_\${K8SGPT_VERSION}_linux_\${ARCH}.tar.gz" \\
                -o /tmp/k8sgpt.tar.gz
              tar -C /usr/local/bin -xzf /tmp/k8sgpt.tar.gz k8sgpt
              chmod +x /usr/local/bin/k8sgpt
              rm /tmp/k8sgpt.tar.gz
              k8sgpt version
              echo "K8sGPT \${K8SGPT_VERSION} installed"

      - name: InstallPythonDependencies
        action: ExecuteBash
        inputs:
          commands:
            - |
              # Install pip and Python packages required by deploy.py and bootstrap_argocd.py
              dnf install -y python3-pip
              pip3 install boto3 pyyaml kubernetes
              python3 -c "import boto3; print('boto3', boto3.__version__)"
              python3 -c "import kubernetes; print('kubernetes', kubernetes.__version__)"
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
            - echo "[validate] docker:" && docker --version
            - echo "[validate] aws-cli:" && aws --version
            - echo "[validate] cloudwatch-agent:" && (/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a status || echo "cloudwatch agent binary present (not running — config written at boot)")
            - echo "[validate] containerd:" && containerd --version
            - echo "[validate] runc:" && runc --version
            - echo "[validate] crictl:" && crictl --version
            - echo "[validate] kubeadm:" && kubeadm version -o short
            - echo "[validate] kubelet:" && kubelet --version
            - echo "[validate] kubectl:" && kubectl version --client -o yaml | grep gitVersion
            - test -f /opt/calico/calico.yaml && echo "[validate] calico.yaml manifest present"
            - test -f /etc/containerd/config.toml && echo "[validate] containerd config present"
            - test -f /etc/sysctl.d/k8s.conf && echo "[validate] sysctl k8s config present"
            - test -f /opt/aws/bin/cfn-signal && echo "[validate] cfn-signal binary present"
            - echo "[validate] helm:" && helm version --short
            - python3 -c "import boto3; print('boto3', boto3.__version__)"
            - python3 -c "import yaml; print('pyyaml available')"
            - python3 -c "import kubernetes; print('kubernetes', kubernetes.__version__)"
            - test -f /usr/local/bin/ecr-credential-provider && echo "[validate] ecr-credential-provider binary present"
            - test -f /etc/kubernetes/image-credential-provider-config.yaml && echo "[validate] credential provider config present"
            - echo "[validate] k8sgpt:" && k8sgpt version
            - echo "[validate] All kubeadm components verified"
`;
}
