"""
Custom Checkov Rules for EBS Volume Security

CKV_CUSTOM_EBS_1: Ensure EBS volume is encrypted with a customer-managed KMS key
CKV_CUSTOM_EBS_2: Ensure monitoring EBS volumes are >= 50 GB for production
CKV_CUSTOM_EBS_3: Ensure EBS data volumes have automated snapshot/backup strategy
"""

from checkov.cloudformation.checks.resource.base_resource_check import (
    BaseResourceCheck,
)
from checkov.common.models.enums import CheckCategories, CheckResult

MINIMUM_PROD_SIZE_GB = 50


# =============================================================================
# CKV_CUSTOM_EBS_1: Customer-Managed KMS Key
# =============================================================================
class EbsCustomerManagedKms(BaseResourceCheck):
    """
    Ensure EBS volumes are encrypted with a customer-managed KMS key (CMK).

    Without KmsKeyId, AWS uses the default aws/ebs managed key. This is
    acceptable for dev but NOT for production because:
    - AWS-managed keys cannot have custom key policies
    - You cannot control key rotation schedule
    - You cannot grant cross-account access for DR/backup
    - Compliance frameworks (SOC 2, ISO 27001) typically require CMKs
    """

    def __init__(self):
        name = "Ensure EBS volume is encrypted with a customer-managed KMS key (not AWS-managed)"
        id = "CKV_CUSTOM_EBS_1"
        supported_resources = ["AWS::EC2::Volume"]
        categories = [CheckCategories.ENCRYPTION]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        properties = conf.get("Properties", {})
        if not properties:
            return CheckResult.FAILED

        encrypted = properties.get("Encrypted", False)
        if not encrypted:
            return CheckResult.FAILED

        kms_key_id = properties.get("KmsKeyId")
        if kms_key_id and kms_key_id not in [None, "", {}]:
            return CheckResult.PASSED

        return CheckResult.FAILED


# =============================================================================
# CKV_CUSTOM_EBS_2: Monitoring Volume Size Minimum
# =============================================================================
class EbsMonitoringVolumeSize(BaseResourceCheck):
    """
    Ensure monitoring EBS volumes are >= 50 GB for production.

    Only applies to volumes tagged with 'monitoring', 'prometheus', or 'grafana'.
    At 30 GB, Prometheus TSDB fills in ~13 days at 1.5 GB/day growth.
    """

    def __init__(self):
        name = f"Ensure monitoring EBS volumes are >= {MINIMUM_PROD_SIZE_GB} GB for production"
        id = "CKV_CUSTOM_EBS_2"
        supported_resources = ["AWS::EC2::Volume"]
        categories = [CheckCategories.GENERAL_SECURITY]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        properties = conf.get("Properties", {})
        if not properties:
            return CheckResult.PASSED

        tags = properties.get("Tags", [])
        is_monitoring = False
        for tag in tags:
            if not isinstance(tag, dict):
                continue
            key = str(tag.get("Key", "")).lower()
            value = str(tag.get("Value", "")).lower()
            if key in ("application", "purpose", "project") and any(
                term in value for term in ("prometheus", "grafana", "monitoring")
            ):
                is_monitoring = True
                break

        if not is_monitoring:
            return CheckResult.PASSED

        size = properties.get("Size")
        try:
            size_gb = int(size)
        except (ValueError, TypeError):
            return CheckResult.UNKNOWN

        if size_gb >= MINIMUM_PROD_SIZE_GB:
            return CheckResult.PASSED

        return CheckResult.FAILED


# =============================================================================
# CKV_CUSTOM_EBS_3: Backup Strategy Reminder
# =============================================================================
class EbsBackupStrategy(BaseResourceCheck):
    """
    Ensure EBS data volumes have automated snapshot/backup strategy.

    Always flags FAILED to prompt verification that a backup strategy
    exists (may be in a separate stack). Suppress with documented reason
    if backups are handled externally.
    """

    def __init__(self):
        name = "Ensure EBS data volumes have automated snapshot/backup strategy"
        id = "CKV_CUSTOM_EBS_3"
        supported_resources = ["AWS::EC2::Volume"]
        categories = [CheckCategories.BACKUP_AND_RECOVERY]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        return CheckResult.FAILED


# =============================================================================
# Register all checks
# =============================================================================
check_ebs_cmk = EbsCustomerManagedKms()
check_ebs_size = EbsMonitoringVolumeSize()
check_ebs_backup = EbsBackupStrategy()
