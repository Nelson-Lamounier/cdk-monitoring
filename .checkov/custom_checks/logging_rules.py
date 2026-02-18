"""
Custom Checkov Rules for CloudWatch Log Group Security

CKV_CUSTOM_VPC_1: Ensure CloudWatch Log Group is encrypted with KMS
CKV_CUSTOM_VPC_2: Ensure CloudWatch Log Group retention is >= 90 days
CKV_CUSTOM_VPC_3: Ensure CloudWatch Log Group has DeletionPolicy Retain

Note: IDs use VPC_ prefix for historical reasons (originally written for
VPC flow log groups). IDs are preserved for backwards compatibility.
"""

from checkov.cloudformation.checks.resource.base_resource_check import (
    BaseResourceCheck,
)
from checkov.common.models.enums import CheckCategories, CheckResult

MINIMUM_RETENTION_DAYS = 90


# =============================================================================
# CKV_CUSTOM_VPC_1: Log Group KMS Encryption
# =============================================================================
class LogGroupKmsEncryption(BaseResourceCheck):
    """
    Ensure CloudWatch Log Group is encrypted with a customer-managed KMS key.

    Without KmsKeyId, logs are encrypted with AWS-managed keys only,
    which doesn't satisfy most production compliance requirements (SOC 2, ISO 27001).
    """

    def __init__(self):
        name = "Ensure CloudWatch Log Group is encrypted with KMS"
        id = "CKV_CUSTOM_VPC_1"
        supported_resources = ["AWS::Logs::LogGroup"]
        categories = [CheckCategories.ENCRYPTION]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        properties = conf.get("Properties", {})
        if properties is None:
            return CheckResult.FAILED

        kms_key_id = properties.get("KmsKeyId")
        if kms_key_id and kms_key_id not in [None, "", {}]:
            return CheckResult.PASSED

        return CheckResult.FAILED


# =============================================================================
# CKV_CUSTOM_VPC_2: Log Group Retention >= 90 Days
# =============================================================================
class LogGroupRetentionProd(BaseResourceCheck):
    """
    Ensure CloudWatch Log Group retention is at least 90 days.

    Production environments must retain logs (especially VPC flow logs)
    for a minimum of 90 days for compliance (SOC 2, ISO 27001, PCI DSS).
    No retention set = logs kept forever (passes retention check).
    """

    def __init__(self):
        name = f"Ensure CloudWatch Log Group retention is >= {MINIMUM_RETENTION_DAYS} days"
        id = "CKV_CUSTOM_VPC_2"
        supported_resources = ["AWS::Logs::LogGroup"]
        categories = [CheckCategories.LOGGING]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        properties = conf.get("Properties", {})
        if properties is None:
            return CheckResult.FAILED

        retention = properties.get("RetentionInDays")
        if retention is None:
            return CheckResult.PASSED  # Logs kept forever

        try:
            retention_days = int(retention)
        except (ValueError, TypeError):
            return CheckResult.UNKNOWN

        if retention_days >= MINIMUM_RETENTION_DAYS:
            return CheckResult.PASSED

        return CheckResult.FAILED


# =============================================================================
# CKV_CUSTOM_VPC_3: Log Group DeletionPolicy Retain
# =============================================================================
class LogGroupDeletionPolicyRetain(BaseResourceCheck):
    """
    Ensure CloudWatch Log Group has DeletionPolicy set to Retain.

    Production audit logs must survive stack deletion to preserve
    the audit trail. CloudFormation defaults to 'Delete' if not specified.
    """

    def __init__(self):
        name = "Ensure CloudWatch Log Group has DeletionPolicy Retain"
        id = "CKV_CUSTOM_VPC_3"
        supported_resources = ["AWS::Logs::LogGroup"]
        categories = [CheckCategories.BACKUP_AND_RECOVERY]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        deletion_policy = conf.get("DeletionPolicy", "Delete")
        update_replace_policy = conf.get("UpdateReplacePolicy", "Delete")

        if deletion_policy == "Retain" and update_replace_policy == "Retain":
            return CheckResult.PASSED

        return CheckResult.FAILED


# =============================================================================
# Register all checks
# =============================================================================
check_log_kms = LogGroupKmsEncryption()
check_log_retention = LogGroupRetentionProd()
check_log_deletion = LogGroupDeletionPolicyRetain()
