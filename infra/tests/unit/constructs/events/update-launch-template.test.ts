import type { AutoScalingClient } from '@aws-sdk/client-auto-scaling';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { SSMClient } from '@aws-sdk/client-ssm';

import { handler } from '../../../../lib/constructs/events/ami-refresh/handlers/update-launch-template';

const mockEc2Send = jest.fn();
const mockSsmSend = jest.fn();
const mockAsgSend = jest.fn();
const mockEc2 = { send: mockEc2Send } as unknown as EC2Client;
const mockSsm = { send: mockSsmSend } as unknown as SSMClient;
const mockAsg = { send: mockAsgSend } as unknown as AutoScalingClient;

beforeEach(() => {
    mockEc2Send.mockReset();
    mockSsmSend.mockReset();
    mockAsgSend.mockReset();
});

// Helper: set up mocks for a workers event with N LT/ASG pairs
function setupWorkerMocks(ltNames: string[], asgNames: string[], versions: number[]): void {
    // 1. amiId lookup
    mockSsmSend.mockResolvedValueOnce({ Parameter: { Value: 'ami-0newimage123' } });
    // 2+3. lt-names + asg-names (fetched in parallel via Promise.all)
    mockSsmSend.mockResolvedValueOnce({ Parameter: { Value: JSON.stringify(ltNames) } });
    mockSsmSend.mockResolvedValueOnce({ Parameter: { Value: JSON.stringify(asgNames) } });
    // Per LT: CreateVersion → ModifyLaunchTemplate (EC2), UpdateAutoScalingGroup (ASG)
    versions.forEach(v => {
        mockEc2Send.mockResolvedValueOnce({ LaunchTemplateVersion: { VersionNumber: v } });
        mockEc2Send.mockResolvedValueOnce({});
        mockAsgSend.mockResolvedValueOnce({});
    });
}

describe('update-launch-template', () => {
    const event = { paramName: '/k8s/development/golden-ami/latest', role: 'workers' as const };

    it('reads AMI ID from the paramName SSM parameter', async () => {
        setupWorkerMocks(['lt-abc123'], ['asg-abc123'], [5]);

        const result = await handler(event, mockEc2, mockSsm, mockAsg);

        expect(result.amiId).toBe('ami-0newimage123');
        expect(result.env).toBe('development');
        expect(result.role).toBe('workers');
        expect(mockSsmSend).toHaveBeenCalledWith(
            expect.objectContaining({ input: expect.objectContaining({
                Name: '/k8s/development/ami-refresh/workers/lt-names',
            })}),
        );
    });

    it('creates a new LT version with the new AMI ID', async () => {
        setupWorkerMocks(['lt-abc123'], ['asg-abc123'], [7]);

        await handler(event, mockEc2, mockSsm, mockAsg);

        expect(mockEc2Send).toHaveBeenCalledWith(
            expect.objectContaining({ input: expect.objectContaining({
                LaunchTemplateName: 'lt-abc123',
                SourceVersion: '$Latest',
                LaunchTemplateData: { ImageId: 'ami-0newimage123' },
            })}),
        );
    });

    it('sets the new version as the LT default', async () => {
        setupWorkerMocks(['lt-abc123'], ['asg-abc123'], [7]);

        await handler(event, mockEc2, mockSsm, mockAsg);

        expect(mockEc2Send).toHaveBeenCalledWith(
            expect.objectContaining({ input: expect.objectContaining({
                LaunchTemplateName: 'lt-abc123',
                DefaultVersion: '7',
            })}),
        );
    });

    it('updates ASG to $Default after setting new LT default', async () => {
        setupWorkerMocks(['lt-abc123'], ['asg-abc123'], [7]);

        await handler(event, mockEc2, mockSsm, mockAsg);

        expect(mockAsgSend).toHaveBeenCalledWith(
            expect.objectContaining({ input: expect.objectContaining({
                AutoScalingGroupName: 'asg-abc123',
                LaunchTemplate: { LaunchTemplateName: 'lt-abc123', Version: '$Default' },
            })}),
        );
    });

    it('updates all LTs and ASGs in the worker pool', async () => {
        setupWorkerMocks(['lt-111', 'lt-222'], ['asg-111', 'asg-222'], [3, 3]);

        await handler(event, mockEc2, mockSsm, mockAsg);

        const createCalls = mockEc2Send.mock.calls.filter(([cmd]) =>
            cmd.constructor?.name === 'CreateLaunchTemplateVersionCommand',
        );
        expect(createCalls).toHaveLength(2);
        expect(mockAsgSend).toHaveBeenCalledTimes(2);
    });

    it('reads control-plane/lt-name and asg-name when role is control-plane', async () => {
        const cpEvent = { paramName: '/k8s/development/golden-ami/latest', role: 'control-plane' as const };
        mockSsmSend
            .mockResolvedValueOnce({ Parameter: { Value: 'ami-0newimage123' } })
            .mockResolvedValueOnce({ Parameter: { Value: 'lt-cp-999' } })
            .mockResolvedValueOnce({ Parameter: { Value: 'asg-cp-999' } });
        mockEc2Send
            .mockResolvedValueOnce({ LaunchTemplateVersion: { VersionNumber: 2 } })
            .mockResolvedValueOnce({});
        mockAsgSend.mockResolvedValueOnce({});

        await handler(cpEvent, mockEc2, mockSsm, mockAsg);

        expect(mockSsmSend).toHaveBeenCalledWith(
            expect.objectContaining({ input: expect.objectContaining({
                Name: '/k8s/development/ami-refresh/control-plane/lt-name',
            })}),
        );
        expect(mockSsmSend).toHaveBeenCalledWith(
            expect.objectContaining({ input: expect.objectContaining({
                Name: '/k8s/development/ami-refresh/control-plane/asg-name',
            })}),
        );
        expect(mockAsgSend).toHaveBeenCalledWith(
            expect.objectContaining({ input: expect.objectContaining({
                AutoScalingGroupName: 'asg-cp-999',
                LaunchTemplate: { LaunchTemplateName: 'lt-cp-999', Version: '$Default' },
            })}),
        );
    });
});
