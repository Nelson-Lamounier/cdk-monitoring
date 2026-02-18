# Edge Stack Troubleshooting Guide

This guide covers debugging scenarios for the NextJS Edge Stack, including CloudFront, ALB, and Lambda Custom Resources.

---

## Traffic Flow Architecture

Understanding the traffic flow is essential for debugging connectivity issues:

```
┌──────────────┐    HTTPS     ┌────────────────┐    HTTP      ┌─────────────┐    HTTP     ┌──────────────┐
│    User      │ ───────────▶ │   CloudFront   │ ───────────▶ │     ALB     │ ──────────▶ │  ECS Task    │
│  (Browser)   │              │   (us-east-1)  │              │ (eu-west-1) │             │  (Next.js)   │
└──────────────┘              └────────────────┘              └─────────────┘             └──────────────┘
                                     │
                                     │ Certificate: dev.nelsonlamounier.com
                                     │ Protocol: HTTPS (edge only)
                                     ▼
                              ┌────────────────┐
                              │  Route 53 DNS  │
                              │ (Root Account) │
                              └────────────────┘
```

### Why HTTP Between CloudFront and ALB?

| Segment           | Protocol  | Reason                                              |
| ----------------- | --------- | --------------------------------------------------- |
| User → CloudFront | **HTTPS** | Public internet - encryption required               |
| CloudFront → ALB  | **HTTP**  | Internal AWS traffic - avoids SSL hostname mismatch |
| ALB → ECS         | HTTP      | VPC internal - trusted network                      |

**Key Insight:** CloudFront connects to ALB via its AWS DNS name (`*.elb.amazonaws.com`), but ALB certificates are issued for custom domains (`dev.nelsonlamounier.com`). Using HTTPS would cause SSL validation failure → 502.

---

## CloudFront Error Codes

### Issue 6: 502 Bad Gateway

**Symptoms:**

- CloudFront returns `502 Bad Gateway ERROR`
- Error message: "We can't connect to the server for this app"

**Common Causes:**

1. **SSL Hostname Mismatch** (most common after enabling ALB HTTPS)
   - CloudFront uses HTTPS to connect to ALB via `*.elb.amazonaws.com`
   - ALB certificate is for `dev.example.com`
   - SSL validation fails → 502

2. **Origin Not Responding**
   - ALB or ECS service is down
   - Target group has no healthy targets

3. **Security Group Blocking**
   - ALB security group doesn't allow CloudFront IPs

**Debug Commands:**

```bash
# 1. Check ECS service health
aws ecs describe-services \
  --cluster nextjs-cluster-development \
  --services nextjs-service-development \
  --query 'services[0].{status:status,running:runningCount,desired:desiredCount}' \
  --profile dev-account --region eu-west-1

# 2. Check target group health
TG_ARN=$(aws elbv2 describe-target-groups --names nextjs-tg-development \
  --query 'TargetGroups[0].TargetGroupArn' --output text \
  --profile dev-account --region eu-west-1)
aws elbv2 describe-target-health --target-group-arn $TG_ARN \
  --profile dev-account --region eu-west-1

# 3. Check ALB listeners and certificates
ALB_ARN=$(aws elbv2 describe-load-balancers --names nextjs-alb-development \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text \
  --profile dev-account --region eu-west-1)
aws elbv2 describe-listeners --load-balancer-arn $ALB_ARN \
  --query 'Listeners[*].{Port:Port,Protocol:Protocol}' \
  --profile dev-account --region eu-west-1

# 4. Check CloudFront origin configuration
CF_ID=$(aws cloudfront list-distributions \
  --query 'DistributionList.Items[?Aliases.Items[0]==`dev.nelsonlamounier.com`].Id' \
  --output text --profile dev-account)
aws cloudfront get-distribution --id $CF_ID \
  --query 'Distribution.DistributionConfig.Origins.Items[*].{Id:Id,Domain:DomainName,Protocol:CustomOriginConfig.OriginProtocolPolicy}' \
  --profile dev-account
```

**Solution:** Ensure CloudFront uses `HTTP_ONLY` protocol for ALB origin:

```typescript
const albOrigin = new origins.LoadBalancerV2Origin(props.loadBalancer, {
  protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY, // NOT HTTPS_ONLY
});
```

---

### Issue 7: 504 Gateway Timeout

**Symptoms:**

- Request hangs for 30+ seconds
- CloudFront returns `504 Gateway Timeout`

**Debug Commands:**

```bash
# Check origin timeout configuration
aws cloudfront get-distribution --id $CF_ID \
  --query 'Distribution.DistributionConfig.Origins.Items[0].CustomOriginConfig.{ReadTimeout:OriginReadTimeout,ConnectTimeout:OriginKeepaliveTimeout}'
```

**Solution:** Increase origin read timeout in CloudFront configuration.

---

### Issue 8: 301 Redirect Loop (Host Header Not Forwarded)

**Symptoms:**

- Domain (`dev.nelsonlamounier.com`) returns 301 redirect to ALB URL
- ALB direct access works, domain access creates redirect loop
- `curl -I https://dev.nelsonlamounier.com/` shows:
  ```
  HTTP/2 301
  location: https://nextjs-alb-xxx.elb.amazonaws.com:443/
  ```

**Root Cause:** CloudFront isn't forwarding the `Host` header. Next.js sees the ALB hostname and redirects.

**Debug Commands:**

```bash
# 1. Test domain and check for redirect
curl -I https://dev.nelsonlamounier.com/

# 2. Get CloudFront origin request policy
CF_ID=$(aws cloudfront list-distributions \
  --query 'DistributionList.Items[?Aliases.Items[0]==`dev.nelsonlamounier.com`].Id' \
  --output text --profile dev-account)

# 3. Get origin request policy ID
POLICY_ID=$(aws cloudfront get-distribution --id $CF_ID \
  --query 'Distribution.DistributionConfig.DefaultCacheBehavior.OriginRequestPolicyId' \
  --output text --profile dev-account)

# 4. Check which headers are forwarded
aws cloudfront get-origin-request-policy --id $POLICY_ID \
  --query 'OriginRequestPolicy.OriginRequestPolicyConfig.HeadersConfig' \
  --profile dev-account
```

**Solution:** Add `Host` to `originRequestHeaders` in `configurations.ts`:

```typescript
originRequestHeaders: ['Host', 'CloudFront-Viewer-Country', ...],
```

---

### Issue 9: ALB HTTP Redirect Loop (Infinite 301)

**Symptoms:**

- Domain access causes infinite redirect loop
- `curl -sIL https://dev.nelsonlamounier.com/` shows repeated 301s:
  ```
  HTTP/2 301
  location: https://dev.nelsonlamounier.com:443/
  HTTP/2 301
  location: https://dev.nelsonlamounier.com:443/
  ...
  ```

**Root Cause:** ALB HTTP listener (port 80) redirects to HTTPS. CloudFront connects via HTTP → ALB redirects → CloudFront follows → infinite loop.

**Debug Commands:**

```bash
# Check ALB listener actions
ALB_ARN=$(aws elbv2 describe-load-balancers --names nextjs-alb-development \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text \
  --profile dev-account --region eu-west-1)

aws elbv2 describe-listeners --load-balancer-arn $ALB_ARN \
  --query 'Listeners[*].{Port:Port,Protocol:Protocol,Action:DefaultActions[0].Type}' \
  --profile dev-account --region eu-west-1
```

**Solution:** Change HTTP listener from `redirect` to `forward`:

```typescript
// In networking-stack.ts
// CloudFront connects via HTTP, so forward (don't redirect)
this.httpListener = this.albConstruct.createHttpListener(
  "HttpListener",
  this.targetGroup,
);
```

---

### Issue 10: Missing CSS/Static Assets (S3 Region Mismatch)

**Symptoms:**

- Site loads but no CSS/Tailwind styles applied
- Static assets (`/_next/static/*`) return 301 redirect
- ALB direct access works but domain access shows unstyled page

**Root Cause:** S3 origin configured with wrong region. Edge stack is in `us-east-1`, but S3 bucket is in `eu-west-1`. `fromBucketArn()` defaults to stack region.

**Debug Commands:**

```bash
# Check S3 origin domain (should show eu-west-1, not us-east-1)
aws cloudfront get-distribution --id $CF_ID \
  --query 'Distribution.DistributionConfig.Origins.Items[?contains(DomainName, `article-assets`)].DomainName' \
  --profile dev-account

# Test static asset request (should be 200, not 301)
curl -sI "https://dev.nelsonlamounier.com/_next/static/css/app/layout.css" | head -5
```

**Solution:** Use `fromBucketAttributes` with explicit region:

```typescript
// In edge-stack.ts
const bucketRegion = props.staticAssetsBucketRegion ?? "eu-west-1";
const staticAssetsBucket = s3.Bucket.fromBucketAttributes(
  this,
  "ImportedAssetsBucket",
  {
    bucketArn: props.staticAssetsBucketArn,
    bucketName: bucketName,
    region: bucketRegion,
  },
);
```

---

### Issue 11: CDK-nag CFR5 - SSLv3/TLSv1 Error

**Symptoms:**

- Deployment fails with `AwsSolutions-CFR5: The CloudFront distributions uses SSLv3 or TLSv1 for communication to the origin`-- Error occurs even though ALB origin uses `HTTP_ONLY` protocol

**Root Cause:** CDK-nag checks SSL protocol version settings even when origin uses HTTP only.

**Solution:** Add NagSuppression for CFR5:

```typescript
NagSuppressions.addResourceSuppressions(this.distribution.distribution, [
  {
    id: "AwsSolutions-CFR5",
    reason:
      "ALB origin uses HTTP_ONLY protocol (internal AWS traffic). SSL version setting is irrelevant for HTTP connections.",
  },
]);
```

---

### Issue 12: Invalid S3 Origin Domain (Undefined Bucket Name)

**Symptoms:**

- Deployment fails: `The parameter Origin DomainName does not refer to a valid S3 bucket`
- CloudFront shows S3 origin as `undefined.s3.eu-west-1.amazonaws.com`

**Root Cause:** Bucket ARN is a CDK Token (cross-region reference) that can't be parsed at synth time using `split(':::')`.

**Debug Commands:**

```bash
# Check CloudFront S3 origin domain
aws cloudfront get-distribution --id E2NXUT25Y2K47E \
  --query 'Distribution.DistributionConfig.Origins.Items[*].DomainName' \
  --profile dev-account
```

**Solution:** Pass bucket name explicitly as a separate prop:

```typescript
// edge-stack.ts props
readonly staticAssetsBucketName: string; // Required - ARN can't be parsed

// factory.ts
staticAssetsBucketName: dataStack.assetsBucket.bucketName,

// edge-stack.ts - use the explicit name
const bucketName = props.staticAssetsBucketName;
```

---

### Issue 13: S3 403 Forbidden (OAI Bucket Policy Missing)

**Symptoms:**

- Static assets return `HTTP/2 403`
- S3 origin domain is correct
- Files exist in S3 bucket

**Root Cause:** S3Origin creates an OAI (Origin Access Identity) but can't add bucket policy for cross-region imported bucket. Bucket policy missing OAI access grant.

**Debug Commands:**

```bash
# Check bucket policy
aws s3api get-bucket-policy --bucket nextjs-article-assets-development \
  --profile dev-account --region eu-west-1 --output text | python3 -m json.tool

# Check CloudFront OAI configuration
aws cloudfront get-distribution --id E2NXUT25Y2K47E \
  --query 'Distribution.DistributionConfig.Origins.Items[?contains(DomainName, `article-assets`)].S3OriginConfig' \
  --profile dev-account

# Get OAI canonical user ID
aws cloudfront get-cloud-front-origin-access-identity --id <OAI_ID> \
  --query 'CloudFrontOriginAccessIdentity.S3CanonicalUserId' --profile dev-account
```

**Solution:** Add OAI access policy in Data stack:

```typescript
// data-stack.ts
this.assetsBucket.addToResourcePolicy(
  new iam.PolicyStatement({
    sid: "AllowCloudFrontOAIAccess",
    effect: iam.Effect.ALLOW,
    principals: [
      new iam.ArnPrincipal(
        "arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity E2RXFTO1EBBSY3",
      ),
    ],
    actions: ["s3:GetObject"],
    resources: [this.assetsBucket.arnForObjects("*")],
  }),
);
```

**Important:** OAI uses `arn:aws:iam::cloudfront:user/*` format, NOT `cloudfront.amazonaws.com` service principal (which is for OAC).

---

### Issue 14: Static Assets Not Found (Empty S3 Bucket)

**Symptoms:**

- Static assets (`/_next/static/*`) return 403 or 404
- S3 bucket exists but is empty
- CSS/JS files are not loading

**Root Cause:** Next.js static assets (`.next/static/`) were never uploaded to S3. The S3 bucket is for serving static assets but needs to be populated during deployment.

**Debug Commands:**

```bash
# Check if static assets exist in S3
aws s3 ls s3://nextjs-article-assets-development/_next/static/ \
  --recursive --profile dev-account --region eu-west-1

# Check bucket name from SSM
aws ssm get-parameter --name "/nextjs/development/assets-bucket-name" \
  --query 'Parameter.Value' --output text --profile dev-account --region eu-west-1
```

**Solution:** Sync static assets during deployment:

```bash
# Sync from the SAME build that created the Docker image
aws s3 sync .next/static/ s3://nextjs-article-assets-development/_next/static/ \
  --profile dev-account --region eu-west-1
```

---

### Issue 15: Stale Assets After Sync (CloudFront Cache)

**Symptoms:**

- S3 has correct files (verified with `aws s3 ls`)
- Browser still loads old/wrong assets
- Build hashes don't match between container and S3

**Root Cause:** CloudFront cached the 403/404 error responses. Even after fixing S3, CloudFront serves cached errors.

**Debug Commands:**

```bash
# Compare S3 files vs browser requests
aws s3 ls s3://nextjs-article-assets-development/_next/static/chunks/ \
  --profile dev-account | grep main-app

# Check what browser is requesting (different hash = build mismatch)
curl -sI "https://dev.nelsonlamounier.com/_next/static/chunks/main-app-xxx.js" | head -5
```

**Solution:** Invalidate CloudFront cache after S3 sync:

```bash
aws cloudfront create-invalidation --distribution-id E2NXUT25Y2K47E \
  --paths '/_next/*' --profile dev-account

# Wait for invalidation to complete (1-2 minutes)
aws cloudfront wait invalidation-completed \
  --distribution-id E2NXUT25Y2K47E --id <INVALIDATION_ID> --profile dev-account
```

**Best Practice:** Always sync S3 and invalidate cache from the **same** build that creates the Docker image to ensure hash consistency.

---

## Quick Reference Commands

### 1. Check Lambda Log Group

```bash
# List log groups for your Lambda
aws logs describe-log-groups \
  --log-group-name-prefix '/aws/lambda/nextjs-acm-dns-validation' \
  --profile dev-account \
  --region us-east-1

# Get latest log streams
aws logs describe-log-streams \
  --log-group-name '/aws/lambda/nextjs-acm-dns-validation-development' \
  --order-by LastEventTime \
  --descending \
  --limit 5 \
  --profile dev-account \
  --region us-east-1
```

### 2. View Real-time Logs

```bash
# Tail logs (live streaming)
aws logs tail '/aws/lambda/nextjs-acm-dns-validation-development' \
  --follow \
  --profile dev-account \
  --region us-east-1

# View logs from past hour
aws logs tail '/aws/lambda/nextjs-acm-dns-validation-development' \
  --since 1h \
  --profile dev-account \
  --region us-east-1
```

### 3. CloudFormation Stack Events

```bash
# See all stack events
aws cloudformation describe-stack-events \
  --stack-name NextJS-Edge-development \
  --profile dev-account \
  --region us-east-1 \
  --query 'StackEvents[?ResourceStatus==`CREATE_FAILED`]'

# Get detailed error messages
aws cloudformation describe-stack-events \
  --stack-name NextJS-Edge-development \
  --profile dev-account \
  --region us-east-1 | jq '.StackEvents[] | select(.ResourceStatus | contains("FAILED")) | {Resource: .LogicalResourceId, Status: .ResourceStatus, Reason: .ResourceStatusReason}'
```

### 4. CloudWatch Logs Insights Queries

Access CloudWatch Logs Insights in the AWS Console and use these queries:

**Find all errors:**

```
fields @timestamp, @message, level
| filter level = "ERROR"
| sort @timestamp desc
| limit 20
```

**View certificate creation flow:**

```
fields @timestamp, message, domainName, certificateArn
| filter message like /Certificate/
| sort @timestamp asc
```

**Check cross-account role assumption:**

```
fields @timestamp, message, roleArn
| filter message like /AssumeRole/ or message like /cross-account/
| sort @timestamp desc
```

**Find Lambda cold starts:**

```
fields @timestamp, @message
| filter @message like /cold_start/
| sort @timestamp desc
```

---

## Common Issues and Solutions

### Issue 1: "Vendor response doesn't contain CertificateArn"

**Cause:** Lambda returns wrong response format for cr.Provider.

**Solution:** Lambda must return only `{ PhysicalResourceId, Data }`:

```typescript
return {
  PhysicalResourceId: certificateArn,
  Data: { CertificateArn: certificateArn },
};
```

**NOT:**

```typescript
return {
  Status: "SUCCESS", // Don't include this!
  StackId: "...", // Don't include this!
  PhysicalResourceId: certificateArn,
  Data: { CertificateArn: certificateArn },
};
```

---

### Issue 2: Lambda Timeout

**Symptoms:**

- Stack creation hangs for 15+ minutes
- Lambda times out during certificate validation

**Debug Commands:**

```bash
# Check Lambda configuration
aws lambda get-function-configuration \
  --function-name nextjs-acm-dns-validation-development \
  --profile dev-account \
  --region us-east-1 | jq '{Timeout, MemoryLimit}'
```

**Solution:** Increase Lambda timeout to 15 minutes (900 seconds) in CDK.

---

### Issue 3: Cross-Account Role Assumption Failed

**Symptoms:**

```
AccessDenied when assuming role arn:aws:iam::XXX:role/Route53Role
```

**Debug Commands:**

```bash
# Check if role exists
aws iam get-role \
  --role-name Route53Role \
  --profile root-account

# Test AssumeRole manually
aws sts assume-role \
  --role-arn arn:aws:iam::XXX:role/Route53Role \
  --role-session-name test \
  --profile dev-account
```

**Solution:** Ensure trust policy in root account allows dev account to assume the role.

---

### Issue 4: DNS Validation Records Not Created

**Symptoms:**

- Certificate stays in `PENDING_VALIDATION` state
- No CNAME records in Route 53

**Debug Commands:**

```bash
# Check Route 53 hosted zone records
aws route53 list-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  --profile root-account | jq '.ResourceRecordSets[] | select(.Name | contains("_"))'

# Check certificate status
aws acm describe-certificate \
  --certificate-arn arn:aws:acm:us-east-1:XXX:certificate/XXX \
  --profile dev-account \
  --region us-east-1 | jq '.Certificate.DomainValidationOptions'
```

---

### Issue 5: Certificate Already Exists / Limit Exceeded

**Symptoms:**

```
LimitExceededException: You have reached the limit of XXX certificates
```

**Debug Commands:**

```bash
# List existing certificates
aws acm list-certificates \
  --profile dev-account \
  --region us-east-1

# Delete orphaned certificates
aws acm delete-certificate \
  --certificate-arn arn:aws:acm:us-east-1:XXX:certificate/XXX \
  --profile dev-account \
  --region us-east-1
```

---

## Log Output Format (Powertools)

With AWS Lambda Powertools, logs are structured JSON:

```json
{
  "level": "INFO",
  "message": "Certificate validated successfully",
  "service": "acm-dns-validation",
  "timestamp": "2026-02-06T12:00:00.000Z",
  "xray_trace_id": "1-abc123...",
  "cold_start": true,
  "function_name": "nextjs-acm-dns-validation-development",
  "function_memory_size": 256,
  "certificateArn": "arn:aws:acm:...",
  "domainName": "dev.example.com"
}
```

This format enables powerful CloudWatch Logs Insights queries.

---

## Rollback and Recovery

### Delete Failed Stack

```bash
aws cloudformation delete-stack \
  --stack-name NextJS-Edge-development \
  --profile dev-account \
  --region us-east-1
```

### Manually Clean Up Resources

```bash
# Delete orphaned ACM certificate
aws acm delete-certificate \
  --certificate-arn arn:aws:acm:us-east-1:XXX:certificate/XXX \
  --profile dev-account \
  --region us-east-1

# Delete orphaned Route 53 records
aws route53 change-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  --change-batch '{"Changes":[{"Action":"DELETE","ResourceRecordSet":{"Name":"_xxx.dev.example.com.","Type":"CNAME","TTL":300,"ResourceRecords":[{"Value":"_xxx.acm.aws"}]}}]}' \
  --profile root-account
```

---

## See Also

- [AWS Lambda Powertools Documentation](https://docs.powertools.aws.dev/lambda/typescript/latest/)
- [CloudFormation Custom Resource Troubleshooting](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/troubleshooting.html)
- [ACM DNS Validation](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)
