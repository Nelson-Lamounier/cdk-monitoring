# SQS Dead Letter Queue Implementation Review

## Why DLQs Are Needed

The portfolio API uses **API Gateway → Lambda → DynamoDB/SES** for every request. Lambdas can fail for many reasons — DynamoDB throttling, SES quota limits, code bugs, timeouts. Without DLQs, these failures are **silently lost**: the user gets a 500 error, and there is no record of what happened beyond CloudWatch Logs (which requires actively searching for errors).

DLQs solve this by **capturing the original event payload** of every failed invocation:

1. **Failure visibility** — a non-zero queue depth means something is broken
2. **Event preservation** — the original request is saved for inspection/replay
3. **Decoupled alerting** — CloudWatch Alarms on the queue trigger SNS email notifications without touching Lambda code

## Architecture

```
Client Request
    │
    ▼
API Gateway
    │
    ▼
Lambda Function
    │
    ├── Success → DynamoDB / SES → 200 Response
    │
    └── Failure (after retries) → SQS Dead Letter Queue
                                       │
                                       ▼
                                  CloudWatch Alarm
                                  (messages visible ≥ 1)
                                       │
                                       ▼
                                  SNS Topic → Email Alert
```

### Request Flow

| Step | What Happens                                                                        |
| ---- | ----------------------------------------------------------------------------------- |
| 1    | Client calls `GET /articles` via API Gateway                                        |
| 2    | API Gateway invokes the `list-articles` Lambda                                      |
| 3a   | **Success**: Lambda queries DynamoDB, returns 200                                   |
| 3b   | **Failure**: Lambda throws → AWS retries twice → still fails                        |
| 4    | After exhausting retries, AWS sends the **original event** to the `ListArticlesDlq` |
| 5    | CloudWatch Alarm detects `ApproximateNumberOfMessagesVisible >= 1`                  |
| 6    | Alarm fires → SNS sends email notification                                          |

## Queue Inventory

### NextJS API Stack

| Queue (Logical ID) | Lambda          | Failure Scenarios                                                    |
| ------------------ | --------------- | -------------------------------------------------------------------- |
| `ListArticlesDlq`  | `list-articles` | DynamoDB GSI throttling, index issues, code bugs                     |
| `GetArticleDlq`    | `get-article`   | Slug resolution errors, DynamoDB read failures                       |
| `SubscribeDlq`     | `subscribe`     | SES sending failures, DynamoDB write errors, HMAC token bugs         |
| `VerifyDlq`        | `verify`        | Invalid/expired token handling, DynamoDB conditional update failures |

### Monitoring Stack (separate)

| Queue                        | Source            | Failure Scenarios                           |
| ---------------------------- | ----------------- | ------------------------------------------- |
| `ebs-detach-lambda-dlq`      | EBS detach Lambda | Failed volume detach during ASG termination |
| `ebs-detach-eventbridge-dlq` | EventBridge rule  | Failed event delivery to EBS detach Lambda  |

## Configuration Per Environment

| Setting           | Development           | Staging               | Production            |
| ----------------- | --------------------- | --------------------- | --------------------- |
| Message retention | 7 days                | 14 days               | 14 days               |
| Encryption        | KMS-managed (SSE-KMS) | KMS-managed (SSE-KMS) | KMS-managed (SSE-KMS) |
| Enforce SSL       | ✅                    | ✅                    | ✅                    |
| Removal policy    | DESTROY               | DESTROY               | RETAIN                |
| Queue naming      | Auto-generated        | Auto-generated        | Auto-generated        |

### Auto-Generated Names

Queue names are **not hardcoded**. CloudFormation generates unique names from logical IDs (e.g., `NextJS-Api-prod-SubscribeDlq-A1B2C3D4`). This prevents "already exists" collisions when:

1. A deployment fails mid-creation and rolls back
2. `RemovalPolicy.RETAIN` keeps the queue in AWS
3. The next deployment attempts to create the same name

### Security

Each DLQ enforces:

- **KMS encryption** (`QueueEncryption.KMS_MANAGED`) — messages at rest encrypted with `alias/aws/sqs`
- **SSL enforcement** (`enforceSSL: true`) — queue policy denies requests without `aws:SecureTransport`

Satisfies **AwsSolutions-SQS3** (encryption) and **AwsSolutions-SQS4** (SSL) from cdk-nag.

## CloudWatch Alarm Setup

### Alarm Configuration

```typescript
metric: dlq.metricApproximateNumberOfMessagesVisible({
    period: cdk.Duration.minutes(5),   // Cheapest standard resolution
    statistic: 'Maximum',             // Catches any message, even briefly
}),
threshold: 1,                         // Fire on first failure
evaluationPeriods: 1,                 // Immediate alert
treatMissingData: TreatMissingData.NOT_BREACHING,  // Empty queue = OK
```

### Notification Behavior

| Queue State           | Alarm State | Action                                     |
| --------------------- | ----------- | ------------------------------------------ |
| Empty (0 messages)    | OK          | —                                          |
| First message arrives | → ALARM     | Email: "ALARM — Messages in subscribe DLQ" |
| Queue drained         | → OK        | Email: "OK — subscribe DLQ alarm resolved" |

### Cost

| Resource                                   | Monthly Cost     |
| ------------------------------------------ | ---------------- |
| 4 × Standard CloudWatch Alarm ($0.10 each) | $0.40            |
| 1 × SNS Topic                              | Free tier        |
| Email notifications                        | Free tier        |
| 4 × SQS Queues (idle)                      | Free tier        |
| **Total**                                  | **~$0.40/month** |

## Operational Runbook

### When You Receive an Alarm Email

1. **Identify the DLQ** — the alarm name indicates which Lambda failed
2. **Read the message** — SQS Console → select queue → "Send and receive messages" → "Poll for messages"
3. **Inspect the payload** — message body contains the **original API Gateway event** (headers, path, query params, body)
4. **Check Lambda logs** — CloudWatch Logs → `/aws/lambda/nextjs-<function>-production` → find error at timestamp
5. **Fix and redeploy** — patch the Lambda, push through CI/CD
6. **Handle the message**:
   - **DELETE** — for GET requests that don't need replay
   - **REPLAY** — for POST requests (subscriptions), manually invoke Lambda with saved payload

### Quick Health Check (CLI)

```bash
# Check all DLQ depths
aws sqs list-queues --queue-name-prefix "NextJS-Api" \
  --query 'QueueUrls' --output text | \
  xargs -I {} aws sqs get-queue-attributes \
    --queue-url {} \
    --attribute-names ApproximateNumberOfMessagesVisible \
    --query '{Queue: @.QueueUrl, Messages: @.Attributes.ApproximateNumberOfMessagesVisible}'
```

### Console Health Check

**SQS Console → Queues:**

- `Messages available` = 0 → ✅ Healthy
- `Messages available` > 0 → ⚠️ Failed events need investigation

## Post-Deployment Checklist

- [ ] Verify 4 DLQ queues are created in SQS Console
- [ ] Verify 4 CloudWatch Alarms exist in CloudWatch Console
- [ ] **Confirm SNS email subscription** — check inbox for AWS confirmation email
- [ ] Verify alarm state is `OK` (queues should be empty)
