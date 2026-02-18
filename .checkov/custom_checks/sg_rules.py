"""
Custom Checkov Rules for Security Group Hardening

CKV_CUSTOM_SG_1: No SSH (port 22) ingress — use SSM Session Manager
CKV_CUSTOM_SG_2: No unrestricted egress (0.0.0.0/0 all protocols)
CKV_CUSTOM_SG_3: No full port range (0-65535) ingress
CKV_CUSTOM_SG_4: No external CIDR access to metrics ports (9090, 9100)
CKV_CUSTOM_SG_5: No external CIDR access to Grafana (3000)
"""

from checkov.cloudformation.checks.resource.base_resource_check import (
    BaseResourceCheck,
)
from checkov.common.models.enums import CheckCategories, CheckResult

# Maximum acceptable port range span
MAX_PORT_RANGE = 1000

# Ports that must never be exposed to external CIDRs
INTERNAL_ONLY_PORTS = {
    3000,  # Grafana — use SSM port forwarding
    9090,  # Prometheus — internal scraping only
    9100,  # Node Exporter — internal scraping only
}


def _has_external_cidr(rule: dict) -> bool:
    """Return True if the rule uses a CIDR source (external), not SG-to-SG."""
    cidr = rule.get("CidrIp", "")
    cidr_ipv6 = rule.get("CidrIpv6", "")
    has_sg = bool(
        rule.get("SourceSecurityGroupId")
        or rule.get("SourceSecurityGroupName")
    )
    return bool(cidr or cidr_ipv6) and not has_sg


def _parse_ports(rule: dict) -> tuple:
    """Return (from_port, to_port) as ints, or (None, None) on failure."""
    from_port = rule.get("FromPort")
    to_port = rule.get("ToPort")
    try:
        return (
            int(from_port) if from_port is not None else None,
            int(to_port) if to_port is not None else None,
        )
    except (ValueError, TypeError):
        return None, None


# =============================================================================
# CKV_CUSTOM_SG_1: No SSH Ingress
# =============================================================================
class SecurityGroupNoSSH(BaseResourceCheck):
    """Ensure security groups do not allow SSH ingress (use SSM Session Manager)."""

    def __init__(self):
        name = "Ensure security groups do not allow SSH ingress (use SSM Session Manager)"
        id = "CKV_CUSTOM_SG_1"
        supported_resources = ["AWS::EC2::SecurityGroup"]
        categories = [CheckCategories.NETWORKING]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        properties = conf.get("Properties", {})
        if not properties:
            return CheckResult.PASSED

        for rule in properties.get("SecurityGroupIngress", []):
            if not isinstance(rule, dict):
                continue
            from_port, to_port = _parse_ports(rule)
            if from_port is not None and to_port is not None and from_port <= 22 <= to_port:
                return CheckResult.FAILED

        return CheckResult.PASSED


# =============================================================================
# CKV_CUSTOM_SG_2: Restricted Egress
# =============================================================================
class SecurityGroupRestrictedEgress(BaseResourceCheck):
    """Ensure security groups do not allow unrestricted egress to 0.0.0.0/0 on all protocols."""

    def __init__(self):
        name = "Ensure security groups do not allow unrestricted egress to 0.0.0.0/0 on all protocols"
        id = "CKV_CUSTOM_SG_2"
        supported_resources = ["AWS::EC2::SecurityGroup"]
        categories = [CheckCategories.NETWORKING]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        properties = conf.get("Properties", {})
        if not properties:
            return CheckResult.PASSED

        for rule in properties.get("SecurityGroupEgress", []):
            if not isinstance(rule, dict):
                continue
            cidr = rule.get("CidrIp", "")
            cidr_ipv6 = rule.get("CidrIpv6", "")
            protocol = str(rule.get("IpProtocol", ""))

            is_all_destinations = cidr in ("0.0.0.0/0",) or cidr_ipv6 in ("::/0",)
            is_all_protocols = protocol in ("-1", "-1.0")

            if is_all_destinations and is_all_protocols:
                return CheckResult.FAILED

        return CheckResult.PASSED


# =============================================================================
# CKV_CUSTOM_SG_3: No Full Port Range
# =============================================================================
class SecurityGroupNoFullPortRange(BaseResourceCheck):
    """Ensure security group ingress rules do not allow full port ranges (0-65535)."""

    def __init__(self):
        name = "Ensure security group ingress rules do not allow full port ranges (0-65535)"
        id = "CKV_CUSTOM_SG_3"
        supported_resources = [
            "AWS::EC2::SecurityGroup",
            "AWS::EC2::SecurityGroupIngress",
        ]
        categories = [CheckCategories.NETWORKING]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        resource_type = conf.get("Type", "")
        properties = conf.get("Properties", {})
        if not properties:
            return CheckResult.PASSED

        # Standalone SecurityGroupIngress resources
        if resource_type == "AWS::EC2::SecurityGroupIngress":
            return self._check_rule(properties)

        # Inline ingress rules on SecurityGroup
        for rule in properties.get("SecurityGroupIngress", []):
            if self._check_rule(rule) == CheckResult.FAILED:
                return CheckResult.FAILED

        return CheckResult.PASSED

    def _check_rule(self, rule):
        if not isinstance(rule, dict):
            return CheckResult.PASSED
        from_port, to_port = _parse_ports(rule)
        if from_port is not None and to_port is not None and (to_port - from_port) >= MAX_PORT_RANGE:
            return CheckResult.FAILED
        return CheckResult.PASSED


# =============================================================================
# CKV_CUSTOM_SG_4: No External Metrics Ports
# =============================================================================
class SecurityGroupNoExternalMetricsPorts(BaseResourceCheck):
    """Ensure metrics ports (9100, 9090) are not exposed to external CIDRs."""

    def __init__(self):
        name = "Ensure metrics ports (9100, 9090) are not exposed to external CIDRs"
        id = "CKV_CUSTOM_SG_4"
        supported_resources = ["AWS::EC2::SecurityGroup"]
        categories = [CheckCategories.NETWORKING]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        properties = conf.get("Properties", {})
        if not properties:
            return CheckResult.PASSED

        for rule in properties.get("SecurityGroupIngress", []):
            if not isinstance(rule, dict) or not _has_external_cidr(rule):
                continue
            from_port, to_port = _parse_ports(rule)
            if from_port is None or to_port is None:
                continue
            for port in (9090, 9100):
                if from_port <= port <= to_port:
                    return CheckResult.FAILED

        return CheckResult.PASSED


# =============================================================================
# CKV_CUSTOM_SG_5: No Direct Grafana
# =============================================================================
class SecurityGroupNoDirectGrafana(BaseResourceCheck):
    """Ensure Grafana (port 3000) is not directly exposed to external CIDRs (use SSM port forwarding)."""

    def __init__(self):
        name = "Ensure Grafana (port 3000) is not directly exposed to external CIDRs (use SSM port forwarding)"
        id = "CKV_CUSTOM_SG_5"
        supported_resources = ["AWS::EC2::SecurityGroup"]
        categories = [CheckCategories.NETWORKING]
        super().__init__(
            name=name, id=id, categories=categories,
            supported_resources=supported_resources,
        )

    def scan_resource_conf(self, conf):
        properties = conf.get("Properties", {})
        if not properties:
            return CheckResult.PASSED

        for rule in properties.get("SecurityGroupIngress", []):
            if not isinstance(rule, dict) or not _has_external_cidr(rule):
                continue
            from_port, to_port = _parse_ports(rule)
            if from_port is None or to_port is None:
                continue
            if from_port <= 3000 <= to_port:
                return CheckResult.FAILED

        return CheckResult.PASSED


# =============================================================================
# Register all checks
# =============================================================================
check_sg_no_ssh = SecurityGroupNoSSH()
check_sg_egress = SecurityGroupRestrictedEgress()
check_sg_port_range = SecurityGroupNoFullPortRange()
check_sg_metrics = SecurityGroupNoExternalMetricsPorts()
check_sg_grafana = SecurityGroupNoDirectGrafana()
