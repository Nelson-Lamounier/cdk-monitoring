"""
Custom Checkov Rules for Lambda Function Security

CKV_CUSTOM_LAMBDA_1: Ensure Lambda has reserved concurrent executions configured
CKV_CUSTOM_LAMBDA_2: Ensure Lambda has Dead Letter Queue configured
"""

from checkov.cloudformation.checks.resource.base_resource_check import (
    BaseResourceCheck,
)
from checkov.common.models.enums import CheckCategories, CheckResult


# =============================================================================
# CKV_CUSTOM_LAMBDA_1: Reserved Concurrency
# =============================================================================
class LambdaReservedConcurrency(BaseResourceCheck):
    """
    Ensure Lambda functions have reserved concurrent executions configured.

    Prevents Lambda from consuming all account-level concurrency.
    Critical for functions that must prevent race conditions
    (e.g., EBS detach Lambda should only run one invocation at a time).
    """

    def __init__(self):
        name = "Ensure Lambda function has reserved concurrent executions configured"
        id = "CKV_CUSTOM_LAMBDA_1"
        supported_resources = ["AWS::Lambda::Function"]
        categories = [CheckCategories.GENERAL_SECURITY]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        properties = conf.get("Properties", {})
        if properties is None:
            return CheckResult.FAILED

        reserved = properties.get("ReservedConcurrentExecutions")
        if reserved is not None:
            return CheckResult.PASSED

        return CheckResult.FAILED


# =============================================================================
# CKV_CUSTOM_LAMBDA_2: Dead Letter Queue
# =============================================================================
class LambdaDlqConfigured(BaseResourceCheck):
    """
    Ensure Lambda functions have a Dead Letter Queue configured.

    Lambda functions processing async events should have a DLQ to catch
    failed invocations that exceed retry limits. Without a DLQ, failed
    events are silently dropped.
    """

    def __init__(self):
        name = "Ensure Lambda function has Dead Letter Queue configured"
        id = "CKV_CUSTOM_LAMBDA_2"
        supported_resources = ["AWS::Lambda::Function"]
        categories = [CheckCategories.BACKUP_AND_RECOVERY]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        properties = conf.get("Properties", {})
        if properties is None:
            return CheckResult.FAILED

        dlq_config = properties.get("DeadLetterConfig", {})
        if not dlq_config:
            return CheckResult.FAILED

        target_arn = dlq_config.get("TargetArn")
        if target_arn and target_arn not in [None, "", {}]:
            return CheckResult.PASSED

        return CheckResult.FAILED


# =============================================================================
# Register all checks
# =============================================================================
check_reserved = LambdaReservedConcurrency()
check_dlq = LambdaDlqConfigured()
