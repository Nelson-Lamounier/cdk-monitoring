"""
Custom Checkov Checks for cdk-monitoring

Organization-specific Checkov rules grouped by domain:

Domain-grouped files:
- sg_rules.py      — 5 Security Group checks (SG_1–SG_5)
- logging_rules.py — 3 CloudWatch Log Group checks (VPC_1–VPC_3)
- ebs_rules.py     — 3 EBS Volume checks (EBS_1–EBS_3)
- compute_rules.py — 3 EC2 UserData checks (COMPUTE_1, COMPUTE_2, COMPUTE_4)
- vpc_rules.py     — 2 VPC/Subnet checks (VPC_5, VPC_6)
- lambda_rules.py  — 2 Lambda checks (LAMBDA_1, LAMBDA_2)
- iam_rules.py     — 5 IAM checks (IAM_1–IAM_5)
- kms_rules.py     — 2 KMS checks (KMS_1, KMS_2)
- asg_rules.py     — 2 ASG checks (ASG_1, ASG_2)
- sns_rules.py     — 2 SNS checks (SNS_1, SNS_2)
- sqs_ssl_enabled.py — 1 SQS check (SQS_1)

Total: 30 custom checks across 11 files.

Each check is auto-registered by Checkov — no explicit imports needed.
"""

# Checkov auto-discovers check classes when scanning the directory
# No explicit imports needed here - each file registers its own check
