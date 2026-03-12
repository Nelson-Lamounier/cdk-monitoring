#!/bin/bash

# Assign arguments to variables, using defaults if left blank
REGION=${1:-eu-west-1}
PROFILE=${2:-dev-account}

echo "=========================================="
echo "Checking EC2 Security Groups"
echo "Region:  $REGION"
echo "Profile: $PROFILE"
echo "=========================================="

aws ec2 describe-instances \
  --region "$REGION" \
  --filters "Name=tag:Name,Values=ControlPlane-development/LaunchTemplate/LaunchTemplate" \
  --query 'Reservations[].Instances[].[Tags[?Key==`Name`].Value|[0], InstanceId, SecurityGroups[]]' \
  --profile "$PROFILE" \
  --output yaml

aws ec2 describe-instances \
  --region "$REGION" \
  --query 'Reservations[].Instances[].SecurityGroups[].GroupId' \
  --profile "$PROFILE" \
  --output text | tr '\t' '\n' | sort -u | while read sg; do
    echo "=== $sg ==="
    aws ec2 describe-security-groups \
      --region "$REGION" \
      --group-ids "$sg" \
      --query 'SecurityGroups[].{Name:GroupName, InboundRules:IpPermissions}' \
      --profile "$PROFILE" \
      --output yaml

done
