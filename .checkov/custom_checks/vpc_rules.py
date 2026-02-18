"""
Custom Checkov Rules for VPC Security

CKV_CUSTOM_VPC_5: Ensure subnets do not auto-assign public IPs
CKV_CUSTOM_VPC_6: Ensure VPC Endpoints have a restrictive policy document
"""

from checkov.cloudformation.checks.resource.base_resource_check import (
    BaseResourceCheck,
)
from checkov.common.models.enums import CheckCategories, CheckResult


# =============================================================================
# CKV_CUSTOM_VPC_5: Subnet No Auto-Public IP
# =============================================================================
class SubnetNoAutoPublicIp(BaseResourceCheck):
    """
    Ensure subnets do not auto-assign public IPs (prod should use private subnets).

    In production, compute subnets (EC2, ECS, Lambda) should be private.
    Only ALB/NLB subnets need to be public.
    """

    def __init__(self):
        name = "Ensure subnets do not auto-assign public IPs (prod should use private subnets)"
        id = "CKV_CUSTOM_VPC_5"
        supported_resources = ["AWS::EC2::Subnet"]
        categories = [CheckCategories.NETWORKING]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        properties = conf.get("Properties", {})
        if properties is None:
            return CheckResult.PASSED

        auto_assign = properties.get("MapPublicIpOnLaunch", False)
        if auto_assign is True or str(auto_assign).lower() == "true":
            return CheckResult.FAILED

        return CheckResult.PASSED


# =============================================================================
# CKV_CUSTOM_VPC_6: VPC Endpoint Policy
# =============================================================================
class VpcEndpointPolicy(BaseResourceCheck):
    """
    Ensure VPC Endpoints have a restrictive policy document.

    Gateway VPC Endpoints (S3, DynamoDB) without an explicit PolicyDocument
    default to full access. Endpoint policies provide defense-in-depth.
    """

    def __init__(self):
        name = "Ensure VPC Endpoints have a restrictive policy document"
        id = "CKV_CUSTOM_VPC_6"
        supported_resources = ["AWS::EC2::VPCEndpoint"]
        categories = [CheckCategories.NETWORKING]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        properties = conf.get("Properties", {})
        if properties is None:
            return CheckResult.FAILED

        policy = properties.get("PolicyDocument")
        if policy and isinstance(policy, dict) and policy.get("Statement"):
            return CheckResult.PASSED

        return CheckResult.FAILED


# =============================================================================
# Register all checks
# =============================================================================
check_subnet = SubnetNoAutoPublicIp()
check_vpc_endpoint = VpcEndpointPolicy()
