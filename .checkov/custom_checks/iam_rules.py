"""
Custom Checkov IAM Rules for cdk-monitoring

Custom rules for IAM best practices specific to this project:
- CKV_CUSTOM_IAM_1: Ensure IAM Role has permissions boundary configured
- CKV_CUSTOM_IAM_2: Ensure no hardcoded account IDs in resource ARNs
- CKV_CUSTOM_IAM_3: Ensure no static role names (allow safe CFN updates)
- CKV_CUSTOM_IAM_4: Ensure role has ≤2 AWS managed policies
- CKV_CUSTOM_IAM_5: Ensure role has at least one policy attached (not empty)

These rules complement the built-in Checkov IAM checks for:
- Privilege escalation prevention
- Credential exposure
- Trust policy security
"""

from __future__ import annotations

import re
from checkov.cloudformation.checks.resource.base_resource_check import (
    BaseResourceCheck,
)
from checkov.common.models.enums import CheckCategories, CheckResult


# =============================================================================
# CKV_CUSTOM_IAM_1: Permissions Boundary Check
# =============================================================================
class IamRoleHasPermissionsBoundary(BaseResourceCheck):
    """
    Ensure IAM Role has a permissions boundary configured.
    
    Permissions boundaries limit the maximum permissions a role can have,
    providing defense-in-depth even if inline policies are overly permissive.
    
    Recommended for production environments.
    """
    
    def __init__(self) -> None:
        name = "Ensure IAM Role has permissions boundary configured"
        id = "CKV_CUSTOM_IAM_1"
        supported_resources = ["AWS::IAM::Role"]
        categories = [CheckCategories.IAM]
        super().__init__(
            name=name,
            id=id,
            categories=categories,
            supported_resources=supported_resources,
        )
    
    def scan_resource_conf(self, conf: dict) -> CheckResult:
        """Check if the role has PermissionsBoundary defined."""
        properties = conf.get("Properties", {})
        if not properties:
            return CheckResult.FAILED
        
        # Check for PermissionsBoundary
        permissions_boundary = properties.get("PermissionsBoundary")
        if permissions_boundary:
            return CheckResult.PASSED
        
        # Special case: Service-linked roles don't need boundaries
        assume_role_doc = properties.get("AssumeRolePolicyDocument", {})
        if self._is_service_linked_role(assume_role_doc):
            return CheckResult.PASSED
        
        return CheckResult.FAILED
    
    def _is_service_linked_role(self, assume_doc: dict) -> bool:
        """Check if this is a service-linked role (AWS-managed)."""
        statements = assume_doc.get("Statement", [])
        for stmt in statements:
            if not isinstance(stmt, dict):
                continue
            principal = stmt.get("Principal", {})
            if isinstance(principal, dict):
                service = principal.get("Service", "")
                # Common service-linked role patterns
                if isinstance(service, str) and "amazonaws.com" in service:
                    if service.startswith("elasticmapreduce") or "autoscaling" in service:
                        return True
        return False


# =============================================================================
# CKV_CUSTOM_IAM_2: No Hardcoded Account IDs
# =============================================================================
class IamPolicyNoHardcodedAccountIds(BaseResourceCheck):
    """
    Ensure no hardcoded AWS account IDs in resource ARNs.
    
    Hardcoded account IDs prevent multi-account portability and can cause
    cross-account access issues. Use pseudo-parameters like !Ref AWS::AccountId
    or dynamic references instead.
    """
    
    # Pattern to match AWS account IDs (12 digits)
    ACCOUNT_ID_PATTERN = re.compile(r':(\d{12}):')
    
    def __init__(self) -> None:
        name = "Ensure no hardcoded account IDs in IAM policy resource ARNs"
        id = "CKV_CUSTOM_IAM_2"
        supported_resources = ["AWS::IAM::Policy", "AWS::IAM::Role"]
        categories = [CheckCategories.IAM]
        super().__init__(
            name=name,
            id=id,
            categories=categories,
            supported_resources=supported_resources,
        )
    
    def scan_resource_conf(self, conf: dict) -> CheckResult:
        """Scan for hardcoded account IDs in resource ARNs."""
        properties = conf.get("Properties", {})
        if not properties:
            return CheckResult.PASSED
        
        # Check inline policies in IAM Role
        policies = properties.get("Policies", [])
        for policy in policies:
            if not isinstance(policy, dict):
                continue
            policy_doc = policy.get("PolicyDocument", {})
            if self._has_hardcoded_account_id(policy_doc):
                return CheckResult.FAILED
        
        # Check PolicyDocument for AWS::IAM::Policy
        policy_doc = properties.get("PolicyDocument", {})
        if policy_doc and self._has_hardcoded_account_id(policy_doc):
            return CheckResult.FAILED
        
        return CheckResult.PASSED
    
    def _has_hardcoded_account_id(self, policy_doc: dict) -> bool:
        """Check if any resource ARN contains a hardcoded account ID."""
        statements = policy_doc.get("Statement", [])
        for stmt in statements:
            if not isinstance(stmt, dict):
                continue
            resources = stmt.get("Resource", [])
            if isinstance(resources, str):
                resources = [resources]
            for resource in resources:
                if not isinstance(resource, str):
                    continue
                # Skip wildcards
                if resource == "*":
                    continue
                # Check for hardcoded 12-digit account ID
                if self.ACCOUNT_ID_PATTERN.search(resource):
                    return True
        return False


# =============================================================================
# CKV_CUSTOM_IAM_3: No Static Role Names
# =============================================================================
class IamRoleNoStaticName(BaseResourceCheck):
    """
    Ensure IAM Roles don't have static names (allow safe CloudFormation updates).
    
    Static role names prevent CloudFormation from safely updating roles that
    require replacement. CDK generates unique names by default; using explicit
    RoleName can cause update failures.
    
    Note: This check PASSES if RoleName is not set (CDK default behavior).
    It WARNS if RoleName is set, as this may be intentional for cross-stack refs.
    """
    
    def __init__(self) -> None:
        name = "Ensure IAM Role does not have static name (allow safe CFN updates)"
        id = "CKV_CUSTOM_IAM_3"
        supported_resources = ["AWS::IAM::Role"]
        categories = [CheckCategories.IAM]
        super().__init__(
            name=name,
            id=id,
            categories=categories,
            supported_resources=supported_resources,
        )
    
    def scan_resource_conf(self, conf: dict) -> CheckResult:
        """Check if RoleName is set (static name)."""
        properties = conf.get("Properties", {})
        if not properties:
            return CheckResult.PASSED
        
        role_name = properties.get("RoleName")
        
        # No RoleName set = CloudFormation will generate unique name = PASSED
        if not role_name:
            return CheckResult.PASSED
        
        # If RoleName uses CloudFormation intrinsic functions, it's dynamic = PASSED
        if isinstance(role_name, dict):
            # Fn::Sub, Fn::Join, !Ref etc. are dynamic
            return CheckResult.PASSED
        
        # Static string name = FAILED (may prevent safe updates)
        # Note: This is intentional in many cases for cross-stack references
        return CheckResult.FAILED


# =============================================================================
# CKV_CUSTOM_IAM_4: Limit AWS Managed Policies Per Role
# =============================================================================
class IamRoleLimitManagedPolicies(BaseResourceCheck):
    """
    Ensure IAM Role has at most 3 AWS managed policies attached.
    
    AWS managed policies are convenient but often grant more permissions than
    needed. Limiting their count encourages use of least-privilege inline
    policies.
    
    Threshold: ≤3 AWS managed policies per role
    Note: ECS EC2 instance roles typically need 3 (ECS, SSM, CloudWatch).
    """
    
    MAX_MANAGED_POLICIES = 3
    
    def __init__(self) -> None:
        name = f"Ensure IAM Role has at most {self.MAX_MANAGED_POLICIES} AWS managed policies"
        id = "CKV_CUSTOM_IAM_4"
        supported_resources = ["AWS::IAM::Role"]
        categories = [CheckCategories.IAM]
        super().__init__(
            name=name,
            id=id,
            categories=categories,
            supported_resources=supported_resources,
        )
    
    def scan_resource_conf(self, conf: dict) -> CheckResult:
        """Count AWS managed policies attached to the role."""
        properties = conf.get("Properties", {})
        if not properties:
            return CheckResult.PASSED
        
        managed_policies = properties.get("ManagedPolicyArns", [])
        if not isinstance(managed_policies, list):
            managed_policies = [managed_policies]
        
        # Count only AWS managed policies (arn:aws:iam::aws:policy/...)
        aws_managed_count = 0
        for policy_arn in managed_policies:
            if not isinstance(policy_arn, str):
                continue
            if policy_arn.startswith("arn:aws:iam::aws:policy/"):
                aws_managed_count += 1
        
        if aws_managed_count <= self.MAX_MANAGED_POLICIES:
            return CheckResult.PASSED
        
        return CheckResult.FAILED


# =============================================================================
# CKV_CUSTOM_IAM_5: Role Has At Least One Policy
# =============================================================================
class IamRoleHasPolicy(BaseResourceCheck):
    """
    Ensure IAM Role has at least one policy attached (not empty).
    
    Roles without any policies are likely incomplete or misconfigured.
    While an empty role isn't a security risk, it may indicate missing
    permissions that will cause runtime failures.
    
    Exception: Task roles in ECS may start empty and have permissions added
    later via grantXxx() methods. This check serves as a reminder to verify
    the role is intentionally empty.
    """
    
    def __init__(self) -> None:
        name = "Ensure IAM Role has at least one policy attached (not empty)"
        id = "CKV_CUSTOM_IAM_5"
        supported_resources = ["AWS::IAM::Role"]
        categories = [CheckCategories.IAM]
        super().__init__(
            name=name,
            id=id,
            categories=categories,
            supported_resources=supported_resources,
        )
    
    def scan_resource_conf(self, conf: dict) -> CheckResult:
        """Check if the role has any policies attached."""
        properties = conf.get("Properties", {})
        if not properties:
            return CheckResult.FAILED
        
        # Check for managed policies
        managed_policies = properties.get("ManagedPolicyArns", [])
        if managed_policies and len(managed_policies) > 0:
            return CheckResult.PASSED
        
        # Check for inline policies
        policies = properties.get("Policies", [])
        if policies and len(policies) > 0:
            return CheckResult.PASSED
        
        # No policies attached = FAILED (likely incomplete)
        return CheckResult.FAILED


# =============================================================================
# Register all checks
# =============================================================================
check1 = IamRoleHasPermissionsBoundary()
check2 = IamPolicyNoHardcodedAccountIds()
check3 = IamRoleNoStaticName()
check4 = IamRoleLimitManagedPolicies()
check5 = IamRoleHasPolicy()
