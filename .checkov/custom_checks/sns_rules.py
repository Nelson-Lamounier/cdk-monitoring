"""
Custom Checkov Rules for SNS Topic Security

CKV_CUSTOM_SNS_1: SNS topic encryption at rest
CKV_CUSTOM_SNS_2: SNS SSL enforcement (deny non-secure transport)
"""

from checkov.cloudformation.checks.resource.base_resource_check import (
    BaseResourceCheck,
)
from checkov.common.models.enums import CheckCategories, CheckResult


# =============================================================================
# CKV_CUSTOM_SNS_1: SNS Topic Encryption at Rest
# =============================================================================
class SnsTopicEncryption(BaseResourceCheck):
    """
    Ensure SNS topic is encrypted with KMS.
    
    SNS topics containing infrastructure metadata (instance IDs, cluster ARNs,
    scaling events) should be encrypted at rest.
    """
    
    def __init__(self) -> None:
        name = "Ensure SNS topic is encrypted with KMS"
        id = "CKV_CUSTOM_SNS_1"
        supported_resources = ["AWS::SNS::Topic"]
        categories = [CheckCategories.ENCRYPTION]
        super().__init__(
            name=name,
            id=id,
            categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf) -> CheckResult:
        """Check that KmsMasterKeyId is set."""
        properties = conf.get("Properties", {})
        if not properties:
            return CheckResult.FAILED
        
        kms_key = properties.get("KmsMasterKeyId")
        
        if kms_key and kms_key not in [None, "", {}]:
            return CheckResult.PASSED
        
        return CheckResult.FAILED


# =============================================================================
# CKV_CUSTOM_SNS_2: SNS SSL Enforcement via Topic Policy
# =============================================================================
class SnsSslEnforcement(BaseResourceCheck):
    """
    Ensure SNS topic has SSL enforcement policy.
    
    Topic policy should deny publish actions when aws:SecureTransport is false.
    This prevents messages from being sent over unencrypted HTTP.
    
    Note: This check looks for AWS::SNS::TopicPolicy resources that reference
    the topic and contain the required deny statement.
    """
    
    def __init__(self) -> None:
        name = "Ensure SNS topic policy denies non-SSL transport"
        id = "CKV_CUSTOM_SNS_2"
        supported_resources = ["AWS::SNS::TopicPolicy"]
        categories = [CheckCategories.ENCRYPTION]
        super().__init__(
            name=name,
            id=id,
            categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf) -> CheckResult:
        """
        Check that the topic policy contains a Deny statement for
        non-SSL transport (aws:SecureTransport = false).
        """
        properties = conf.get("Properties", {})
        if not properties:
            return CheckResult.FAILED
        
        policy_document = properties.get("PolicyDocument", {})
        statements = policy_document.get("Statement", [])
        
        if not isinstance(statements, list):
            statements = [statements]
        
        for statement in statements:
            if not isinstance(statement, dict):
                continue
            
            effect = statement.get("Effect", "")
            if effect != "Deny":
                continue
            
            # Check for SecureTransport condition
            conditions = statement.get("Condition", {})
            bool_conditions = conditions.get("Bool", {})
            
            secure_transport = bool_conditions.get("aws:SecureTransport")
            if secure_transport in ["false", False]:
                return CheckResult.PASSED
        
        return CheckResult.FAILED


# Register checks
check_sns_encryption = SnsTopicEncryption()
check_sns_ssl = SnsSslEnforcement()
