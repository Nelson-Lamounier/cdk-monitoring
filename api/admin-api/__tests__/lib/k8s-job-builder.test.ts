import { jest, describe, it, expect } from '@jest/globals';
import { traceParentEnv } from '../../src/lib/k8s-job-builder.js';
import { propagation } from '@opentelemetry/api';

describe('traceParentEnv', () => {
    it('returns null when there is no active span', () => {
        // No OTel SDK running in tests → propagation is a no-op → no traceparent header
        expect(traceParentEnv()).toBeNull();
    });

    it('returns a TRACEPARENT env entry when a propagator injects traceparent', () => {
        // Spy on propagation.inject and mock it to write a traceparent value into the carrier
        const spy = jest.spyOn(propagation, 'inject').mockImplementation((_ctx, carrier) => {
            (carrier as Record<string, string>)['traceparent'] = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
        });

        try {
            const result = traceParentEnv();
            expect(result).toEqual({ name: 'TRACEPARENT', value: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });
        } finally {
            spy.mockRestore();
        }
    });
});
