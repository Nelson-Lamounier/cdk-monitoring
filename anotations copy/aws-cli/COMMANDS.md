# Delete the orphaned scripts bucket (with doubled name)

aws s3 rb  --force --profile dev-account

# Delete the failed stack

aws cloudformation delete-stack --stack-name K8s-Compute-development --profile dev-account --region eu-west-1

# Delete the orphaned scripts bucket (with doubled name)
aws s3 rb  --force --profile dev-account

# Delete the failed stack

aws cloudformation delete-stack --stack-name K8s-Compute-development --profile dev-account --region eu-west-1


# Query all instances on a specific region 

aws ec2 describe-instances \
    --region us-east-1 \
    --filters "Name=instance-state-name,Values=running" \
    --query "Reservations[*].Instances[*].{ID:InstanceId,Type:InstanceType,AZ:Placement.AvailabilityZone,Name:Tags[?Key=='Name']|[0].Value}" \
    --output table \
    --profile dev-account
    
# Query for Tags 

** Uses aws ec2 describe-tags \ for fast searching and get all resources on a region by it tags

--query "Reservations[*].Instances[*].{ID:InstanceId, Name:Tags[?Key=='Name']|[0].Value, Project:Tags[?Key=='Project']|[0].Value}" \
--query "Reservations[*].Instances[*].{ID:InstanceId, Tags:Tags}" \

# Query formats
--output json
--output text
--output table

# For terminated instance change the Values

Values=terminated

# Query filters
--filters "Name=instance-state-name,Values=running" \
--filters "Name=resource-type,Values=instance" "Name=key,Values=Name"

# Query all instance on a specific region to get instance Tags
aws ec2 describe-instances \
    --region us-east-1 \
    --filters "Name=instance-state-name,Values=running" \
    --query "Reservations[*].Instances[*].{ID:InstanceId, Tags:Tags}" \
    --output json

aws ec2 describe-tags \
    --region eu-west-1 \
    --filters "Name=resource-type,Values=instance" "Name=key,Values=Name" \
    --profile dev-account


# Use CloudTrail for terminated resources
aws cloudtrail lookup-events \
    --lookup-attributes AttributeKey=EventName,AttributeValue=TerminateInstances \
    --region eu-west-1 \
    --profile dev-account

# Example for development environment
aws ssm put-parameter --name "/k8s/development/edge/domain-name" \
  --value "monitoring.nelsonlamounier.com" --type String \
  --profile dev-account

aws ssm put-parameter --name "/k8s/development/edge/hosted-zone-id" \
  --value "Z0123456789ABCDEFGHIJ" --type String \
  --profile dev-account

 are 

# Delete
aws ssm delete-parameter \
  --name "/k8s/development/edge/cross-account-role-arn" \
  --region eu-west-1 \
  --profile dev-account

  # Delete the failed stack first
aws cloudformation delete-stack \
  --stack-name Monitoring-K8s-Edge-development \
  --region us-east-1 \
  --profile dev-account

# Delete orphaned log groups (if stack deletion doesn't clean them up)
aws logs delete-log-group \
--log-group-name /aws/custom-resource/ReadDomainName \
--region us-east-1 \
--profile dev-account

# Find the instance ID
aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=*k8s*" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --output text \
  --region eu-west-1 \
  --profile dev-account