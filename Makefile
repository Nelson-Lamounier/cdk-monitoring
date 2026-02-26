# Monitoring Infrastructure Makefile
# 
# Multi-Project Architecture:
# - Monitoring: VpcStack + SecurityGroupStack + EbsStack + ComputeStack
# - NextJS: EcrStack + IamRolesStack + EcsClusterStack + TaskDefStack + NodeExporterTaskDefStack
#           + AlbStack + TaskSgStack + ServiceStack (uses shared VPC from Monitoring)
#
# This Makefile provides convenient targets for common operations including:
# - CDK deployments (deploy, synth, diff, list)
# - Testing (granular and domain-based for CI optimisation)
# - Linting and build
#
# Usage: make <target>
# For help: make help
#
# Usage: make <target>
# For help: make help

.PHONY: help
.DEFAULT_GOAL := help

# ============================================================================
# CONFIGURATION
# ============================================================================

# Default environment and AWS profile
# Environment values: development, staging, production (full names)
ENVIRONMENT ?= development
AWS_PROFILE ?= dev-account
AWS_REGION ?= eu-west-1
AWS_ACCOUNT_ID ?=

# Project names (must match Project enum in config/projects.ts)
PROJECT_MONITORING := monitoring
PROJECT_NEXTJS := nextjs

# Stack names for Monitoring project (modular stacks)
MONITORING_VPC_STACK := Monitoring-Vpc-$(ENVIRONMENT)
MONITORING_SG_STACK := Monitoring-SecurityGroup-$(ENVIRONMENT)
MONITORING_EBS_STACK := Monitoring-Ebs-$(ENVIRONMENT)
MONITORING_COMPUTE_STACK := Monitoring-Compute-$(ENVIRONMENT)
MONITORING_LIFECYCLE_STACK := Monitoring-EbsLifecycle-$(ENVIRONMENT)

# Stack names for NextJS project (8 stacks)
NEXTJS_ECR_STACK := NextJS-EcrStack-$(ENVIRONMENT)
NEXTJS_IAM_STACK := NextJS-IamRolesStack-$(ENVIRONMENT)
NEXTJS_CLUSTER_STACK := NextJS-EcsClusterStack-$(ENVIRONMENT)
NEXTJS_TASKDEF_STACK := NextJS-TaskDefStack-$(ENVIRONMENT)
NEXTJS_NODEEXPORTER_STACK := NextJS-NodeExporterTaskDefStack-$(ENVIRONMENT)
NEXTJS_ALB_STACK := NextJS-AlbStack-$(ENVIRONMENT)
NEXTJS_TASKSG_STACK := NextJS-TaskSgStack-$(ENVIRONMENT)
NEXTJS_SERVICE_STACK := NextJS-ServiceStack-$(ENVIRONMENT)

# Stack names for ORG project (root account resources)
# NOTE: Org project always uses production environment for root account
PROJECT_ORG := org
ORG_DNS_ROLE_STACK := Org-DnsRole-production

# Colours for output
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
NC := \033[0m

# Common test environment variables
TEST_ENV := CDK_DOCKER_VERBOSE=false CDK_DEBUG=false CDK_ASSET_VERBOSE=false DOCKER_BUILDKIT=1 BUILDKIT_PROGRESS=quiet

# ============================================================================
# HELP
# ============================================================================

help: ## Show this help message
	@echo ""
	@echo "$(BLUE)Multi-Project CDK Infrastructure$(NC)"
	@echo "$(YELLOW)Projects: Monitoring | NextJS$(NC)"
	@echo ""
	@echo "$(GREEN)Stack List:$(NC)"
	@grep -E '^list-.*:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(BLUE)%-35s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(GREEN)Monitoring Stacks:$(NC)"
	@grep -E '^(deploy|synth|diff)-monitoring.*:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(BLUE)%-35s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(GREEN)NextJS Stacks:$(NC)"
	@grep -E '^(deploy|synth|diff)-nextjs.*:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(BLUE)%-35s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(GREEN)Testing:$(NC)"
	@grep -E '^test(-[a-z-]+)?:.*?## .*$$' $(MAKEFILE_LIST) | head -6 | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(BLUE)%-35s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(GREEN)Linting & Build:$(NC)"
	@grep -E '^(lint|build|typecheck)(-[a-z-]+)?:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(BLUE)%-35s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(GREEN)Utilities:$(NC)"
	@grep -E '^(clean|install|check-env|bootstrap):.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(BLUE)%-35s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(YELLOW)Configuration:$(NC)"
	@echo "  ENVIRONMENT  = $(ENVIRONMENT)"
	@echo "  AWS_PROFILE  = $(AWS_PROFILE)"
	@echo "  AWS_REGION   = $(AWS_REGION)"
	@echo ""
	@echo "$(YELLOW)Examples:$(NC)"
	@echo "  make list-monitoring                  # List monitoring stacks"
	@echo "  make deploy-monitoring-all            # Deploy all monitoring stacks"
	@echo "  make synth-nextjs-ecr                 # Synth NextJS ECR stack"
	@echo "  make ENVIRONMENT=prod deploy-monitoring-all  # Deploy to prod"
	@echo ""

# ============================================================================
# LIST STACKS
# ============================================================================

list-monitoring: ## List all Monitoring project stacks
	@echo "$(BLUE)Monitoring Project Stacks ($(ENVIRONMENT)):$(NC)"
	cdk list \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE)

list-nextjs: ## List all NextJS project stacks
	@echo "$(BLUE)NextJS Project Stacks ($(ENVIRONMENT)):$(NC)"
	cdk list \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE)

list-all: list-monitoring list-nextjs ## List all project stacks
	@echo ""
	@echo "$(GREEN)All stacks listed$(NC)"

# ============================================================================
# MONITORING PROJECT - SYNTH
# ============================================================================

synth-monitoring-all: ## Synthesise all Monitoring stacks and save to cdk-outputs/
	@echo "$(BLUE)Synthesising all Monitoring stacks...$(NC)"
	@mkdir -p cdk-outputs
	cdk synth $(MONITORING_VPC_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE) > cdk-outputs/$(MONITORING_VPC_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(MONITORING_VPC_STACK).yaml$(NC)"
	cdk synth $(MONITORING_SG_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE) > cdk-outputs/$(MONITORING_SG_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(MONITORING_SG_STACK).yaml$(NC)"
	cdk synth $(MONITORING_EBS_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE) > cdk-outputs/$(MONITORING_EBS_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(MONITORING_EBS_STACK).yaml$(NC)"
	cdk synth $(MONITORING_COMPUTE_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE) > cdk-outputs/$(MONITORING_COMPUTE_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(MONITORING_COMPUTE_STACK).yaml$(NC)"
	cdk synth $(MONITORING_LIFECYCLE_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE) > cdk-outputs/$(MONITORING_LIFECYCLE_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(MONITORING_LIFECYCLE_STACK).yaml$(NC)"
	@echo ""
	@echo "$(GREEN)All Monitoring templates saved to cdk-outputs/:$(NC)"
	@echo "  - $(MONITORING_VPC_STACK).yaml"
	@echo "  - $(MONITORING_SG_STACK).yaml"
	@echo "  - $(MONITORING_EBS_STACK).yaml"
	@echo "  - $(MONITORING_COMPUTE_STACK).yaml"
	@echo "  - $(MONITORING_LIFECYCLE_STACK).yaml"

synth-monitoring-vpc: ## Synthesise Monitoring VPC stack
	@echo "$(BLUE)Synthesising Monitoring VPC stack...$(NC)"
	cdk synth $(MONITORING_VPC_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE)
	@echo ""
	@mkdir -p cdk-outputs
	cdk synth $(MONITORING_VPC_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE) > cdk-outputs/$(MONITORING_VPC_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(MONITORING_VPC_STACK).yaml$(NC)"

synth-monitoring-sg: ## Synthesise Monitoring Security Group stack
	@echo "$(BLUE)Synthesising Monitoring Security Group stack...$(NC)"
	cdk synth $(MONITORING_SG_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE)
	@echo ""
	@mkdir -p cdk-outputs
	cdk synth $(MONITORING_SG_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE) > cdk-outputs/$(MONITORING_SG_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(MONITORING_SG_STACK).yaml$(NC)"

synth-monitoring-ebs: ## Synthesise Monitoring EBS stack
	@echo "$(BLUE)Synthesising Monitoring EBS stack...$(NC)"
	cdk synth $(MONITORING_EBS_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE)
	@echo ""
	@mkdir -p cdk-outputs
	cdk synth $(MONITORING_EBS_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE) > cdk-outputs/$(MONITORING_EBS_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(MONITORING_EBS_STACK).yaml$(NC)"

synth-monitoring-compute: ## Synthesise Monitoring Compute stack
	@echo "$(BLUE)Synthesising Monitoring Compute stack...$(NC)"
	cdk synth $(MONITORING_COMPUTE_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE)
	@echo ""
	@mkdir -p cdk-outputs
	cdk synth $(MONITORING_COMPUTE_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE) > cdk-outputs/$(MONITORING_COMPUTE_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(MONITORING_COMPUTE_STACK).yaml$(NC)"

synth-monitoring-lifecycle: ## Synthesise Monitoring EBS Lifecycle stack
	@echo "$(BLUE)Synthesising Monitoring EBS Lifecycle stack...$(NC)"
	cdk synth $(MONITORING_LIFECYCLE_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE)
	@echo ""
	@mkdir -p cdk-outputs
	cdk synth $(MONITORING_LIFECYCLE_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE) > cdk-outputs/$(MONITORING_LIFECYCLE_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(MONITORING_LIFECYCLE_STACK).yaml$(NC)"

# ============================================================================
# MONITORING PROJECT - DIFF
# ============================================================================

diff-monitoring-all: ## Show diff for all Monitoring stacks
	@echo "$(BLUE)Diffing all Monitoring stacks ($(ENVIRONMENT))...$(NC)"
	cdk diff \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE)

diff-monitoring-vpc: ## Show diff for Monitoring VPC stack
	@echo "$(BLUE)Diffing Monitoring VPC stack...$(NC)"
	cdk diff $(MONITORING_VPC_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE)

diff-monitoring-sg: ## Show diff for Monitoring Security Group stack
	@echo "$(BLUE)Diffing Monitoring Security Group stack...$(NC)"
	cdk diff $(MONITORING_SG_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE)

diff-monitoring-ebs: ## Show diff for Monitoring EBS stack
	@echo "$(BLUE)Diffing Monitoring EBS stack...$(NC)"
	cdk diff $(MONITORING_EBS_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE)

diff-monitoring-compute: ## Show diff for Monitoring Compute stack
	@echo "$(BLUE)Diffing Monitoring Compute stack...$(NC)"
	cdk diff $(MONITORING_COMPUTE_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE)

# ============================================================================
# MONITORING PROJECT - DEPLOY
# ============================================================================

deploy-monitoring-all: ## Deploy all Monitoring stacks in dependency order
	@echo "$(BLUE)Deploying all Monitoring stacks...$(NC)"
	@echo "Environment: $(ENVIRONMENT)"
	@echo "Profile: $(AWS_PROFILE)"
	@echo ""
	cdk deploy --all \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE) \
		--require-approval never
	@echo ""
	@echo "$(GREEN)✓ All Monitoring stacks deployed$(NC)"

deploy-monitoring-vpc: ## Deploy Monitoring VPC stack
	@echo "$(BLUE)Deploying Monitoring VPC stack...$(NC)"
	cdk deploy $(MONITORING_VPC_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE) \
		--require-approval never

deploy-monitoring-sg: ## Deploy Monitoring Security Group stack
	@echo "$(BLUE)Deploying Monitoring Security Group stack...$(NC)"
	cdk deploy $(MONITORING_SG_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE) \
		--require-approval never

deploy-monitoring-ebs: ## Deploy Monitoring EBS stack
	@echo "$(BLUE)Deploying Monitoring EBS stack...$(NC)"
	cdk deploy $(MONITORING_EBS_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE) \
		--require-approval never

deploy-monitoring-compute: ## Deploy Monitoring Compute stack
	@echo "$(BLUE)Deploying Monitoring Compute stack...$(NC)"
	cdk deploy $(MONITORING_COMPUTE_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE) \
		--require-approval never

# ============================================================================
# MONITORING PROJECT - DESTROY
# ============================================================================

destroy-monitoring-all: ## Destroy all Monitoring stacks (DANGEROUS)
	@echo "$(RED)WARNING: This will destroy ALL Monitoring stacks$(NC)"
	@echo "Environment: $(ENVIRONMENT)"
	@echo ""
	@read -p "Are you sure? Type 'yes' to confirm: " confirm; \
	if [ "$$confirm" = "yes" ]; then \
		cdk destroy --all \
			-c project=$(PROJECT_MONITORING) \
			-c environment=$(ENVIRONMENT) \
			--profile $(AWS_PROFILE) \
			--force; \
		echo "$(GREEN)All Monitoring stacks destroyed$(NC)"; \
	else \
		echo "$(YELLOW)Destruction cancelled$(NC)"; \
	fi

destroy-monitoring-compute: ## Destroy Monitoring Compute stack
	@echo "$(RED)Destroying Monitoring Compute stack...$(NC)"
	cdk destroy $(MONITORING_COMPUTE_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE)

destroy-monitoring-ebs: ## Destroy Monitoring EBS stack
	@echo "$(RED)Destroying Monitoring EBS stack...$(NC)"
	cdk destroy $(MONITORING_EBS_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE)

destroy-monitoring-sg: ## Destroy Monitoring Security Group stack
	@echo "$(RED)Destroying Monitoring Security Group stack...$(NC)"
	cdk destroy $(MONITORING_SG_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE)

destroy-monitoring-vpc: ## Destroy Monitoring VPC stack
	@echo "$(RED)Destroying Monitoring VPC stack...$(NC)"
	cdk destroy $(MONITORING_VPC_STACK) \
		-c project=$(PROJECT_MONITORING) \
		-c environment=$(ENVIRONMENT) \
		--profile $(AWS_PROFILE)

# ============================================================================
# NEXTJS PROJECT - SYNTH
# ============================================================================

synth-nextjs-all: ## Synthesise all NextJS stacks and save to cdk-outputs/
	@echo "$(BLUE)Synthesising all NextJS stacks...$(NC)"
	@mkdir -p cdk-outputs
	cdk synth $(NEXTJS_ECR_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) > cdk-outputs/$(NEXTJS_ECR_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(NEXTJS_ECR_STACK).yaml$(NC)"
	cdk synth $(NEXTJS_ECS_CLUSTER_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) > cdk-outputs/$(NEXTJS_ECS_CLUSTER_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(NEXTJS_ECS_CLUSTER_STACK).yaml$(NC)"
	@echo ""
	@echo "$(GREEN)All NextJS templates saved to cdk-outputs/$(NC)"

synth-nextjs-ecr: ## Synthesise NextJS ECR stack
	@echo "$(BLUE)Synthesising NextJS ECR stack...$(NC)"
	@mkdir -p cdk-outputs
	cdk synth $(NEXTJS_ECR_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) \
	@echo ""
	@mkdir -p cdk-outputs
	cdk synth $(NEXTJS_ECR_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) > cdk-outputs/$(NEXTJS_ECR_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(NEXTJS_ECR_STACK).yaml$(NC)"

synth-nextjs-iam: ## Synthesise NextJS IAM Roles stack
	@echo "$(BLUE)Synthesising NextJS IAM Roles stack...$(NC)"
	@mkdir -p cdk-outputs
	cdk synth $(NEXTJS_IAM_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) \
	@echo ""
	@mkdir -p cdk-outputs
	cdk synth $(NEXTJS_IAM_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) > cdk-outputs/$(NEXTJS_IAM_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(NEXTJS_IAM_STACK).yaml$(NC)"

synth-nextjs-cluster: ## Synthesise NextJS ECS Cluster stack
	@echo "$(BLUE)Synthesising NextJS ECS Cluster stack...$(NC)"
	@mkdir -p cdk-outputs
	cdk synth $(NEXTJS_CLUSTER_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) \
	@echo ""
	@mkdir -p cdk-outputs
	cdk synth $(NEXTJS_CLUSTER_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) > cdk-outputs/$(NEXTJS_CLUSTER_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(NEXTJS_CLUSTER_STACK).yaml$(NC)"

synth-nextjs-taskdef: ## Synthesise NextJS Task Definition stack
	@echo "$(BLUE)Synthesising NextJS Task Definition stack...$(NC)"
	@mkdir -p cdk-outputs
	cdk synth $(NEXTJS_TASKDEF_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) \
	@echo ""
	@mkdir -p cdk-outputs
	cdk synth $(NEXTJS_TASKDEF_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) > cdk-outputs/$(NEXTJS_TASKDEF_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(NEXTJS_TASKDEF_STACK).yaml$(NC)"

synth-nextjs-nodeexporter: ## Synthesise NextJS Node Exporter Task Definition stack
	@echo "$(BLUE)Synthesising NextJS Node Exporter Task Definition stack...$(NC)"
	@mkdir -p cdk-outputs
	cdk synth $(NEXTJS_NODEEXPORTER_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) \
	@echo ""
	@mkdir -p cdk-outputs
	cdk synth $(NEXTJS_NODEEXPORTER_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) > cdk-outputs/$(NEXTJS_NODEEXPORTER_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(NEXTJS_NODEEXPORTER_STACK).yaml$(NC)"

synth-nextjs-alb: ## Synthesise NextJS ALB stack
	@echo "$(BLUE)Synthesising NextJS ALB stack...$(NC)"
	@mkdir -p cdk-outputs
	cdk synth $(NEXTJS_ALB_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) \
	@echo ""
	@mkdir -p cdk-outputs
	cdk synth $(NEXTJS_ALB_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) > cdk-outputs/$(NEXTJS_ALB_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(NEXTJS_ALB_STACK).yaml$(NC)"

synth-nextjs-tasksg: ## Synthesise NextJS Task Security Group stack
	@echo "$(BLUE)Synthesising NextJS Task Security Group stack...$(NC)"
	@mkdir -p cdk-outputs
	cdk synth $(NEXTJS_TASKSG_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) \
	@echo ""
	@mkdir -p cdk-outputs
	cdk synth $(NEXTJS_TASKSG_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) > cdk-outputs/$(NEXTJS_TASKSG_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(NEXTJS_TASKSG_STACK).yaml$(NC)"

synth-nextjs-service: ## Synthesise NextJS ECS Service stack
	@echo "$(BLUE)Synthesising NextJS ECS Service stack...$(NC)"
	@mkdir -p cdk-outputs
	cdk synth $(NEXTJS_SERVICE_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) \
	@echo ""
	@mkdir -p cdk-outputs
	cdk synth $(NEXTJS_SERVICE_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) > cdk-outputs/$(NEXTJS_SERVICE_STACK).yaml
	@echo "$(GREEN)Template saved to cdk-outputs/$(NEXTJS_SERVICE_STACK).yaml$(NC)"

# ============================================================================
# NEXTJS PROJECT - DIFF
# ============================================================================

diff-nextjs-all: ## Show diff for all NextJS stacks
	@echo "$(BLUE)Diffing all NextJS stacks ($(ENVIRONMENT))...$(NC)"
	cdk diff \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		-c account=$(AWS_ACCOUNT_ID) \
		-c region=$(AWS_REGION) \
		--profile $(AWS_PROFILE)

diff-nextjs-ecr: ## Show diff for NextJS ECR stack
	@echo "$(BLUE)Diffing NextJS ECR stack...$(NC)"
	cdk diff $(NEXTJS_ECR_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE)

diff-nextjs-iam: ## Show diff for NextJS IAM Roles stack
	@echo "$(BLUE)Diffing NextJS IAM Roles stack...$(NC)"
	cdk diff $(NEXTJS_IAM_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE)

diff-nextjs-cluster: ## Show diff for NextJS ECS Cluster stack
	@echo "$(BLUE)Diffing NextJS ECS Cluster stack...$(NC)"
	cdk diff $(NEXTJS_CLUSTER_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		-c account=$(AWS_ACCOUNT_ID) \
		-c region=$(AWS_REGION) \
		--profile $(AWS_PROFILE)

diff-nextjs-taskdef: ## Show diff for NextJS Task Definition stack
	@echo "$(BLUE)Diffing NextJS Task Definition stack...$(NC)"
	cdk diff $(NEXTJS_TASKDEF_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE)

diff-nextjs-alb: ## Show diff for NextJS ALB stack
	@echo "$(BLUE)Diffing NextJS ALB stack...$(NC)"
	cdk diff $(NEXTJS_ALB_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		-c account=$(AWS_ACCOUNT_ID) \
		-c region=$(AWS_REGION) \
		--profile $(AWS_PROFILE)

diff-nextjs-service: ## Show diff for NextJS ECS Service stack
	@echo "$(BLUE)Diffing NextJS ECS Service stack...$(NC)"
	cdk diff $(NEXTJS_SERVICE_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		-c account=$(AWS_ACCOUNT_ID) \
		-c region=$(AWS_REGION) \
		--profile $(AWS_PROFILE)

# ============================================================================
# NEXTJS PROJECT - DEPLOY
# ============================================================================

deploy-nextjs-all: ## Deploy all NextJS stacks
	@echo "$(BLUE)Deploying all NextJS stacks...$(NC)"
	@echo "Environment: $(ENVIRONMENT)"
	@echo "Profile: $(AWS_PROFILE)"
	@echo ""
	cdk deploy --all \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		-c account=$(AWS_ACCOUNT_ID) \
		-c region=$(AWS_REGION) \
		--profile $(AWS_PROFILE) \
		--require-approval never
	@echo ""
	@echo "$(GREEN)✓ All NextJS stacks deployed$(NC)"

deploy-nextjs-ecr: ## Deploy NextJS ECR stack
	@echo "$(BLUE)Deploying NextJS ECR stack...$(NC)"
	cdk deploy $(NEXTJS_ECR_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) \
		--require-approval never

deploy-nextjs-iam: ## Deploy NextJS IAM Roles stack
	@echo "$(BLUE)Deploying NextJS IAM Roles stack...$(NC)"
	cdk deploy $(NEXTJS_IAM_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) \
		--require-approval never

deploy-nextjs-cluster: ## Deploy NextJS ECS Cluster stack
	@echo "$(BLUE)Deploying NextJS ECS Cluster stack...$(NC)"
	cdk deploy $(NEXTJS_CLUSTER_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		-c account=$(AWS_ACCOUNT_ID) \
		-c region=$(AWS_REGION) \
		--profile $(AWS_PROFILE) \
		--require-approval never

deploy-nextjs-taskdef: ## Deploy NextJS Task Definition stack
	@echo "$(BLUE)Deploying NextJS Task Definition stack...$(NC)"
	cdk deploy $(NEXTJS_TASKDEF_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) \
		--require-approval never

deploy-nextjs-nodeexporter: ## Deploy NextJS Node Exporter Task Definition stack
	@echo "$(BLUE)Deploying NextJS Node Exporter Task Definition stack...$(NC)"
	cdk deploy $(NEXTJS_NODEEXPORTER_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE) \
		--require-approval never

deploy-nextjs-alb: ## Deploy NextJS ALB stack
	@echo "$(BLUE)Deploying NextJS ALB stack...$(NC)"
	cdk deploy $(NEXTJS_ALB_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		-c account=$(AWS_ACCOUNT_ID) \
		-c region=$(AWS_REGION) \
		--profile $(AWS_PROFILE) \
		--require-approval never

deploy-nextjs-tasksg: ## Deploy NextJS Task Security Group stack
	@echo "$(BLUE)Deploying NextJS Task Security Group stack...$(NC)"
	cdk deploy $(NEXTJS_TASKSG_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		-c account=$(AWS_ACCOUNT_ID) \
		-c region=$(AWS_REGION) \
		--profile $(AWS_PROFILE) \
		--require-approval never

deploy-nextjs-service: ## Deploy NextJS ECS Service stack
	@echo "$(BLUE)Deploying NextJS ECS Service stack...$(NC)"
	cdk deploy $(NEXTJS_SERVICE_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		-c account=$(AWS_ACCOUNT_ID) \
		-c region=$(AWS_REGION) \
		--profile $(AWS_PROFILE) \
		--require-approval never

# ============================================================================
# NEXTJS PROJECT - DESTROY
# ============================================================================

destroy-nextjs-all: ## Destroy all NextJS stacks (DANGEROUS)
	@echo "$(RED)WARNING: This will destroy ALL NextJS stacks$(NC)"
	@echo "Environment: $(ENVIRONMENT)"
	@echo ""
	@read -p "Are you sure? Type 'yes' to confirm: " confirm; \
	if [ "$$confirm" = "yes" ]; then \
		cdk destroy --all \
			-c project=$(PROJECT_NEXTJS) \
			-c environment=$(ENVIRONMENT) \
			-c useSharedVpc=Monitoring \
			-c account=$(AWS_ACCOUNT_ID) \
			-c region=$(AWS_REGION) \
			--profile $(AWS_PROFILE) \
			--force; \
		echo "$(GREEN)All NextJS stacks destroyed$(NC)"; \
	else \
		echo "$(YELLOW)Destruction cancelled$(NC)"; \
	fi

destroy-nextjs-service: ## Destroy NextJS ECS Service stack (destroy first)
	@echo "$(RED)Destroying NextJS ECS Service stack...$(NC)"
	cdk destroy $(NEXTJS_SERVICE_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE)

destroy-nextjs-tasksg: ## Destroy NextJS Task Security Group stack
	@echo "$(RED)Destroying NextJS Task Security Group stack...$(NC)"
	cdk destroy $(NEXTJS_TASKSG_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE)

destroy-nextjs-alb: ## Destroy NextJS ALB stack
	@echo "$(RED)Destroying NextJS ALB stack...$(NC)"
	cdk destroy $(NEXTJS_ALB_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE)

destroy-nextjs-nodeexporter: ## Destroy NextJS Node Exporter Task Definition stack
	@echo "$(RED)Destroying NextJS Node Exporter Task Definition stack...$(NC)"
	cdk destroy $(NEXTJS_NODEEXPORTER_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE)

destroy-nextjs-taskdef: ## Destroy NextJS Task Definition stack
	@echo "$(RED)Destroying NextJS Task Definition stack...$(NC)"
	cdk destroy $(NEXTJS_TASKDEF_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE)

destroy-nextjs-cluster: ## Destroy NextJS ECS Cluster stack
	@echo "$(RED)Destroying NextJS ECS Cluster stack...$(NC)"
	cdk destroy $(NEXTJS_CLUSTER_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE)

destroy-nextjs-iam: ## Destroy NextJS IAM Roles stack
	@echo "$(RED)Destroying NextJS IAM Roles stack...$(NC)"
	cdk destroy $(NEXTJS_IAM_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE)

destroy-nextjs-ecr: ## Destroy NextJS ECR stack (destroy last)
	@echo "$(RED)Destroying NextJS ECR stack...$(NC)"
	cdk destroy $(NEXTJS_ECR_STACK) \
		-c project=$(PROJECT_NEXTJS) \
		-c environment=$(ENVIRONMENT) \
		-c useSharedVpc=Monitoring \
		--profile $(AWS_PROFILE)


# ============================================================================
# TESTING
# ============================================================================

test: ## Run all tests
	@echo "$(BLUE)Running tests...$(NC)"
	@$(TEST_ENV) yarn test

test-watch: ## Run tests in watch mode
	@echo "$(BLUE)Running tests in watch mode...$(NC)"
	@$(TEST_ENV) yarn test:watch

test-coverage: ## Run tests with coverage report
	@echo "$(BLUE)Running tests with coverage...$(NC)"
	@$(TEST_ENV) yarn test --coverage
	@echo ""
	@echo "$(GREEN)Coverage report: coverage/lcov-report/index.html$(NC)"

test-update-snapshots: ## Update Jest snapshots
	@echo "$(BLUE)Updating Jest snapshots...$(NC)"
	@$(TEST_ENV) yarn test:update-snapshots

test-unit: ## Run unit tests only
	@echo "$(BLUE)Running unit tests...$(NC)"
	@$(TEST_ENV) yarn test tests/unit

# ============================================================================
# LINTING & BUILD
# ============================================================================

lint: ## Run linter
	@echo "$(BLUE)Running linter...$(NC)"
	npx eslint lib/ bin/ tests/ --max-warnings 0

lint-fix: ## Run linter with auto-fix
	@echo "$(BLUE)Running linter with auto-fix...$(NC)"
	yarn lint:fix

typecheck: ## Run TypeScript type checking
	@echo "$(BLUE)Running TypeScript type checking...$(NC)"
	yarn typecheck

build: ## Build TypeScript code
	@echo "$(BLUE)Building TypeScript...$(NC)"
	yarn build

audit: ## Run security audit
	@echo "$(BLUE)Running security audit...$(NC)"
	yarn npm audit --all --recursive || true

# ============================================================================
# UTILITIES
# ============================================================================

install: ## Install dependencies
	@echo "$(BLUE)Installing dependencies...$(NC)"
	yarn install

clean: ## Clean build artifacts
	@echo "$(BLUE)Cleaning build artifacts...$(NC)"
	rm -rf node_modules dist cdk.out coverage .nyc_output

check-env: ## Verify environment and AWS credentials
	@echo "$(BLUE)Checking environment configuration...$(NC)"
	@echo ""
	@echo "Environment Variables:"
	@echo "  ENVIRONMENT  = $(ENVIRONMENT)"
	@echo "  AWS_PROFILE  = $(AWS_PROFILE)"
	@echo "  AWS_REGION   = $(AWS_REGION)"
	@echo ""
	@echo "Monitoring Stacks:"
	@echo "  $(MONITORING_VPC_STACK)"
	@echo "  $(MONITORING_SG_STACK)"
	@echo "  $(MONITORING_EBS_STACK)"
	@echo "  $(MONITORING_COMPUTE_STACK)"
	@echo ""
	@echo "NextJS Stacks (8 total):"
	@echo "  1. $(NEXTJS_ECR_STACK)"
	@echo "  2. $(NEXTJS_IAM_STACK)"
	@echo "  3. $(NEXTJS_CLUSTER_STACK)"
	@echo "  4. $(NEXTJS_TASKDEF_STACK)"
	@echo "  5. $(NEXTJS_NODEEXPORTER_STACK)"
	@echo "  6. $(NEXTJS_ALB_STACK)"
	@echo "  7. $(NEXTJS_TASKSG_STACK)"
	@echo "  8. $(NEXTJS_SERVICE_STACK)"
	@echo ""
	@echo "Checking AWS credentials..."
	@aws sts get-caller-identity --profile $(AWS_PROFILE) > /dev/null 2>&1 && \
		echo "$(GREEN)✓ AWS credentials valid$(NC)" || \
		(echo "$(RED)✗ AWS credentials invalid$(NC)" && exit 1)

bootstrap: ## Bootstrap CDK in AWS account
	@echo "$(BLUE)Bootstrapping CDK...$(NC)"
	cdk bootstrap aws://$(AWS_ACCOUNT_ID)/$(AWS_REGION) --profile $(AWS_PROFILE)

# ============================================================================
# CODE HEALTH
# ============================================================================

health: lint build test ## Run full code health check
	@echo "$(GREEN)✓ Code health check complete$(NC)"

find-unused: ## Find unused files and exports
	@echo "$(BLUE)Scanning for unused code...$(NC)"
	yarn knip

deps-check: ## Check for dependency rule violations
	@echo "$(BLUE)Checking dependency rules...$(NC)"
	yarn depcruise bin lib lambda config --config .dependency-cruiser.cjs

# ============================================================================
# PROJECT STRUCTURE
# ============================================================================

tree: ## Show directory structure
	@tree -I 'node_modules|cdk.out|dist|coverage|.git' -L 4 --dirsfirst

tree-source: ## Show TypeScript source structure
	@tree -I 'node_modules|cdk.out|dist|coverage|.git' -P '*.ts' --prune
