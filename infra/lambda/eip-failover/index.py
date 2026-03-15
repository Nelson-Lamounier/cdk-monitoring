"""
DEPRECATED — Replaced by NLB health-check failover (see base-stack.ts).
The NLB distributes traffic to healthy targets automatically via TCP
health checks. The EIP is now attached to the NLB via SubnetMapping.
This file is kept for reference only.

EIP Failover Handler — Hybrid-HA Guardian

Automatically re-associates the cluster Elastic IP when an ASG
instance is launched or terminated.

Event handling:
  LAUNCH:    If EIP is unassociated or current holder is not running,
             associate EIP to the newly launched instance (if eligible).
  TERMINATE: If EIP was on the terminated instance, find another
             healthy eligible instance and move it.

Eligibility:
  Only instances with a matching bootstrap role (e.g., control-plane,
  mon-worker) are considered for EIP association. This prevents the EIP
  from landing on app-workers that lack the ingress security group.

Discovers healthy instances by EC2 tag (works across all ASGs).
"""

import logging
import os

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)
ec2 = boto3.client("ec2")

EIP_ALLOCATION_ID = os.environ["EIP_ALLOCATION_ID"]
ELIGIBLE_ROLES = os.environ["ELIGIBLE_ROLES"].split(",")


def is_running(instance_id):
    """Check if an instance is in 'running' state."""
    try:
        resp = ec2.describe_instances(InstanceIds=[instance_id])
        state = resp["Reservations"][0]["Instances"][0]["State"]["Name"]
        return state == "running"
    except Exception:
        return False


def find_healthy_candidates(exclude_id=""):
    """Find running instances with an eligible bootstrap role."""
    resp = ec2.describe_instances(Filters=[
        {"Name": "tag:k8s:bootstrap-role", "Values": ELIGIBLE_ROLES},
        {"Name": "instance-state-name", "Values": ["running"]},
    ])
    return [
        i["InstanceId"]
        for r in resp["Reservations"]
        for i in r["Instances"]
        if i["InstanceId"] != exclude_id
    ]


def is_eligible(instance_id):
    """Check if instance has an eligible bootstrap role (defense-in-depth)."""
    try:
        resp = ec2.describe_instances(InstanceIds=[instance_id])
        tags = resp["Reservations"][0]["Instances"][0].get("Tags", [])
        role = next((t["Value"] for t in tags if t["Key"] == "k8s:bootstrap-role"), "")
        return role in ELIGIBLE_ROLES
    except Exception:
        return False


def associate_eip(target_id, eip_info):
    """Disassociate (if needed) and associate EIP to target instance."""
    if eip_info.get("AssociationId"):
        ec2.disassociate_address(AssociationId=eip_info["AssociationId"])
        logger.info("Disassociated EIP from previous holder")
    ec2.associate_address(
        AllocationId=EIP_ALLOCATION_ID,
        InstanceId=target_id,
        AllowReassociation=True,
    )
    logger.info("EIP associated to %s", target_id)


def handler(event, context):
    """Handle ASG launch/terminate events and manage EIP association."""
    detail_type = event.get("detail-type", "")
    instance_id = event.get("detail", {}).get("EC2InstanceId", "")
    logger.info("Event: %s | Instance: %s | Eligible roles: %s", detail_type, instance_id, ELIGIBLE_ROLES)

    eip = ec2.describe_addresses(AllocationIds=[EIP_ALLOCATION_ID])["Addresses"][0]
    current_holder = eip.get("InstanceId", "")

    # ── LAUNCH EVENT ─────────────────────────────────────────────────
    if "Launch" in detail_type:
        # Only associate to instances with an eligible bootstrap role
        if not is_eligible(instance_id):
            logger.info(
                "Instance %s is not eligible (roles: %s) — skipping",
                instance_id, ELIGIBLE_ROLES,
            )
            return {"statusCode": 200}

        if not current_holder:
            logger.info("EIP unassociated — assigning to new instance %s", instance_id)
            associate_eip(instance_id, eip)
            return {"statusCode": 200}

        if not is_running(current_holder):
            logger.info("EIP holder %s is not running — moving to %s", current_holder, instance_id)
            associate_eip(instance_id, eip)
            return {"statusCode": 200}

        logger.info("EIP on %s (running). No action needed.", current_holder)
        return {"statusCode": 200}

    # ── TERMINATE EVENT ──────────────────────────────────────────────
    if current_holder and current_holder != instance_id:
        if is_running(current_holder):
            logger.info("EIP on %s (running, not terminated). No action.", current_holder)
            return {"statusCode": 200}

    # EIP was on the terminated instance or holder is unhealthy — failover
    candidates = find_healthy_candidates(exclude_id=instance_id)
    if not candidates:
        logger.error("No healthy eligible instances for EIP failover")
        return {"statusCode": 503}

    associate_eip(candidates[0], eip)
    logger.info("EIP failed over to %s", candidates[0])
    return {"statusCode": 200}
