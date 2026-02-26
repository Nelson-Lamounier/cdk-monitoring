/**
 * @format
 * Gateway Endpoints Construct
 *
 * Reusable construct for VPC Gateway Endpoints (S3 and DynamoDB).
 * These endpoints are free and provide private access to AWS services.
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

/**
 * Props for GatewayEndpointsConstruct
 */
export interface GatewayEndpointsConstructProps {
    /** VPC to add endpoints to */
    readonly vpc: ec2.IVpc;
    /** Enable S3 endpoint @default true */
    readonly enableS3?: boolean;
    /** Enable DynamoDB endpoint @default true */
    readonly enableDynamoDb?: boolean;
    /** Subnet selection for endpoints @default all subnets */
    readonly subnets?: ec2.SubnetSelection;
}

/**
 * Reusable construct for VPC Gateway Endpoints
 *
 * Features:
 * - S3 Gateway Endpoint (free)
 * - DynamoDB Gateway Endpoint (free)
 * - Private access to AWS services
 */
export class GatewayEndpointsConstruct extends Construct {
    /** S3 Gateway Endpoint */
    public readonly s3Endpoint?: ec2.GatewayVpcEndpoint;
    /** DynamoDB Gateway Endpoint */
    public readonly dynamoDbEndpoint?: ec2.GatewayVpcEndpoint;

    constructor(scope: Construct, id: string, props: GatewayEndpointsConstructProps) {
        super(scope, id);

        const enableS3 = props.enableS3 !== false;
        const enableDynamoDb = props.enableDynamoDb !== false;

        // S3 Gateway Endpoint
        if (enableS3) {
            this.s3Endpoint = props.vpc.addGatewayEndpoint('S3Endpoint', {
                service: ec2.GatewayVpcEndpointAwsService.S3,
                subnets: props.subnets ? [props.subnets] : undefined,
            });
            cdk.Tags.of(this.s3Endpoint).add('Name', 's3-gateway-endpoint');
        }

        // DynamoDB Gateway Endpoint
        if (enableDynamoDb) {
            this.dynamoDbEndpoint = props.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
                service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
                subnets: props.subnets ? [props.subnets] : undefined,
            });
            cdk.Tags.of(this.dynamoDbEndpoint).add('Name', 'dynamodb-gateway-endpoint');
        }
    }
}
