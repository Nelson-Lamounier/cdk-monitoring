/**
 * @format
 * EBS Volume Construct
 *
 * Reusable EBS volume construct with encryption, GP3 optimization,
 * and SSM-based volume discovery for reuse across stack destroys.
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { MONITORING_APP_TAG } from '../../config/defaults';

/**
 * Props for EncryptedEbsVolumeConstruct
 */
export interface EncryptedEbsVolumeConstructProps {
    /** Availability Zone for the volume */
    readonly availabilityZone: string;
    /** Volume size in GB @default 30 */
    readonly sizeGb?: number;
    /** Volume type @default GP3 */
    readonly volumeType?: ec2.EbsDeviceVolumeType;
    /** IOPS (for GP3, IO1, IO2) @default 3000 for GP3 */
    readonly iops?: number;
    /** Throughput in MiB/s (GP3 only) @default 125 */
    readonly throughput?: number;
    /** Existing KMS key for encryption */
    readonly encryptionKey?: kms.IKey | null;
    /** Create dedicated KMS key @default false (uses free AWS-managed key) */
    readonly createEncryptionKey?: boolean;
    /** Resource name prefix @default 'monitoring' */
    readonly namePrefix?: string;
    /** Removal policy @default RETAIN */
    readonly removalPolicy?: cdk.RemovalPolicy;

    // =================================================================
    // SSM-Based Volume Reuse
    // =================================================================
    /**
     * Existing volume ID to import instead of creating a new volume.
     * When provided, the construct imports the existing volume rather than creating new.
     * Use this with SSM parameter lookup for automatic volume reuse.
     * @example 'vol-0123456789abcdef0'
     */
    readonly existingVolumeId?: string;

    /**
     * Whether we're importing an existing volume (read-only mode).
     * When true, the construct only references the volume, it doesn't modify or recreate it.
     * @default false
     */
    readonly importExisting?: boolean;
}

/**
 * Reusable EBS volume construct with encryption and SSM-based reuse.
 *
 * Features:
 * - GP3 volume type by default
 * - Encryption with AWS-managed key (free) or customer-managed key
 * - IOPS and throughput validation
 * - Import existing volumes for reuse across stack destroys
 *
 * @example
 * // Create new volume
 * new EncryptedEbsVolumeConstruct(this, 'Volume', {
 *   availabilityZone: 'eu-west-1a',
 *   sizeGb: 50,
 * });
 *
 * // Import existing volume
 * new EncryptedEbsVolumeConstruct(this, 'Volume', {
 *   availabilityZone: 'eu-west-1a',
 *   existingVolumeId: 'vol-0123456789abcdef0',
 *   importExisting: true,
 * });
 */
export class EncryptedEbsVolumeConstruct extends Construct {
    /** The EBS volume */
    public readonly volume: ec2.IVolume;
    /** KMS key for encryption (if created, undefined for imported volumes) */
    public readonly encryptionKey?: kms.IKey;
    /** Whether this is an imported volume vs. newly created */
    public readonly isImported: boolean;

    constructor(scope: Construct, id: string, props: EncryptedEbsVolumeConstructProps) {
        super(scope, id);

        const namePrefix = props.namePrefix ?? 'monitoring';
        const sizeGb = props.sizeGb ?? 30;
        const volumeType = props.volumeType ?? ec2.EbsDeviceVolumeType.GP3;
        const iops = props.iops ?? (volumeType === ec2.EbsDeviceVolumeType.GP3 ? 3000 : undefined);
        const throughput = props.throughput ?? (volumeType === ec2.EbsDeviceVolumeType.GP3 ? 125 : undefined);

        // =================================================================
        // Import Existing Volume (SSM-based reuse)
        // =================================================================
        if (props.existingVolumeId && props.importExisting) {
            this.isImported = true;
            this.volume = ec2.Volume.fromVolumeAttributes(this, 'ImportedVolume', {
                volumeId: props.existingVolumeId,
                availabilityZone: props.availabilityZone,
            });
            // Note: encryptionKey is not available for imported volumes
            return;
        }

        // =================================================================
        // Create New Volume
        // =================================================================
        this.isImported = false;

        // Validate configuration
        this.validateConfig(volumeType, iops, throughput);

        // Set up encryption
        if (props.encryptionKey !== null) {
            if (props.encryptionKey) {
                this.encryptionKey = props.encryptionKey;
            } else if (props.createEncryptionKey === true) {
                this.encryptionKey = new kms.Key(this, 'EncryptionKey', {
                    alias: `${namePrefix}-ebs-key`,
                    description: `KMS key for ${namePrefix} EBS volume encryption`,
                    enableKeyRotation: true,
                    removalPolicy: cdk.RemovalPolicy.RETAIN,
                });
            }
        }

        // Create volume
        const newVolume = new ec2.Volume(this, 'Volume', {
            availabilityZone: props.availabilityZone,
            size: cdk.Size.gibibytes(sizeGb),
            volumeType,
            iops,
            throughput,
            encrypted: true,
            encryptionKey: this.encryptionKey,
            removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
            volumeName: `${namePrefix}-data-volume`,
        });

        this.volume = newVolume;

        // Apply tags
        cdk.Tags.of(newVolume).add('Purpose', 'Monitoring');
        cdk.Tags.of(newVolume).add(MONITORING_APP_TAG.key, MONITORING_APP_TAG.value);
        cdk.Tags.of(newVolume).add('DataClassification', 'Internal');
    }

    private validateConfig(
        volumeType: ec2.EbsDeviceVolumeType,
        iops?: number,
        throughput?: number
    ): void {
        if (throughput && volumeType !== ec2.EbsDeviceVolumeType.GP3) {
            throw new Error('Throughput can only be specified for GP3 volumes');
        }
        if (volumeType === ec2.EbsDeviceVolumeType.GP3 && iops) {
            if (iops < 3000 || iops > 16000) {
                throw new Error('GP3 IOPS must be between 3000 and 16000');
            }
        }
        if (volumeType === ec2.EbsDeviceVolumeType.GP3 && throughput) {
            if (throughput < 125 || throughput > 1000) {
                throw new Error('GP3 throughput must be between 125 and 1000 MiB/s');
            }
        }
    }

    /**
     * Grant attach volume permissions to an EC2 instance.
     * Works for both created and imported volumes.
     */
    grantAttachVolume(instance: ec2.IInstance): void {
        this.volume.grantAttachVolume(instance);
    }

    /**
     * Grant detach volume permissions to an EC2 instance.
     * Works for both created and imported volumes.
     */
    grantDetachVolume(instance: ec2.IInstance): void {
        this.volume.grantDetachVolume(instance);
    }

    /**
     * Grant attach by resource tag permissions.
     * Works for both created and imported volumes.
     */
    grantAttachVolumeByResourceTag(
        grantee: iam.IGrantable,
        constructs: Construct[]
    ): void {
        this.volume.grantAttachVolumeByResourceTag(grantee, constructs);
    }

    /**
     * Grant detach by resource tag permissions.
     * Useful for lifecycle Lambdas that need to detach tagged volumes.
     */
    grantDetachVolumeByResourceTag(
        grantee: iam.IGrantable,
        constructs: Construct[]
    ): void {
        this.volume.grantDetachVolumeByResourceTag(grantee, constructs);
    }
}

