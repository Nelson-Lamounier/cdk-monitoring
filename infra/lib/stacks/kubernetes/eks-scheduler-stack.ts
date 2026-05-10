/**
 * @format
 * EKS Scheduler Stack — dev-only EventBridge Scheduler for auto start/stop.
 *
 * Provisions two Lambda functions (scale-up, scale-down) invoked by
 * EventBridge Scheduler on Europe/Dublin cron schedules:
 *   - Scale-up:   04:00 daily  → MNG minSize=3, desiredSize=3
 *   - Scale-down: 23:00 daily  → MNG minSize=0, desiredSize=0 + terminate
 *                                 any Karpenter workload EC2 instances
 *
 * Only instantiated for Environment.DEVELOPMENT (factory gate).
 *
 * @see docs/superpowers/specs/2026-05-07-eks-resource-optimisation-design.md §§ 3.4, 3.5
 */
import { NagSuppressions } from 'cdk-nag';

import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

export interface EksSchedulerStackProps extends cdk.StackProps {
    readonly cluster: eks.ICluster;
    /** CDK token for the system MNG node group name (from EksSystemNodeGroupStack.nodeGroup.nodegroupName). */
    readonly nodeGroupName: string;
}

export class EksSchedulerStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: EksSchedulerStackProps) {
        super(scope, id, props);

        const { cluster, nodeGroupName } = props;

        const lambdaRole = new iam.Role(this, 'SchedulerLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    'service-role/AWSLambdaBasicExecutionRole',
                ),
            ],
        });

        lambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['eks:ListNodegroups', 'eks:DescribeCluster'],
                resources: [cluster.clusterArn],
            }),
        );

        lambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    'eks:UpdateNodegroupConfig',
                    'eks:DescribeNodegroup',
                ],
                // nodegroup ARN format: arn:partition:eks:region:account:nodegroup/cluster-name/ng-name/id
                // NOT under the cluster ARN — different resource namespace
                resources: [
                    `arn:${cdk.Aws.PARTITION}:eks:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:nodegroup/${cluster.clusterName}/*/*`,
                ],
            }),
        );

        lambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['ec2:DescribeInstances'],
                resources: ['*'],
            }),
        );

        lambdaRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['ec2:TerminateInstances'],
                resources: ['*'],
                conditions: {
                    StringEquals: {
                        'ec2:ResourceTag/eks-cluster-pool': 'workloads-default',
                    },
                },
            }),
        );

        // DescribeInstances requires * — no resource-level restriction exists for Describe APIs.
        // eks:UpdateNodegroupConfig/DescribeNodegroup require nodegroup/*/*  (wildcard over ng-name + uuid).
        NagSuppressions.addResourceSuppressions(lambdaRole, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'ec2:DescribeInstances has no resource-level restriction in IAM. ' +
                        'ec2:TerminateInstances is tag-conditioned to eks-cluster-pool=workloads-default. ' +
                        'eks nodegroup actions scoped to nodegroup/<cluster>/*/* (uuid not known at synth time).',
                appliesTo: [
                    'Resource::*',
                    { regex: '/^Resource::.*:nodegroup\\/.*\\/\\*\\/\\*/' },
                ],
            },
        ], true);

        const commonEnv = {
            CLUSTER_NAME: cluster.clusterName,
            NODEGROUP_NAME: nodeGroupName,
        };

        const scaleUpFn = new lambda.Function(this, 'ScaleUpFn', {
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(1),
            role: lambdaRole,
            environment: commonEnv,
            code: lambda.Code.fromInline(`
import boto3, base64, json, ssl, tempfile, urllib.request, os, logging
from botocore.signers import RequestSigner

log = logging.getLogger()
log.setLevel(logging.INFO)

def get_bearer_token(cluster_id, region):
    """Generate EKS auth token (equivalent to: aws eks get-token --cluster-name X)."""
    session = boto3.session.Session()
    client = session.client('sts', region_name=region)
    signer = RequestSigner(
        client.meta.service_model.service_id,
        region, 'sts', 'v4',
        session.get_credentials(), session.events,
    )
    signed_url = signer.generate_presigned_url(
        {
            'method': 'GET',
            'url': f'https://sts.{region}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15',
            'body': {},
            'headers': {'x-k8s-aws-id': cluster_id},
            'context': {},
        },
        region_name=region, expires_in=60, operation_name='',
    )
    return 'k8s-aws-v1.' + base64.urlsafe_b64encode(signed_url.encode()).decode().rstrip('=')

def handler(event, context):
    region = os.environ['AWS_REGION']
    cluster_name = os.environ['CLUSTER_NAME']
    ng_name = os.environ['NODEGROUP_NAME']
    eks = boto3.client('eks', region_name=region)

    eks.update_nodegroup_config(
        clusterName=cluster_name,
        nodegroupName=ng_name,
        scalingConfig={'minSize': 2, 'desiredSize': 2},
    )
    log.info('Scaled MNG to 2')

    # Restore Karpenter to 2 replicas. dev-shutdown scales it to 0 after
    # clearing NodeClaim finalizers; without this patch the controller stays
    # down and no workload nodes are ever provisioned after cluster start.
    cluster_info = eks.describe_cluster(name=cluster_name)['cluster']
    endpoint = cluster_info['endpoint']
    ca_data = base64.b64decode(cluster_info['certificateAuthority']['data'])
    token = get_bearer_token(cluster_name, region)

    with tempfile.NamedTemporaryFile(delete=False, suffix='.crt') as f:
        f.write(ca_data)
        ca_file = f.name

    patch = json.dumps({'spec': {'replicas': 2}}).encode()
    url = f'{endpoint}/apis/apps/v1/namespaces/karpenter/deployments/karpenter'
    req = urllib.request.Request(
        url, data=patch, method='PATCH',
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/merge-patch+json',
        },
    )
    ctx = ssl.create_default_context(cafile=ca_file)
    with urllib.request.urlopen(req, context=ctx) as resp:
        log.info('Karpenter patch response: %s', resp.status)

    return {'status': 'scaled-up', 'karpenter-replicas': 2}
`),
        });

        const scaleDownFn = new lambda.Function(this, 'ScaleDownFn', {
            runtime: lambda.Runtime.PYTHON_3_14,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(2),
            role: lambdaRole,
            environment: commonEnv,
            code: lambda.Code.fromInline(`
import boto3, os, logging
log = logging.getLogger()
log.setLevel(logging.INFO)

def handler(event, context):
    region = os.environ['AWS_REGION']
    eks = boto3.client('eks', region_name=region)
    ec2 = boto3.client('ec2', region_name=region)
    eks.update_nodegroup_config(
        clusterName=os.environ['CLUSTER_NAME'],
        nodegroupName=os.environ['NODEGROUP_NAME'],
        scalingConfig={'minSize': 0, 'desiredSize': 0},
    )
    log.info('Scaled MNG to 0')
    resp = ec2.describe_instances(
        Filters=[
            {'Name': 'tag:eks-cluster-pool', 'Values': ['workloads-default']},
            {'Name': 'instance-state-name', 'Values': ['running']},
        ]
    )
    ids = [i['InstanceId'] for r in resp['Reservations'] for i in r['Instances']]
    if ids:
        ec2.terminate_instances(InstanceIds=ids)
        log.info('Terminated: %s', ids)
    return {'terminated': ids}
`),
        });

        const schedulerRole = new iam.Role(this, 'SchedulerRole', {
            assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
        });

        schedulerRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ['lambda:InvokeFunction'],
                resources: [scaleUpFn.functionArn, scaleDownFn.functionArn],
            }),
        );

        // Grant the Lambda role permission to PATCH the Karpenter deployment.
        // Scoped to the karpenter namespace only — least privilege for a single
        // scale-up operation. AmazonEKSEditPolicy allows create/update/delete
        // on most resource types within the namespace scope.
        new eks.AccessEntry(this, 'SchedulerLambdaAccessEntry', {
            cluster,
            principal: lambdaRole.roleArn,
            accessPolicies: [
                eks.AccessPolicy.fromAccessPolicyName('AmazonEKSEditPolicy', {
                    accessScopeType: eks.AccessScopeType.NAMESPACE,
                    namespaces: ['karpenter'],
                }),
            ],
        });

        new scheduler.CfnSchedule(this, 'ScaleUpSchedule', {
            scheduleExpression: 'cron(0 4 * * ? *)',
            scheduleExpressionTimezone: 'Europe/Dublin',
            flexibleTimeWindow: { mode: 'OFF' },
            target: {
                arn: scaleUpFn.functionArn,
                roleArn: schedulerRole.roleArn,
            },
        });

        new scheduler.CfnSchedule(this, 'ScaleDownSchedule', {
            scheduleExpression: 'cron(0 23 * * ? *)',
            scheduleExpressionTimezone: 'Europe/Dublin',
            flexibleTimeWindow: { mode: 'OFF' },
            target: {
                arn: scaleDownFn.functionArn,
                roleArn: schedulerRole.roleArn,
            },
        });
    }
}
