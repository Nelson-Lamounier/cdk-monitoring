# Custom Checkov Checks

30 custom security checks for the cdk-monitoring project, grouped by domain into 11 files. Auto-loaded via `.checkov/config.yaml`:

```yaml
external-checks-dir:
  - custom_checks
```

## Check Registry

### Security Groups — `sg_rules.py`

| ID              | Description                                           |
| :-------------- | :---------------------------------------------------- |
| CKV_CUSTOM_SG_1 | No SSH ingress (use SSM Session Manager)              |
| CKV_CUSTOM_SG_2 | No unrestricted egress (0.0.0.0/0 all protocols)      |
| CKV_CUSTOM_SG_3 | No full port range (0-65535) ingress                  |
| CKV_CUSTOM_SG_4 | No external CIDR access to metrics ports (9090, 9100) |
| CKV_CUSTOM_SG_5 | No external CIDR access to Grafana (3000)             |

### IAM — `iam_rules.py`

| ID               | Description                                   |
| :--------------- | :-------------------------------------------- |
| CKV_CUSTOM_IAM_1 | Ensure IAM Role has permissions boundary      |
| CKV_CUSTOM_IAM_2 | No hardcoded account IDs in resource ARNs     |
| CKV_CUSTOM_IAM_3 | No static role names (allow safe CFN updates) |
| CKV_CUSTOM_IAM_4 | Limit AWS managed policies per role (≤3)      |
| CKV_CUSTOM_IAM_5 | Ensure role has at least one policy attached  |

### CloudWatch Logging — `logging_rules.py`

| ID               | Description                       |
| :--------------- | :-------------------------------- |
| CKV_CUSTOM_VPC_1 | Log Group encrypted with KMS      |
| CKV_CUSTOM_VPC_2 | Log Group retention ≥ 90 days     |
| CKV_CUSTOM_VPC_3 | Log Group DeletionPolicy = Retain |

### EC2 UserData — `compute_rules.py`

| ID                   | Description                          |
| :------------------- | :----------------------------------- |
| CKV_CUSTOM_COMPUTE_1 | No hardcoded credentials in UserData |
| CKV_CUSTOM_COMPUTE_2 | IMDSv2 token-based metadata calls    |
| CKV_CUSTOM_COMPUTE_4 | Docker ports bind to 127.0.0.1       |

### EBS Volumes — `ebs_rules.py`

| ID               | Description                                 |
| :--------------- | :------------------------------------------ |
| CKV_CUSTOM_EBS_1 | EBS encrypted with customer-managed KMS key |
| CKV_CUSTOM_EBS_2 | Monitoring volumes ≥ 50 GB                  |
| CKV_CUSTOM_EBS_3 | Automated snapshot/backup strategy          |

### KMS — `kms_rules.py`

| ID               | Description                      |
| :--------------- | :------------------------------- |
| CKV_CUSTOM_KMS_1 | No kms:\* wildcard in key policy |
| CKV_CUSTOM_KMS_2 | KMS key DeletionPolicy = Retain  |

### ASG — `asg_rules.py`

| ID               | Description                                |
| :--------------- | :----------------------------------------- |
| CKV_CUSTOM_ASG_1 | ELB health check when behind load balancer |
| CKV_CUSTOM_ASG_2 | MinSize ≥ 2 for high availability          |

### VPC / Networking — `vpc_rules.py`

| ID               | Description                           |
| :--------------- | :------------------------------------ |
| CKV_CUSTOM_VPC_5 | Subnets do not auto-assign public IPs |
| CKV_CUSTOM_VPC_6 | VPC Endpoints have restrictive policy |

### Lambda — `lambda_rules.py`

| ID                  | Description                               |
| :------------------ | :---------------------------------------- |
| CKV_CUSTOM_LAMBDA_1 | Reserved concurrent executions configured |
| CKV_CUSTOM_LAMBDA_2 | Dead Letter Queue configured              |

### SNS — `sns_rules.py`

| ID               | Description                     |
| :--------------- | :------------------------------ |
| CKV_CUSTOM_SNS_1 | SNS topic encrypted with KMS    |
| CKV_CUSTOM_SNS_2 | SNS topic policy denies non-SSL |

### SQS — `sqs_ssl_enabled.py`

| ID               | Description                   |
| :--------------- | :---------------------------- |
| CKV_CUSTOM_SQS_1 | SQS queue policy enforces SSL |

## Writing New Checks

Add new checks to the appropriate domain file. Follow this pattern:

```python
from checkov.cloudformation.checks.resource.base_resource_check import BaseResourceCheck
from checkov.common.models.enums import CheckCategories, CheckResult

class MyNewCheck(BaseResourceCheck):
    def __init__(self):
        name = "Ensure my security requirement is met"
        id = "CKV_CUSTOM_DOMAIN_N"
        supported_resources = ["AWS::Service::Resource"]
        categories = [CheckCategories.GENERAL_SECURITY]
        super().__init__(name=name, id=id, categories=categories,
                         supported_resources=supported_resources)

    def scan_resource_conf(self, conf):
        if meets_requirement(conf):
            return CheckResult.PASSED
        return CheckResult.FAILED

check = MyNewCheck()
```

## Running Locally

```bash
# Run Checkov with custom checks
checkov -d cdk.out --external-checks-dir .checkov/custom_checks

# Using the config file
checkov -d cdk.out --config-file .checkov/config.yaml
```

## Integration

Custom checks are automatically integrated into:

1. **CI/CD Pipeline**: Via `_iac-security-scan.yml` workflow
2. **Local Development**: Using the config.yaml file
3. **PR Checks**: SARIF results uploaded to GitHub Security tab
