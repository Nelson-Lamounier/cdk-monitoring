/**
 * @format
 * ACM Certificate DNS Validation Lambda - Unit Tests
 *
 * Tests for the cross-account ACM certificate validation Lambda.
 * Uses aws-sdk-client-mock to mock AWS SDK calls.
 *
 * NOTE: This Lambda uses cr.Provider which expects a simplified response format:
 * { PhysicalResourceId?, Data? } - NOT the full CloudFormation response.
 */

import {
    ACMClient,
    RequestCertificateCommand,
    DescribeCertificateCommand,
    DeleteCertificateCommand,
    CertificateStatus,
} from '@aws-sdk/client-acm';
import {
    Route53Client,
    ChangeResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import {
    CloudFormationCustomResourceEvent,
    Context,
} from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';

import { handler } from '../../../lambda/dns/acm-certificate-dns-validation';

// Mock AWS SDK clients
const acmMock = mockClient(ACMClient);
const stsMock = mockClient(STSClient);
const route53Mock = mockClient(Route53Client);

// Test context
const mockContext: Context = {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'test-function',
    functionVersion: '1',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:test',
    memoryLimitInMB: '256',
    awsRequestId: 'test-request-id',
    logGroupName: '/aws/lambda/test',
    logStreamName: 'test-stream',
    getRemainingTimeInMillis: () => 900000,
    done: () => undefined,
    fail: () => undefined,
    succeed: () => undefined,
};

// Base event properties
const baseEvent = {
    StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/test/guid',
    RequestId: 'test-request-id',
    LogicalResourceId: 'Certificate',
    ResponseURL: 'https://cloudformation-custom-resource-response.s3.amazonaws.com/test',
    ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:test',
    ResourceType: 'Custom::AcmCertificate',
    ResourceProperties: {
        ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:test',
        DomainName: 'dev.example.com',
        HostedZoneId: 'Z1234567890ABC',
        CrossAccountRoleArn: 'arn:aws:iam::999999999999:role/Route53Role',
        Environment: 'development',
        Region: 'us-east-1',
    },
};

describe('ACM Certificate DNS Validation Lambda', () => {
    beforeEach(() => {
        acmMock.reset();
        stsMock.reset();
        route53Mock.reset();

        // Default mock responses
        acmMock.on(RequestCertificateCommand).resolves({
            CertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/test-cert-id',
        });

        acmMock.on(DescribeCertificateCommand).resolves({
            Certificate: {
                CertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/test-cert-id',
                Status: CertificateStatus.ISSUED,
                DomainValidationOptions: [
                    {
                        DomainName: 'dev.example.com',
                        ResourceRecord: {
                            Name: '_acme-challenge.dev.example.com',
                            Type: 'CNAME',
                            Value: '_validation.acm.aws',
                        },
                    },
                ],
            },
        });

        stsMock.on(AssumeRoleCommand).resolves({
            Credentials: {
                AccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
                SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
                SessionToken: 'session-token',
                Expiration: new Date(Date.now() + 3600000),
            },
        });

        route53Mock.on(ChangeResourceRecordSetsCommand).resolves({
            ChangeInfo: {
                Id: '/change/C1234567890',
                Status: 'PENDING',
                SubmittedAt: new Date(),
            },
        });
    });

    describe('Create Request', () => {
        const createEvent: CloudFormationCustomResourceEvent = {
            ...baseEvent,
            RequestType: 'Create',
        } as CloudFormationCustomResourceEvent;

        it('should return response with CertificateArn in Data', async () => {
            const response = await handler(createEvent, mockContext);

            expect(response.Data).toBeDefined();
            expect(response.Data?.CertificateArn).toBe(
                'arn:aws:acm:us-east-1:123456789012:certificate/test-cert-id'
            );
        });

        it('should return PhysicalResourceId as certificate ARN', async () => {
            const response = await handler(createEvent, mockContext);

            expect(response.PhysicalResourceId).toBe(
                'arn:aws:acm:us-east-1:123456789012:certificate/test-cert-id'
            );
        });

        it('should call ACM RequestCertificate', async () => {
            await handler(createEvent, mockContext);

            expect(acmMock).toHaveReceivedCommandWith(RequestCertificateCommand, {
                DomainName: 'dev.example.com',
                ValidationMethod: 'DNS',
            });
        });

        it('should assume cross-account role for Route53 access', async () => {
            await handler(createEvent, mockContext);

            expect(stsMock).toHaveReceivedCommandWith(AssumeRoleCommand, {
                RoleArn: 'arn:aws:iam::999999999999:role/Route53Role',
            });
        });

        it('should create DNS validation records in Route53', async () => {
            await handler(createEvent, mockContext);

            expect(route53Mock).toHaveReceivedCommandWith(ChangeResourceRecordSetsCommand, {
                HostedZoneId: 'Z1234567890ABC',
            });
        });
    });

    describe('Delete Request', () => {
        const deleteEvent: CloudFormationCustomResourceEvent = {
            ...baseEvent,
            RequestType: 'Delete',
            PhysicalResourceId: 'arn:aws:acm:us-east-1:123456789012:certificate/test-cert-id',
        } as CloudFormationCustomResourceEvent;

        beforeEach(() => {
            acmMock.on(DeleteCertificateCommand).resolves({});
        });

        it('should return PhysicalResourceId on delete', async () => {
            const response = await handler(deleteEvent, mockContext);

            expect(response.PhysicalResourceId).toBe(
                'arn:aws:acm:us-east-1:123456789012:certificate/test-cert-id'
            );
        });

        it('should succeed even if certificate does not exist', async () => {
            acmMock.on(DescribeCertificateCommand).rejects(new Error('Certificate not found'));
            acmMock.on(DeleteCertificateCommand).rejects(new Error('Certificate not found'));

            // Should not throw - delete is idempotent
            const response = await handler(deleteEvent, mockContext);
            expect(response.PhysicalResourceId).toBeDefined();
        });
    });

    describe('Error Handling', () => {
        const createEvent: CloudFormationCustomResourceEvent = {
            ...baseEvent,
            RequestType: 'Create',
        } as CloudFormationCustomResourceEvent;

        it('should throw error when ACM fails', async () => {
            acmMock.on(RequestCertificateCommand).rejects(new Error('ACM service error'));

            // cr.Provider expects errors to be thrown, not returned
            await expect(handler(createEvent, mockContext)).rejects.toThrow('ACM service error');
        });

        it('should throw error when STS AssumeRole fails', async () => {
            stsMock.on(AssumeRoleCommand).rejects(new Error('Access denied'));

            await expect(handler(createEvent, mockContext)).rejects.toThrow('Access denied');
        });
    });

    describe('Response Format (cr.Provider compatibility)', () => {
        const createEvent: CloudFormationCustomResourceEvent = {
            ...baseEvent,
            RequestType: 'Create',
        } as CloudFormationCustomResourceEvent;

        it('should return only PhysicalResourceId and Data (cr.Provider format)', async () => {
            const response = await handler(createEvent, mockContext);

            // cr.Provider expects ONLY these fields
            expect(response).toHaveProperty('PhysicalResourceId');
            expect(response).toHaveProperty('Data');

            // Should NOT have full CloudFormation response fields
            expect(response).not.toHaveProperty('Status');
            expect(response).not.toHaveProperty('StackId');
            expect(response).not.toHaveProperty('RequestId');
            expect(response).not.toHaveProperty('LogicalResourceId');
        });

        it('should have CertificateArn available via Data.CertificateArn', async () => {
            const response = await handler(createEvent, mockContext);

            // This is what CloudFormation will use when calling getAtt('CertificateArn')
            expect(response.Data?.CertificateArn).toBeDefined();
            expect(response.Data?.CertificateArn).toMatch(/^arn:aws:acm:/);
        });
    });
});
