#!/usr/bin/env npx tsx
/**
 * @format
 * Build Golden AMI — Local / CI Helper Script
 *
 * Triggers the EC2 Image Builder pipeline and polls for completion.
 * Used by: justfile recipe `k8s-build-golden-ami`
 *
 * Usage:
 *   npx tsx scripts/deployment/build-golden-ami.ts development
 *   npx tsx scripts/deployment/build-golden-ami.ts development --region eu-west-1
 *
 * Exit codes:
 *   0 = AMI built (or already exists)
 *   1 = build failed or timed out
 */

import {
    ImagebuilderClient,
    ListImagePipelinesCommand,
    StartImagePipelineExecutionCommand,
    GetImageCommand,
    type ImagePipeline,
} from '@aws-sdk/client-imagebuilder';
import {
    SSMClient,
    GetParameterCommand,
} from '@aws-sdk/client-ssm';

import logger from './logger.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const environment = args[0];

function getFlag(name: string): string {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : '';
}

const region = getFlag('region') || process.env.AWS_REGION || 'eu-west-1';

if (!environment) {
    console.error('Usage: npx tsx build-golden-ami.ts <environment> [--region <region>]');
    process.exit(1);
}

const imagebuilder = new ImagebuilderClient({ region });
const ssm = new SSMClient({ region });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getSsmValue(path: string): Promise<string> {
    try {
        const res = await ssm.send(new GetParameterCommand({ Name: path }));
        return res.Parameter?.Value ?? '';
    } catch {
        return '';
    }
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const ssmPath = `/k8s/${environment}/golden-ami/latest`;
    const parentSsmPath = '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64';
    const pipelineName = `k8s-${environment}-golden-ami-pipeline`;

    logger.info(`Golden AMI Build — ${environment} (${region})`);
    logger.info(`SSM path: ${ssmPath}`);
    logger.info(`Pipeline: ${pipelineName}`);

    // Step 1: Check if Golden AMI already exists
    const currentAmi = await getSsmValue(ssmPath);
    const parentAmi = await getSsmValue(parentSsmPath);

    if (currentAmi && currentAmi !== parentAmi) {
        logger.info(`✓ Golden AMI already exists: ${currentAmi}`);
        logger.info(`  (differs from parent: ${parentAmi})`);
        return;
    }

    logger.warn(`Golden AMI matches parent — build required`);
    logger.info(`  Current: ${currentAmi || 'NOT_FOUND'}`);
    logger.info(`  Parent:  ${parentAmi}`);

    // Step 2: Find the pipeline
    const pipelines = await imagebuilder.send(new ListImagePipelinesCommand({}));
    const pipeline = pipelines.imagePipelineList?.find((p: ImagePipeline) => p.name === pipelineName);

    if (!pipeline?.arn) {
        logger.error(`Pipeline '${pipelineName}' not found`);
        logger.error('Deploy the Compute stack first to create the Image Builder pipeline.');
        process.exit(1);
    }

    logger.info(`✓ Found pipeline: ${pipeline.arn}`);

    // Step 3: Trigger build
    const startResult = await imagebuilder.send(
        new StartImagePipelineExecutionCommand({
            imagePipelineArn: pipeline.arn,
        }),
    );

    const buildArn = startResult.imageBuildVersionArn!;
    logger.info(`✓ Build started: ${buildArn}`);

    // Step 4: Poll for completion
    const maxPolls = 35;
    const intervalMs = 60_000;

    logger.info(`Polling (timeout: ${maxPolls}m)...`);

    for (let i = 1; i <= maxPolls; i++) {
        const image = await imagebuilder.send(
            new GetImageCommand({ imageBuildVersionArn: buildArn }),
        );

        const status = image.image?.state?.status ?? 'UNKNOWN';
        logger.info(`  [${new Date().toISOString()}] Poll ${i}/${maxPolls} — ${status}`);

        if (status === 'AVAILABLE') {
            const amiId = image.image?.outputResources?.amis?.[0]?.image ?? 'unknown';
            logger.info(`✓ Golden AMI built successfully: ${amiId}`);
            return;
        }

        if (status === 'FAILED' || status === 'CANCELLED') {
            const reason = image.image?.state?.reason ?? 'unknown';
            logger.error(`Image Builder failed: ${reason}`);
            process.exit(1);
        }

        await sleep(intervalMs);
    }

    logger.error(`Image Builder timed out after ${maxPolls}m`);
    process.exit(1);
}

main().catch((err) => {
    logger.error(`Unhandled error: ${err}`);
    process.exit(1);
});
