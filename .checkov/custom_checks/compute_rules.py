"""
Custom Checkov Rules for EC2 Compute (UserData) Security

CKV_CUSTOM_COMPUTE_1: No hardcoded credentials in EC2 UserData
CKV_CUSTOM_COMPUTE_2: IMDSv2 token-based metadata calls in UserData
CKV_CUSTOM_COMPUTE_4: Docker containers bind ports to 127.0.0.1, not 0.0.0.0
"""

from __future__ import annotations

import re

from checkov.cloudformation.checks.resource.base_resource_check import (
    BaseResourceCheck,
)
from checkov.common.models.enums import CheckCategories, CheckResult


# =============================================================================
# Shared helper — previously copy-pasted in 3 files
# =============================================================================
def _extract_userdata_strings(userdata) -> list[str]:
    """Recursively extract string literals from CloudFormation UserData.

    Handles Fn::Base64, Fn::Sub, Fn::Join, and nested structures.
    """
    if isinstance(userdata, str):
        return [userdata]

    strings: list[str] = []
    if isinstance(userdata, dict):
        for key, value in userdata.items():
            if key in ("Fn::Base64", "Fn::Sub"):
                strings.extend(_extract_userdata_strings(value))
            elif key == "Fn::Join":
                if isinstance(value, list) and len(value) == 2:
                    items = value[1] if isinstance(value[1], list) else [value[1]]
                    for item in items:
                        strings.extend(_extract_userdata_strings(item))
            else:
                strings.extend(_extract_userdata_strings(value))
    elif isinstance(userdata, list):
        for item in userdata:
            strings.extend(_extract_userdata_strings(item))

    return strings


def _get_userdata_script(conf: dict) -> str | None:
    """Extract the full UserData script as a single string, or None if absent."""
    properties = conf.get("Properties", {})
    if not properties:
        return None
    userdata = properties.get("UserData")
    if not userdata:
        return None
    strings = _extract_userdata_strings(userdata)
    return "\n".join(strings)


# =============================================================================
# CKV_CUSTOM_COMPUTE_1: No Hardcoded Credentials
# =============================================================================
# Patterns that indicate hardcoded credentials
CREDENTIAL_PATTERNS = [
    re.compile(r"PASSWORD\s*=\s*['\"]?\w+['\"]?", re.IGNORECASE),
    re.compile(r"SECRET\s*=\s*['\"]?\w+['\"]?", re.IGNORECASE),
    re.compile(r"API_KEY\s*=\s*['\"]?\w+['\"]?", re.IGNORECASE),
    re.compile(r"TOKEN\s*=\s*['\"]?\w+['\"]?", re.IGNORECASE),
    re.compile(r"ADMIN_PASSWORD\s*=\s*['\"]?\w+['\"]?", re.IGNORECASE),
]

# False-positive exclusions (variable references, not hardcoded values)
FALSE_POSITIVE_PATTERNS = [
    re.compile(r"PASSWORD\s*=\s*\$", re.IGNORECASE),
    re.compile(r"PASSWORD\s*=\s*\{", re.IGNORECASE),
    re.compile(r"secretsmanager", re.IGNORECASE),
]


class NoHardcodedCredentialsInUserData(BaseResourceCheck):
    """Ensure EC2 UserData does not contain hardcoded credentials."""

    def __init__(self):
        name = "Ensure EC2 UserData does not contain hardcoded credentials"
        id = "CKV_CUSTOM_COMPUTE_1"
        supported_resources = ["AWS::EC2::Instance"]
        categories = [CheckCategories.GENERAL_SECURITY]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        full_script = _get_userdata_script(conf)
        if not full_script:
            return CheckResult.PASSED

        for pattern in CREDENTIAL_PATTERNS:
            matches = pattern.findall(full_script)
            for match in matches:
                is_false_positive = any(
                    fp.search(match) for fp in FALSE_POSITIVE_PATTERNS
                )
                if not is_false_positive:
                    return CheckResult.FAILED

        return CheckResult.PASSED


# =============================================================================
# CKV_CUSTOM_COMPUTE_2: IMDSv2 Required
# =============================================================================
# IMDSv1-style call (curl to metadata without token header)
IMDSV1_PATTERN = re.compile(
    r"curl\s+(?:(?!-H\s+[\"']X-aws-ec2-metadata-token).)*"
    r"http://169\.254\.169\.254/latest/meta-data",
    re.DOTALL,
)

# IMDSv2 token acquisition
IMDSV2_TOKEN_PATTERN = re.compile(
    r"curl\s+.*-X\s+PUT.*169\.254\.169\.254/latest/api/token",
    re.DOTALL,
)


class UserDataIMDSv2Required(BaseResourceCheck):
    """Ensure EC2 UserData uses IMDSv2 token-based metadata calls (not IMDSv1 curl)."""

    def __init__(self):
        name = "Ensure EC2 UserData uses IMDSv2 token-based metadata calls (not IMDSv1 curl)"
        id = "CKV_CUSTOM_COMPUTE_2"
        supported_resources = ["AWS::EC2::Instance"]
        categories = [CheckCategories.GENERAL_SECURITY]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        full_script = _get_userdata_script(conf)
        if not full_script:
            return CheckResult.PASSED

        if "169.254.169.254" not in full_script:
            return CheckResult.PASSED

        has_imdsv1_calls = bool(IMDSV1_PATTERN.search(full_script))
        has_imdsv2_token = bool(IMDSV2_TOKEN_PATTERN.search(full_script))

        if has_imdsv1_calls and not has_imdsv2_token:
            return CheckResult.FAILED

        return CheckResult.PASSED


# =============================================================================
# CKV_CUSTOM_COMPUTE_4: Docker Ports Bind Loopback
# =============================================================================
UNSAFE_PORT_BINDING = re.compile(r'["\'](\d+:\d+)["\']')
SAFE_PORT_BINDING = re.compile(r'["\']127\.0\.0\.1:\d+:\d+["\']')


class DockerPortsBindLoopback(BaseResourceCheck):
    """Ensure Docker containers bind ports to 127.0.0.1, not 0.0.0.0."""

    def __init__(self):
        name = "Ensure Docker containers bind ports to 127.0.0.1, not 0.0.0.0"
        id = "CKV_CUSTOM_COMPUTE_4"
        supported_resources = ["AWS::EC2::Instance"]
        categories = [CheckCategories.NETWORKING]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        full_script = _get_userdata_script(conf)
        if not full_script:
            return CheckResult.PASSED

        if "docker" not in full_script.lower():
            return CheckResult.PASSED

        if "ports:" not in full_script:
            return CheckResult.PASSED

        unsafe_bindings = UNSAFE_PORT_BINDING.findall(full_script)
        safe_bindings = SAFE_PORT_BINDING.findall(full_script)

        if unsafe_bindings and not safe_bindings:
            return CheckResult.FAILED

        if len(unsafe_bindings) > len(safe_bindings):
            return CheckResult.FAILED

        return CheckResult.PASSED


# =============================================================================
# Register all checks
# =============================================================================
check_no_creds = NoHardcodedCredentialsInUserData()
check_imdsv2 = UserDataIMDSv2Required()
check_docker_loopback = DockerPortsBindLoopback()
