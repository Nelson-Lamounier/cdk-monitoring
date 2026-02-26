/**
 * @format
 * Mock AWS resources for testing
 *
 * Reusable mock resources for CDK stack tests that require
 * dependencies like VPC, Security Groups, KMS Keys, etc.
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cdk from 'aws-cdk-lib/core';

import { DEFAULT_VPC_CONFIG } from './constants';

/**
 * Options for creating a mock VPC
 */
export interface MockVpcOptions {
    /** Number of Availability Zones (default: 2) */
    maxAzs?: number;
    /** Number of NAT Gateways (default: 0 for cost optimization) */
    natGateways?: number;
}

/**
 * Creates a mock VPC for testing stacks that require VPC dependency.
 *
 * @param stack - Stack to create the VPC in
 * @param id - Construct ID (default: 'MockVpc')
 * @param options - VPC configuration options
 * @returns A VPC instance
 */
export function createMockVpc(
    stack: cdk.Stack,
    id = 'MockVpc',
    options?: MockVpcOptions
): ec2.IVpc {
    return new ec2.Vpc(stack, id, {
        maxAzs: options?.maxAzs ?? DEFAULT_VPC_CONFIG.maxAzs,
        natGateways: options?.natGateways ?? DEFAULT_VPC_CONFIG.natGateways,
    });
}

/**
 * Creates a mock Security Group for testing stacks that require SG dependency.
 *
 * @param stack - Stack to create the SG in
 * @param vpc - VPC to associate the SG with
 * @param id - Construct ID (default: 'MockSg')
 * @returns A Security Group instance
 */
export function createMockSecurityGroup(
    stack: cdk.Stack,
    vpc: ec2.IVpc,
    id = 'MockSg'
): ec2.ISecurityGroup {
    return new ec2.SecurityGroup(stack, id, {
        vpc,
        securityGroupName: 'test-sg',
        description: 'Mock security group for testing',
    });
}

/**
 * Result type for VPC with Security Group creation
 */
export interface VpcWithSecurityGroup {
    vpc: ec2.IVpc;
    securityGroup: ec2.ISecurityGroup;
}

/**
 * Creates a mock VPC and Security Group together.
 * This is a common pattern for stacks that need both resources.
 *
 * @param stack - Stack to create resources in
 * @param options - Optional IDs for VPC and SG
 * @returns Object containing both VPC and Security Group
 */
export function createMockVpcWithSg(
    stack: cdk.Stack,
    options?: { vpcId?: string; sgId?: string }
): VpcWithSecurityGroup {
    const vpc = createMockVpc(stack, options?.vpcId ?? 'MockVpc');
    const securityGroup = createMockSecurityGroup(stack, vpc, options?.sgId ?? 'MockSg');
    return { vpc, securityGroup };
}

/**
 * Options for creating a mock KMS key
 */
export interface MockKmsKeyOptions {
    /** Enable key rotation (default: true for Checkov compliance) */
    enableKeyRotation?: boolean;
    /** Removal policy (default: DESTROY for tests) */
    removalPolicy?: cdk.RemovalPolicy;
}

/**
 * Creates a mock KMS key for testing encryption scenarios.
 *
 * @param stack - Stack to create the key in
 * @param id - Construct ID (default: 'MockKey')
 * @param options - Key configuration options
 * @returns A KMS Key instance
 */
export function createMockKmsKey(
    stack: cdk.Stack,
    id = 'MockKey',
    options?: MockKmsKeyOptions
): kms.IKey {
    return new kms.Key(stack, id, {
        enableKeyRotation: options?.enableKeyRotation ?? true,
        removalPolicy: options?.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
    });
}

/**
 * Creates the first availability zone from a VPC.
 * Useful for EBS volume tests that need a specific AZ.
 *
 * @param vpc - VPC to get AZ from
 * @returns First availability zone string
 */
export function getFirstAvailabilityZone(vpc: ec2.IVpc): string {
    return vpc.availabilityZones[0];
}
