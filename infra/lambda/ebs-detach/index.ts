/**
 * EBS Volume Detach Lambda Handler
 *
 * Triggered by EventBridge when an ASG lifecycle hook fires for instance termination.
 * Detaches EBS volumes (by tag) and completes the lifecycle action to allow termination.
 *
 * Environment Variables:
 * - VOLUME_TAG_KEY: Tag key to identify volumes (default: 'ManagedBy')
 * - VOLUME_TAG_VALUE: Tag value to identify volumes (default: 'MonitoringStack')
 *
 * Event Flow:
 * 1. ASG initiates termination → Lifecycle hook pauses in Terminating:Wait
 * 2. EventBridge fires 'EC2 Instance-terminate Lifecycle Action'
 * 3. This Lambda: discovers volumes by tag → detaches → completes lifecycle action
 * 4. ASG continues termination
 */

import {
    AutoScalingClient,
    CompleteLifecycleActionCommand,
} from '@aws-sdk/client-auto-scaling';
import {
    EC2Client,
    DetachVolumeCommand,
    DescribeVolumesCommand,
    DescribeInstancesCommand,
    waitUntilVolumeAvailable,
} from '@aws-sdk/client-ec2';
import { WaiterState } from '@smithy/util-waiter';


const ec2Client = new EC2Client({});
const asgClient = new AutoScalingClient({});

interface ASGLifecycleEvent {
    version: string;
    id: string;
    'detail-type': string;
    source: string;
    account: string;
    time: string;
    region: string;
    resources: string[];
    detail: {
        LifecycleActionToken: string;
        AutoScalingGroupName: string;
        LifecycleHookName: string;
        EC2InstanceId: string;
        LifecycleTransition: string;
        NotificationMetadata?: string;
    };
}

interface LambdaResponse {
    statusCode: number;
    body: string;
}

/**
 * Find volumes attached to an instance by tag
 */
async function findVolumesToDetach(instanceId: string): Promise<string[]> {
    const tagKey = process.env.VOLUME_TAG_KEY ?? 'ManagedBy';
    const tagValue = process.env.VOLUME_TAG_VALUE ?? 'MonitoringStack';

    console.log(`Discovering volumes with tag ${tagKey}=${tagValue} attached to ${instanceId}`);

    const describeResponse = await ec2Client.send(new DescribeVolumesCommand({
        Filters: [
            {
                Name: 'attachment.instance-id',
                Values: [instanceId],
            },
            {
                Name: `tag:${tagKey}`,
                Values: [tagValue],
            },
            {
                Name: 'attachment.status',
                Values: ['attached'],
            },
        ],
    }));

    const volumeIds = describeResponse.Volumes?.map(v => v.VolumeId).filter((id): id is string => !!id) ?? [];
    console.log(`Found ${volumeIds.length} volumes to detach: ${volumeIds.join(', ') || 'none'}`);

    return volumeIds;
}

/**
 * Detach a volume from an instance and wait for it to become available.
 * Returns true only when the volume is confirmed 'available'.
 */
async function detachVolume(volumeId: string, instanceId: string): Promise<boolean> {
    try {
        console.log(`Detaching volume ${volumeId} from instance ${instanceId}`);
        
        await ec2Client.send(new DetachVolumeCommand({
            VolumeId: volumeId,
            InstanceId: instanceId,
            Force: false, // Don't force, let it detach cleanly while instance is still running
        }));

        console.log(`Successfully initiated detach for volume ${volumeId}`);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // Idempotency: if volume is already detached/detaching, that's fine
        if (errorMessage.includes('is in the \'available\' state')) {
            console.log(`Volume ${volumeId} already available - idempotent success`);
            return true;
        }
        if (errorMessage.includes('is in the \'detaching\' state')) {
            console.log(`Volume ${volumeId} already detaching - will wait for available`);
        } else {
            console.error(`Failed to detach volume ${volumeId}:`, error);
            return false;
        }
    }

    // Wait for volume to reach 'available' state before returning.
    // This is critical: without this wait, the lifecycle action completes
    // while the volume is still 'detaching', and the new instance finds
    // it in 'in-use' state and fails.
    try {
        console.log(`Waiting for volume ${volumeId} to reach 'available' state...`);
        const result = await waitUntilVolumeAvailable(
            { client: ec2Client, maxWaitTime: 120, minDelay: 5, maxDelay: 5 },
            { VolumeIds: [volumeId] },
        );

        if (result.state === WaiterState.SUCCESS) {
            console.log(`Volume ${volumeId} is now available`);
            return true;
        }
        console.error(`Volume ${volumeId} waiter ended with state: ${result.state}`);
        return false;
    } catch (waitError) {
        console.error(`Timed out waiting for volume ${volumeId} to become available:`, waitError);
        return false;
    }
}

/**
 * Check if instance still exists and is in a state that allows detachment
 */
async function isInstanceValid(instanceId: string): Promise<boolean> {
    try {
        const response = await ec2Client.send(new DescribeInstancesCommand({
            InstanceIds: [instanceId],
        }));

        const instance = response.Reservations?.[0]?.Instances?.[0];
        if (!instance) {
            console.log(`Instance ${instanceId} not found`);
            return false;
        }

        const state = instance.State?.Name;
        console.log(`Instance ${instanceId} state: ${state}`);
        
        // Lifecycle hook keeps instance in 'shutting-down' during Terminating:Wait
        return ['running', 'stopping', 'stopped', 'shutting-down'].includes(state ?? '');
    } catch (error) {
        console.error(`Error checking instance state:`, error);
        return false;
    }
}

/**
 * Complete the ASG lifecycle action to allow termination to proceed
 */
async function completeLifecycleAction(
    asgName: string,
    lifecycleHookName: string,
    lifecycleActionToken: string,
    instanceId: string,
    result: 'CONTINUE' | 'ABANDON'
): Promise<void> {
    console.log(`Completing lifecycle action: ${result} for ${instanceId}`);
    
    await asgClient.send(new CompleteLifecycleActionCommand({
        AutoScalingGroupName: asgName,
        LifecycleHookName: lifecycleHookName,
        LifecycleActionToken: lifecycleActionToken,
        LifecycleActionResult: result,
        InstanceId: instanceId,
    }));

    console.log(`Lifecycle action completed: ${result}`);
}

/**
 * Lambda handler for ASG termination lifecycle events
 */
export const handler = async (event: ASGLifecycleEvent): Promise<LambdaResponse> => {
    console.log('Received lifecycle event:', JSON.stringify(event, null, 2));

    const { 
        EC2InstanceId: instanceId,
        AutoScalingGroupName: asgName,
        LifecycleHookName: hookName,
        LifecycleActionToken: token,
    } = event.detail;

    if (!instanceId || !asgName || !hookName || !token) {
        console.error('Missing required lifecycle event fields');
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Missing required lifecycle event fields' }),
        };
    }

    console.log(`Processing termination lifecycle for instance ${instanceId} in ASG ${asgName}`);

    let lifecycleResult: 'CONTINUE' | 'ABANDON' = 'CONTINUE';

    try {
        // Check if instance is valid for detachment
        const instanceValid = await isInstanceValid(instanceId);
        if (!instanceValid) {
            console.log('Instance not valid for volume detachment');
            // Still complete the lifecycle action to allow termination
            await completeLifecycleAction(asgName, hookName, token, instanceId, 'CONTINUE');
            return {
                statusCode: 200,
                body: JSON.stringify({ 
                    message: 'Instance not valid for detachment, lifecycle completed',
                    instanceId,
                }),
            };
        }

        // Find volumes to detach
        const volumeIds = await findVolumesToDetach(instanceId);

        if (volumeIds.length === 0) {
            console.log('No volumes found to detach');
            await completeLifecycleAction(asgName, hookName, token, instanceId, 'CONTINUE');
            return {
                statusCode: 200,
                body: JSON.stringify({ 
                    message: 'No volumes to detach, lifecycle completed',
                    instanceId,
                }),
            };
        }

        // Detach all found volumes
        const results = await Promise.all(
            volumeIds.map(volumeId => detachVolume(volumeId, instanceId))
        );

        const successCount = results.filter(r => r).length;
        const failCount = results.filter(r => !r).length;

        console.log(`Detachment complete: ${successCount} succeeded, ${failCount} failed`);

        // If any volumes failed to detach, we still CONTINUE to allow termination
        // The volume will remain attached but become available when instance terminates
        if (failCount > 0) {
            console.warn(`${failCount} volumes failed to detach cleanly, but continuing termination`);
        }

    } catch (error) {
        console.error('Error during volume detachment:', error);
        // Even on error, complete lifecycle to avoid stuck instances
        lifecycleResult = 'CONTINUE';
    }

    // Complete the lifecycle action to allow termination to proceed
    try {
        await completeLifecycleAction(asgName, hookName, token, instanceId, lifecycleResult);
    } catch (error) {
        console.error('Failed to complete lifecycle action:', error);
        throw error; // This is critical - let Lambda retry via DLQ
    }

    return {
        statusCode: 200,
        body: JSON.stringify({
            message: 'Volume detachment and lifecycle completion successful',
            instanceId,
            asgName,
            lifecycleResult,
        }),
    };
};
