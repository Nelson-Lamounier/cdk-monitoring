/**
 * @format
 * Self-Healing Agent Handler — Unit Tests
 *
 * Tests core handler logic in isolation:
 * - buildPrompt: CloudWatch Alarm and generic event formatting
 * - isDuplicate: idempotency guard deduplication
 * - getDefaultTools: default tool definitions
 * - buildToolConfig: Bedrock ToolConfiguration builder
 */

import {
    buildPrompt,
    isDuplicate,
    getDefaultTools,
    buildToolConfig,
} from './index';

import type { AlarmEvent } from './index';

// =============================================================================
// Test Constants
// =============================================================================

const ALARM_NAME = 'k8s-dev-node-cpu-high';
const ALARM_REASON = 'Threshold Crossed: 1 out of 1 datapoints were greater than 80.0';
const EVENT_TIME = '2026-03-19T12:00:00Z';

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create a CloudWatch Alarm event fixture
 */
function createAlarmEvent(overrides?: Partial<AlarmEvent>): AlarmEvent {
    return {
        source: 'aws.cloudwatch',
        'detail-type': 'CloudWatch Alarm State Change',
        time: EVENT_TIME,
        detail: {
            alarmName: ALARM_NAME,
            state: {
                value: 'ALARM',
                reason: ALARM_REASON,
            },
        },
        ...overrides,
    };
}

/**
 * Create a generic EventBridge event fixture
 */
function createGenericEvent(): AlarmEvent {
    return {
        source: 'aws.ec2',
        'detail-type': 'EC2 Instance State-change Notification',
        time: EVENT_TIME,
        detail: {
            instanceId: 'i-0abcdef1234567890',
            state: { value: 'terminated' },
        },
    };
}

// =============================================================================
// buildPrompt
// =============================================================================

describe('buildPrompt', () => {
    it('should format a CloudWatch Alarm event', () => {
        const event = createAlarmEvent();
        const prompt = buildPrompt(event);

        expect(prompt).toContain('A CloudWatch Alarm has fired.');
        expect(prompt).toContain(`Alarm: ${ALARM_NAME}`);
        expect(prompt).toContain('New State: ALARM');
        expect(prompt).toContain(`Reason: ${ALARM_REASON}`);
        expect(prompt).toContain('DRY RUN MODE');
    });

    it('should format a generic EventBridge event', () => {
        const event = createGenericEvent();
        const prompt = buildPrompt(event);

        expect(prompt).toContain('An infrastructure event has occurred.');
        expect(prompt).toContain('Source: aws.ec2');
        expect(prompt).toContain('Type: EC2 Instance State-change Notification');
    });

    it('should handle missing alarm details gracefully', () => {
        const event = createAlarmEvent({
            detail: {},
        });
        const prompt = buildPrompt(event);

        expect(prompt).toContain('Alarm: unknown');
        expect(prompt).toContain('New State: unknown');
        expect(prompt).toContain('Reason: no reason provided');
    });

    it('should handle missing source gracefully', () => {
        const event = createGenericEvent();
        delete (event as Record<string, unknown>)['source'];
        const prompt = buildPrompt(event);

        expect(prompt).toContain('Source: unknown');
    });
});

// =============================================================================
// isDuplicate
// =============================================================================

describe('isDuplicate', () => {
    it('should return false for the first occurrence', () => {
        const event = createAlarmEvent({
            time: `unique-${Date.now()}`,
        });

        expect(isDuplicate(event)).toBe(false);
    });

    it('should return true for a repeated event within the window', () => {
        const uniqueTime = `dedup-test-${Date.now()}`;
        const event = createAlarmEvent({ time: uniqueTime });

        // First call registers the event
        isDuplicate(event);

        // Second call should detect the duplicate
        expect(isDuplicate(event)).toBe(true);
    });

    it('should return false if alarmName is missing', () => {
        const event: AlarmEvent = {
            source: 'aws.cloudwatch',
            time: EVENT_TIME,
            detail: {},
        };

        expect(isDuplicate(event)).toBe(false);
    });
});

// =============================================================================
// getDefaultTools
// =============================================================================

describe('getDefaultTools', () => {
    it('should return two default tools', () => {
        const tools = getDefaultTools();
        expect(tools).toHaveLength(2);
    });

    it('should include diagnose_alarm tool', () => {
        const tools = getDefaultTools();
        const diagnose = tools.find(t => t.name === 'diagnose_alarm');

        expect(diagnose).toBeDefined();
        expect(diagnose?.description).toContain('Analyse');
    });

    it('should include ebs_detach tool', () => {
        const tools = getDefaultTools();
        const ebs = tools.find(t => t.name === 'ebs_detach');

        expect(ebs).toBeDefined();
        expect(ebs?.description).toContain('EBS volume');
    });

    it('should have valid JSON Schema input schemas', () => {
        const tools = getDefaultTools();
        for (const tool of tools) {
            expect(tool.inputSchema).toHaveProperty('type', 'object');
            expect(tool.inputSchema).toHaveProperty('properties');
        }
    });
});

// =============================================================================
// buildToolConfig
// =============================================================================

describe('buildToolConfig', () => {
    it('should convert agent tools to Bedrock ToolConfiguration', () => {
        const tools = getDefaultTools();
        const config = buildToolConfig(tools);

        expect(config.tools).toBeDefined();
        expect(config.tools).toHaveLength(2);
    });

    it('should produce toolSpec entries with correct names', () => {
        const tools = getDefaultTools();
        const config = buildToolConfig(tools);
        const names = config.tools?.map(
            t => (t as unknown as { toolSpec: { name: string } }).toolSpec?.name,
        );

        expect(names).toContain('diagnose_alarm');
        expect(names).toContain('ebs_detach');
    });

    it('should handle an empty tools array', () => {
        const config = buildToolConfig([]);

        expect(config.tools).toHaveLength(0);
    });
});
