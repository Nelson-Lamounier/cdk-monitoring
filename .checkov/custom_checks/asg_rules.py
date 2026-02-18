"""
Custom Checkov Rules for Auto Scaling Group Security

CKV_CUSTOM_ASG_1: ASG should use ELB health check (not EC2)
CKV_CUSTOM_ASG_2: ASG MinSize >= 2 for high availability
"""

from checkov.cloudformation.checks.resource.base_resource_check import (
    BaseResourceCheck,
)
from checkov.common.models.enums import CheckCategories, CheckResult


# =============================================================================
# CKV_CUSTOM_ASG_1: ASG ELB Health Check Type
# =============================================================================
class AsgElbHealthCheck(BaseResourceCheck):
    """
    Ensure ASG uses ELB health check instead of EC2.
    
    EC2 health checks only verify the instance is running at hypervisor level.
    If the application crashes, the instance remains "healthy". ELB health
    checks verify actual application health.
    
    Note: This only applies when the ASG is attached to a load balancer.
    """
    
    def __init__(self) -> None:
        name = "Ensure ASG uses ELB health check type when behind load balancer"
        id = "CKV_CUSTOM_ASG_1"
        supported_resources = ["AWS::AutoScaling::AutoScalingGroup"]
        categories = [CheckCategories.GENERAL_SECURITY]
        super().__init__(
            name=name,
            id=id,
            categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf) -> CheckResult:
        """
        Check that HealthCheckType is ELB when TargetGroupARNs or
        LoadBalancerNames are present.
        """
        properties = conf.get("Properties", {})
        if not properties:
            return CheckResult.PASSED  # No props = can't check
        
        # Check if ASG is attached to a load balancer
        target_groups = properties.get("TargetGroupARNs", [])
        load_balancers = properties.get("LoadBalancerNames", [])
        
        has_lb = bool(target_groups) or bool(load_balancers)
        
        if not has_lb:
            # Not behind a load balancer - EC2 health check is acceptable
            return CheckResult.PASSED
        
        # Must use ELB health check when behind LB
        health_check_type = properties.get("HealthCheckType", "EC2")
        
        if health_check_type == "ELB":
            return CheckResult.PASSED
        
        return CheckResult.FAILED


# =============================================================================
# CKV_CUSTOM_ASG_2: ASG MinSize >= 2 for High Availability
# =============================================================================
class AsgMinSizeHA(BaseResourceCheck):
    """
    Ensure ASG MinSize is at least 2 for high availability.
    
    MinSize: 1 means a single instance failure takes down the service
    until a replacement launches (several minutes).
    
    Note: This is a production recommendation. Dev environments may
    intentionally use MinSize: 1 for cost savings.
    """
    
    MINIMUM_MIN_SIZE = 2
    
    def __init__(self) -> None:
        name = f"Ensure ASG MinSize is at least {self.MINIMUM_MIN_SIZE} for HA"
        id = "CKV_CUSTOM_ASG_2"
        supported_resources = ["AWS::AutoScaling::AutoScalingGroup"]
        categories = [CheckCategories.GENERAL_SECURITY]
        super().__init__(
            name=name,
            id=id,
            categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf) -> CheckResult:
        """Check that MinSize is at least 2."""
        properties = conf.get("Properties", {})
        if not properties:
            return CheckResult.FAILED
        
        min_size = properties.get("MinSize")
        
        if min_size is None:
            return CheckResult.FAILED
        
        try:
            min_size_int = int(min_size)
        except (ValueError, TypeError):
            return CheckResult.UNKNOWN
        
        if min_size_int >= self.MINIMUM_MIN_SIZE:
            return CheckResult.PASSED
        
        return CheckResult.FAILED


# Register checks
check_asg_elb = AsgElbHealthCheck()
check_asg_min = AsgMinSizeHA()
