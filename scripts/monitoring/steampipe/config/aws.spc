# =============================================================================
# Steampipe AWS Plugin Configuration
# Multi-account governance via cross-account IAM roles
# =============================================================================
#
# Architecture:
#   The monitoring EC2 instance role is the source credential.
#   Each target account has a SteampipeReadOnly IAM role that trusts
#   the monitoring account. Steampipe assumes each role to query resources.
#
# Adding a new account:
#   1. Deploy SteampipeReadOnly IAM role to the target account
#   2. Add a new connection block below
#   3. Add the connection name to the "aws_all" aggregator
#   4. Restart Steampipe: docker restart steampipe
# =============================================================================

# ---------------------------------------------------------------------------
# Aggregator — queries all accounts in a single SQL statement
# SELECT * FROM aws_all.aws_ec2_instance
# ---------------------------------------------------------------------------
connection "aws_all" {
  plugin      = "aws"
  type        = "aggregator"
  connections = [
    "aws_monitoring",
    "aws_nextjs_dev",
    "aws_nextjs_staging",
    "aws_nextjs_prod",
    "aws_org"
  ]
}

# ---------------------------------------------------------------------------
# Monitoring Account (source — uses EC2 instance role directly)
# ---------------------------------------------------------------------------
connection "aws_monitoring" {
  plugin  = "aws"
  regions = ["eu-west-1"]
  # No profile needed — uses EC2 instance role (IMDSv2)
}

# ---------------------------------------------------------------------------
# Next.js Development Account
# ---------------------------------------------------------------------------
connection "aws_nextjs_dev" {
  plugin   = "aws"
  regions  = ["eu-west-1"]
  role_arn = "arn:aws:iam::NEXTJS_DEV_ACCOUNT_ID:role/SteampipeReadOnly"
  # Source credentials: EC2 instance role assumes this role
}

# ---------------------------------------------------------------------------
# Next.js Staging Account
# ---------------------------------------------------------------------------
connection "aws_nextjs_staging" {
  plugin   = "aws"
  regions  = ["eu-west-1"]
  role_arn = "arn:aws:iam::NEXTJS_STAGING_ACCOUNT_ID:role/SteampipeReadOnly"
}

# ---------------------------------------------------------------------------
# Next.js Production Account
# ---------------------------------------------------------------------------
connection "aws_nextjs_prod" {
  plugin   = "aws"
  regions  = ["eu-west-1", "us-east-1"]
  role_arn = "arn:aws:iam::NEXTJS_PROD_ACCOUNT_ID:role/SteampipeReadOnly"
  # us-east-1 included for CloudFront/Edge resources
}

# ---------------------------------------------------------------------------
# Org / Root Account
# ---------------------------------------------------------------------------
connection "aws_org" {
  plugin   = "aws"
  regions  = ["eu-west-1", "us-east-1"]
  role_arn = "arn:aws:iam::ORG_ACCOUNT_ID:role/SteampipeReadOnly"
}
