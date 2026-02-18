"""
Custom Checkov Rule: CKV_CUSTOM_SQS_1
Ensure SQS queues have SSL/TLS encryption enabled.

SQS queues used as DLQs must enforce SSL to protect data in transit.
CDK's `enforceSSL: true` creates a QueuePolicy denying non-SSL requests.

Note: This check validates QueuePolicy resources, not Queue resources,
since CDK implements SSL enforcement via policy statements.
"""

from checkov.cloudformation.checks.resource.base_resource_check import (
    BaseResourceCheck,
)
from checkov.common.models.enums import CheckCategories, CheckResult


class SqsQueuePolicyEnforcesSSL(BaseResourceCheck):
    def __init__(self):
        name = "Ensure SQS queue policy enforces SSL (aws:SecureTransport)"
        id = "CKV_CUSTOM_SQS_1"
        supported_resources = ["AWS::SQS::QueuePolicy"]
        categories = [CheckCategories.ENCRYPTION]
        super().__init__(
            name=name,
            id=id,
            categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        """
        Checks that the SQS QueuePolicy has a statement denying non-SSL requests.
        CDK's enforceSSL generates:
          Effect: Deny
          Condition: { Bool: { "aws:SecureTransport": "false" } }
        """
        properties = conf.get("Properties", {})
        if properties is None:
            return CheckResult.FAILED

        policy_doc = properties.get("PolicyDocument", {})
        if not policy_doc:
            return CheckResult.FAILED

        statements = policy_doc.get("Statement", [])
        
        for statement in statements:
            if not isinstance(statement, dict):
                continue
            
            # Look for Deny effect with SecureTransport condition
            if statement.get("Effect") != "Deny":
                continue
            
            conditions = statement.get("Condition", {})
            bool_conditions = conditions.get("Bool", {})
            
            # CDK uses "aws:SecureTransport": "false" to deny non-SSL
            secure_transport = bool_conditions.get("aws:SecureTransport")
            if secure_transport == "false":
                return CheckResult.PASSED

        return CheckResult.FAILED


check = SqsQueuePolicyEnforcesSSL()
