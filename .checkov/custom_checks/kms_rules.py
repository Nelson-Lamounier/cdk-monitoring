"""
Custom Checkov Rules for KMS Key Security

CKV_CUSTOM_KMS_1: No kms:* wildcard in key policy
CKV_CUSTOM_KMS_2: KMS DeletionPolicy should be Retain for production
"""

from checkov.cloudformation.checks.resource.base_resource_check import (
    BaseResourceCheck,
)
from checkov.common.models.enums import CheckCategories, CheckResult
import json


# =============================================================================
# CKV_CUSTOM_KMS_1: No kms:* Wildcard in Key Policy
# =============================================================================
class KmsNoWildcardActions(BaseResourceCheck):
    """
    Ensure KMS key policy does not use kms:* wildcard action.
    
    Using kms:* grants full administrative access including key deletion,
    disabling, and granting access to external accounts. Use enumerated
    actions for least-privilege.
    """
    
    def __init__(self) -> None:
        name = "Ensure KMS key policy does not use kms:* wildcard action"
        id = "CKV_CUSTOM_KMS_1"
        supported_resources = ["AWS::KMS::Key"]
        categories = [CheckCategories.IAM]
        super().__init__(
            name=name,
            id=id,
            categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf) -> CheckResult:
        """Check that key policy doesn't contain kms:* action."""
        properties = conf.get("Properties", {})
        if not properties:
            return CheckResult.PASSED  # No policy = AWS default (OK)
        
        key_policy = properties.get("KeyPolicy")
        if not key_policy:
            return CheckResult.PASSED  # No policy = AWS default (OK)
        
        # Handle both dict and string policies
        if isinstance(key_policy, str):
            try:
                key_policy = json.loads(key_policy)
            except json.JSONDecodeError:
                return CheckResult.UNKNOWN
        
        statements = key_policy.get("Statement", [])
        if not isinstance(statements, list):
            statements = [statements]
        
        for statement in statements:
            if not isinstance(statement, dict):
                continue
            
            effect = statement.get("Effect", "")
            if effect != "Allow":
                continue
            
            actions = statement.get("Action", [])
            if isinstance(actions, str):
                actions = [actions]
            
            for action in actions:
                if action == "kms:*":
                    return CheckResult.FAILED
        
        return CheckResult.PASSED


# =============================================================================
# CKV_CUSTOM_KMS_2: KMS Key DeletionPolicy = Retain
# =============================================================================
class KmsDeletionPolicyRetain(BaseResourceCheck):
    """
    Ensure KMS key has DeletionPolicy set to Retain.
    
    Deleting a KMS key makes all data encrypted with it permanently
    unrecoverable. Production keys must use Retain policy.
    """
    
    def __init__(self) -> None:
        name = "Ensure KMS key has DeletionPolicy Retain"
        id = "CKV_CUSTOM_KMS_2"
        supported_resources = ["AWS::KMS::Key"]
        categories = [CheckCategories.BACKUP_AND_RECOVERY]
        super().__init__(
            name=name,
            id=id,
            categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf) -> CheckResult:
        """Check that DeletionPolicy is Retain."""
        deletion_policy = conf.get("DeletionPolicy")
        update_replace_policy = conf.get("UpdateReplacePolicy")
        
        # Both should be Retain for production safety
        if deletion_policy == "Retain" and update_replace_policy == "Retain":
            return CheckResult.PASSED
        
        # At minimum, DeletionPolicy must be Retain
        if deletion_policy == "Retain":
            return CheckResult.PASSED
        
        return CheckResult.FAILED


# Register checks
check_kms_wildcard = KmsNoWildcardActions()
check_kms_deletion = KmsDeletionPolicyRetain()
