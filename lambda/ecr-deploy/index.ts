/**
 * @format
 * ECR Push Auto-Deploy Lambda
 *
 * Triggered by EventBridge when new images are pushed to ECR.
 * Forces a new deployment on the ECS service to pick up the new image.
 *
 * Environment Variables:
 * - CLUSTER_NAME: ECS cluster name
 * - SERVICE_NAME: ECS service name
 *
 * EventBridge Event Pattern (ECR Image Action):
 * {
 *   "source": ["aws.ecr"],
 *   "detail-type": ["ECR Image Action"],
 *   "detail": {
 *     "action-type": ["PUSH"],
 *     "result": ["SUCCESS"],
 *     "repository-name": ["nextjs-frontend"]
 *   }
 * }
 */

import { ECS } from '@aws-sdk/client-ecs';

interface EcrImageActionEvent {
    version: string;
    id: string;
    'detail-type': 'ECR Image Action';
    source: 'aws.ecr';
    account: string;
    time: string;
    region: string;
    resources: string[];
    detail: {
        result: 'SUCCESS' | 'FAILURE';
        'repository-name': string;
        'image-digest': string;
        'action-type': 'PUSH' | 'DELETE';
        'image-tag'?: string;
    };
}

interface LambdaResponse {
    statusCode: number;
    body: string;
}

const ecs = new ECS({});
const CLUSTER_NAME = process.env.CLUSTER_NAME!;
const SERVICE_NAME = process.env.SERVICE_NAME!;

export async function handler(event: EcrImageActionEvent): Promise<LambdaResponse> {
    console.log('ECR Push Event:', JSON.stringify(event, null, 2));

    const { detail } = event;
    const repositoryName = detail['repository-name'];
    const imageTag = detail['image-tag'] || 'untagged';
    const imageDigest = detail['image-digest'];

    console.log(`New image pushed to ${repositoryName}:${imageTag} (${imageDigest})`);

    // Validate environment variables
    if (!CLUSTER_NAME || !SERVICE_NAME) {
        const errorMsg = 'Missing required environment variables: CLUSTER_NAME and/or SERVICE_NAME';
        console.error(errorMsg);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: errorMsg }),
        };
    }

    try {
        // Force new deployment to pull the latest image
        console.log(`Forcing new deployment on ${CLUSTER_NAME}/${SERVICE_NAME}...`);
        
        const result = await ecs.updateService({
            cluster: CLUSTER_NAME,
            service: SERVICE_NAME,
            forceNewDeployment: true,
        });

        const deploymentId = result.service?.deployments?.[0]?.id || 'unknown';
        const runningCount = result.service?.runningCount || 0;
        const desiredCount = result.service?.desiredCount || 0;

        console.log(`Deployment triggered successfully:`);
        console.log(`  Deployment ID: ${deploymentId}`);
        console.log(`  Running: ${runningCount}, Desired: ${desiredCount}`);

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'ECS deployment triggered',
                repository: repositoryName,
                imageTag,
                imageDigest,
                cluster: CLUSTER_NAME,
                service: SERVICE_NAME,
                deploymentId,
            }),
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('Failed to update ECS service:', errorMessage);

        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to trigger ECS deployment',
                message: errorMessage,
                cluster: CLUSTER_NAME,
                service: SERVICE_NAME,
            }),
        };
    }
}
