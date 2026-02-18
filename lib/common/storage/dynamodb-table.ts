/** @format */

import * as cdk from "aws-cdk-lib";

import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as kms from "aws-cdk-lib/aws-kms";

import { Construct } from "constructs";

/**
 * Configuration for DynamoDB table Global Secondary Index (GSI)
 */
export interface DynamoDbGsiConfig {
  /**
   * Name of the GSI
   */
  indexName: string;

  /**
   * Partition key attribute name for the GSI
   */
  partitionKey: string;

  /**
   * Sort key attribute name for the GSI (optional)
   */
  sortKey?: string;

  /**
   * Projection type for the GSI
   * @default ProjectionType.ALL
   */
  projectionType?: dynamodb.ProjectionType;

  /**
   * Non-key attributes to include in the projection (INCLUDE only)
   */
  nonKeyAttributes?: string[];

  /**
   * Read capacity units for the GSI (provisioned mode only)
   */
  readCapacity?: number;

  /**
   * Write capacity units for the GSI (provisioned mode only)
   */
  writeCapacity?: number;
}

/**
 * Configuration for DynamoDB table Local Secondary Index (LSI)
 */
export interface DynamoDbLsiConfig {
  /**
   * Name of the LSI
   */
  indexName: string;

  /**
   * Sort key attribute name for the LSI
   */
  sortKey: string;

  /**
   * Projection type for the LSI
   * @default ProjectionType.ALL
   */
  projectionType?: dynamodb.ProjectionType;

  /**
   * Non-key attributes to include in the projection (INCLUDE only)
   */
  nonKeyAttributes?: string[];
}

/**
 * Configuration for DynamoDB table Time To Live (TTL)
 */
export interface DynamoDbTtlConfig {
  /**
   * Attribute name for TTL (must be a number representing Unix epoch time in seconds)
   */
  attributeName: string;

  /**
   * Enable TTL
   * @default true
   */
  enabled?: boolean;
}

/**
 * Configuration for DynamoDB table attribute definitions
 */
export interface DynamoDbAttributeConfig {
  /**
   * Attribute name
   */
  name: string;

  /**
   * Attribute type
   */
  type: dynamodb.AttributeType;
}

/**
 * Properties for DynamoDbTableConstruct
 */
export interface DynamoDbTableConstructProps {
  /**
   * Environment name (e.g., 'development', 'production')
   * Used for resource naming and tagging
   */
  envName: string;

  /**
   * Project name (e.g., 'webapp', 'monitoring')
   * Used for resource naming and tagging
   */
  projectName: string;

  /**
   * Table name suffix
   * Final table name will be: `${projectName}-${tableName}-${envName}`
   * @example 'articles', 'users', 'sessions'
   */
  tableName: string;

  /**
   * Partition key attribute configuration
   */
  partitionKey: DynamoDbAttributeConfig;

  /**
   * Sort key attribute configuration (optional)
   */
  sortKey?: DynamoDbAttributeConfig;

  /**
   * Additional attribute definitions for GSIs/LSIs
   * Base table keys (partitionKey/sortKey) are automatically included
   */
  additionalAttributes?: DynamoDbAttributeConfig[];

  /**
   * Billing mode for the table
   * @default BillingMode.PAY_PER_REQUEST (on-demand)
   *
   * Cost Considerations:
   * - PAY_PER_REQUEST: Best for variable/unpredictable workloads, no capacity planning
   * - PROVISIONED: Best for steady, predictable workloads with auto-scaling
   */
  billingMode?: dynamodb.BillingMode;

  /**
   * Read capacity units (provisioned mode only)
   * @default undefined (uses on-demand pricing)
   */
  readCapacity?: number;

  /**
   * Write capacity units (provisioned mode only)
   * @default undefined (uses on-demand pricing)
   */
  writeCapacity?: number;

  /**
   * Enable point-in-time recovery (PITR)
   * @default false for non-production, true for production
   *
   * Cost: ~20% of table storage costs
   * Benefit: Restore to any point within last 35 days
   */
  pointInTimeRecovery?: boolean;

  /**
   * Enable server-side encryption with KMS
   * @default false (uses AWS managed keys instead)
   *
   * Cost Implications:
   * - AWS Managed (default): No additional cost
   * - Customer Managed KMS: $1/month + $0.03 per 10,000 requests
   *
   * Use customer managed KMS only if:
   * - Compliance requires customer control
   * - Cross-account access needed
   * - Audit trail of key usage required
   */
  encryption?: dynamodb.TableEncryption;

  /**
   * KMS key for encryption (required if encryption is CUSTOMER_MANAGED)
   */
  encryptionKey?: kms.IKey;

  /**
   * Global Secondary Indexes (GSIs)
   * Maximum: 20 per table
   */
  globalSecondaryIndexes?: DynamoDbGsiConfig[];

  /**
   * Local Secondary Indexes (LSIs)
   * Maximum: 5 per table
   * Must be created at table creation (cannot be added later)
   */
  localSecondaryIndexes?: DynamoDbLsiConfig[];

  /**
   * Time To Live (TTL) configuration
   * Automatically delete expired items at no additional cost
   */
  timeToLive?: DynamoDbTtlConfig;

  /**
   * Enable DynamoDB Streams
   * @default undefined (no streams)
   *
   * Stream view types:
   * - KEYS_ONLY: Only key attributes
   * - NEW_IMAGE: Entire item after modification
   * - OLD_IMAGE: Entire item before modification
   * - NEW_AND_OLD_IMAGES: Both before and after
   */
  stream?: dynamodb.StreamViewType;

  /**
   * Removal policy for the table
   * @default RemovalPolicy.RETAIN for production, DESTROY for non-production
   *
   * DESTROY: Table deleted when stack is destroyed (use for dev/test)
   * RETAIN: Table preserved when stack is destroyed (use for production)
   * SNAPSHOT: Create final snapshot before deletion (RDS only, not applicable)
   */
  removalPolicy?: cdk.RemovalPolicy;

  /**
   * Enable continuous backups for compliance
   * @default false
   *
   * Production Recommendation: Enable for critical tables
   * Creates automatic backups every 24 hours, retained for 35 days
   */
  enableBackups?: boolean;

  /**
   * Custom tags to apply to the table
   */
  tags?: Record<string, string>;

  /**
   * Enable deletion protection
   * @default true for production, false for non-production
   *
   * Prevents accidental table deletion via AWS Console/CLI/API
   * Must be explicitly disabled before deletion
   */
  deletionProtection?: boolean;

  /**
   * Enable contributor insights
   * @default false
   *
   * Cost: $0.01 per GB of writes
   * Benefit: Identify most accessed items and throttled requests
   */
  contributorInsights?: boolean;
}

/**
 * DynamoDbTableConstruct - Reusable DynamoDB table construct
 *
 * Creates a fully configured DynamoDB table with support for:
 * - Single table design (partition key + sort key)
 * - Global and Local Secondary Indexes
 * - Encryption (AWS managed or customer managed KMS)
 * - Point-in-time recovery (PITR)
 * - Time To Live (TTL)
 * - DynamoDB Streams
 * - Continuous backups
 * - Deletion protection
 * - CloudFormation exports
 *
 * Features:
 * - Automatic validation of configuration
 * - Cost-optimised defaults (on-demand billing, AWS managed encryption)
 * - Production-ready defaults (PITR, deletion protection)
 * - Consistent naming: `${projectName}-${tableName}-${envName}`
 * - Automatic tagging for resource management
 *
 * Cost Optimisation Strategy:
 * - Development/Staging: On-demand billing, no PITR, no backups
 * - Production: Consider provisioned capacity if predictable workload
 * - Use AWS managed encryption unless compliance requires otherwise
 * - Enable TTL to automatically delete expired items
 *
 * @example Basic Table
 * ```typescript
 * const table = new DynamoDbTableConstruct(this, 'ArticlesTable', {
 *   envName: 'production',
 *   projectName: 'webapp',
 *   tableName: 'articles',
 *   partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
 *   sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
 * });
 * ```
 *
 * @example Table with GSI and TTL
 * ```typescript
 * const table = new DynamoDbTableConstruct(this, 'ArticlesTable', {
 *   envName: 'production',
 *   projectName: 'webapp',
 *   tableName: 'articles',
 *   partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
 *   sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
 *   additionalAttributes: [
 *     { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
 *     { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
 *   ],
 *   globalSecondaryIndexes: [
 *     {
 *       indexName: 'gsi1',
 *       partitionKey: 'gsi1pk',
 *       sortKey: 'gsi1sk',
 *       projectionType: dynamodb.ProjectionType.ALL,
 *     },
 *   ],
 *   timeToLive: {
 *     attributeName: 'ttl',
 *     enabled: true,
 *   },
 *   stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
 * });
 * ```
 */
export class DynamoDbTableConstruct extends Construct {
  public readonly table: dynamodb.Table;
  public readonly tableArn: string;
  public readonly tableName: string;
  public readonly tableStreamArn?: string;

  constructor(
    scope: Construct,
    id: string,
    props: DynamoDbTableConstructProps
  ) {
    super(scope, id);

    // Validate inputs
    this.validateInputs(props);

    // Determine production defaults
    const isProduction = props.envName.toLowerCase() === "production";

    // Build table name: project-table-environment
    const fullTableName = `${props.projectName}-${props.tableName}-${props.envName}`;

    // Determine default settings based on environment
    const pointInTimeRecovery = props.pointInTimeRecovery ?? isProduction;
    const deletionProtection = props.deletionProtection ?? isProduction;
    const removalPolicy =
      props.removalPolicy ??
      (isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY);

    // Determine encryption configuration
    const encryption = props.encryption ?? dynamodb.TableEncryption.AWS_MANAGED;
    const encryptionKey = props.encryptionKey;

    // Validation: If CUSTOMER_MANAGED encryption is specified, key is required
    if (
      encryption === dynamodb.TableEncryption.CUSTOMER_MANAGED &&
      !encryptionKey
    ) {
      throw new Error(
        `KMS encryption key is required when using CUSTOMER_MANAGED encryption.\n\n` +
          `Either:\n` +
          `  1. Provide encryptionKey property\n` +
          `  2. Use AWS_MANAGED encryption (default)\n\n` +
          `Cost Consideration:\n` +
          `  AWS Managed: No additional cost\n` +
          `  Customer Managed: $1/month + $0.03 per 10,000 requests`
      );
    }

    // ========================================================================
    // CREATE DYNAMODB TABLE
    // ========================================================================

    // Build partition key
    const partitionKey: dynamodb.Attribute = {
      name: props.partitionKey.name,
      type: props.partitionKey.type,
    };

    // Build sort key if provided
    const sortKey: dynamodb.Attribute | undefined = props.sortKey
      ? {
          name: props.sortKey.name,
          type: props.sortKey.type,
        }
      : undefined;

    // Create the table
    this.table = new dynamodb.Table(this, "Table", {
      tableName: fullTableName,
      partitionKey,
      sortKey,
      billingMode: props.billingMode ?? dynamodb.BillingMode.PAY_PER_REQUEST,
      readCapacity: props.readCapacity,
      writeCapacity: props.writeCapacity,
      encryption,
      encryptionKey,
      pointInTimeRecoverySpecification: pointInTimeRecovery
        ? { pointInTimeRecoveryEnabled: true }
        : undefined,
      removalPolicy,
      deletionProtection,
      stream: props.stream,
      timeToLiveAttribute: props.timeToLive?.enabled
        ? props.timeToLive.attributeName
        : undefined,
      contributorInsightsSpecification: props.contributorInsights
        ? { enabled: true }
        : undefined,
    });

    this.tableArn = this.table.tableArn;
    this.tableName = this.table.tableName;
    this.tableStreamArn = this.table.tableStreamArn;

    // ========================================================================
    // ADD GLOBAL SECONDARY INDEXES (GSIs)
    // ========================================================================

    if (props.globalSecondaryIndexes && props.globalSecondaryIndexes.length > 0) {
      // Validate GSI limit
      if (props.globalSecondaryIndexes.length > 20) {
        throw new Error(
          `DynamoDB tables support a maximum of 20 Global Secondary Indexes.\n` +
            `Current configuration: ${props.globalSecondaryIndexes.length} GSIs\n\n` +
            `Consider:\n` +
            `  1. Consolidating indexes with composite sort keys\n` +
            `  2. Using sparse indexes (only items with the GSI key)\n` +
            `  3. Splitting data across multiple tables if needed`
        );
      }

      props.globalSecondaryIndexes.forEach((gsiConfig) => {
        const gsiPartitionKey: dynamodb.Attribute = {
          name: gsiConfig.partitionKey,
          type: this.getAttributeType(gsiConfig.partitionKey, props),
        };

        const gsiSortKey: dynamodb.Attribute | undefined = gsiConfig.sortKey
          ? {
              name: gsiConfig.sortKey,
              type: this.getAttributeType(gsiConfig.sortKey, props),
            }
          : undefined;

        this.table.addGlobalSecondaryIndex({
          indexName: gsiConfig.indexName,
          partitionKey: gsiPartitionKey,
          sortKey: gsiSortKey,
          projectionType:
            gsiConfig.projectionType ?? dynamodb.ProjectionType.ALL,
          nonKeyAttributes: gsiConfig.nonKeyAttributes,
          readCapacity: gsiConfig.readCapacity,
          writeCapacity: gsiConfig.writeCapacity,
        });
      });
    }

    // ========================================================================
    // ADD LOCAL SECONDARY INDEXES (LSIs)
    // ========================================================================

    if (props.localSecondaryIndexes && props.localSecondaryIndexes.length > 0) {
      // Validate LSI requirements
      if (!sortKey) {
        throw new Error(
          `Local Secondary Indexes require a sort key on the base table.\n\n` +
            `Current configuration: No sort key defined\n` +
            `Add a sortKey to DynamoDbTableConstructProps to use LSIs.`
        );
      }

      // Validate LSI limit
      if (props.localSecondaryIndexes.length > 5) {
        throw new Error(
          `DynamoDB tables support a maximum of 5 Local Secondary Indexes.\n` +
            `Current configuration: ${props.localSecondaryIndexes.length} LSIs\n\n` +
            `LSIs share the same partition key as the base table and provide an alternative sort key.\n` +
            `Consider using Global Secondary Indexes if you need more than 5 indexes.`
        );
      }

      props.localSecondaryIndexes.forEach((lsiConfig) => {
        const lsiSortKey: dynamodb.Attribute = {
          name: lsiConfig.sortKey,
          type: this.getAttributeType(lsiConfig.sortKey, props),
        };

        this.table.addLocalSecondaryIndex({
          indexName: lsiConfig.indexName,
          sortKey: lsiSortKey,
          projectionType:
            lsiConfig.projectionType ?? dynamodb.ProjectionType.ALL,
          nonKeyAttributes: lsiConfig.nonKeyAttributes,
        });
      });
    }

    // ========================================================================
    // APPLY TAGS
    // ========================================================================

    cdk.Tags.of(this.table).add("Environment", props.envName);
    cdk.Tags.of(this.table).add("Project", props.projectName);
    cdk.Tags.of(this.table).add("ManagedBy", "CDK");
    cdk.Tags.of(this.table).add("TableName", props.tableName);

    // Apply custom tags
    if (props.tags) {
      Object.entries(props.tags).forEach(([key, value]) => {
        cdk.Tags.of(this.table).add(key, value);
      });
    }

    // ========================================================================
    // COST OPTIMISATION METADATA
    // ========================================================================

    this.addCostMetadata(props, isProduction, pointInTimeRecovery);

    // ========================================================================
    // PRODUCTION WARNINGS
    // ========================================================================

    this.addProductionWarnings(props, isProduction);
  }

  /**
   * Get attribute type from configuration
   */
  private getAttributeType(
    attributeName: string,
    props: DynamoDbTableConstructProps
  ): dynamodb.AttributeType {
    // Check partition key
    if (attributeName === props.partitionKey.name) {
      return props.partitionKey.type;
    }

    // Check sort key
    if (props.sortKey && attributeName === props.sortKey.name) {
      return props.sortKey.type;
    }

    // Check additional attributes
    if (props.additionalAttributes) {
      const attr = props.additionalAttributes.find(
        (a) => a.name === attributeName
      );
      if (attr) {
        return attr.type;
      }
    }

    throw new Error(
      `Attribute type not found for: ${attributeName}\n\n` +
        `This attribute is used in a GSI or LSI but not defined in:\n` +
        `  - partitionKey\n` +
        `  - sortKey\n` +
        `  - additionalAttributes\n\n` +
        `Add the attribute to additionalAttributes array.`
    );
  }

  /**
   * Validate construct inputs
   */
  private validateInputs(props: DynamoDbTableConstructProps): void {
    // Validate environment name


    // Validate project name
    if (!props.projectName || props.projectName.trim().length === 0) {
      throw new Error(
        "Project name is required for DynamoDB table naming.\n\n" +
          'Valid project names: "webapp", "monitoring", "api"\n' +
          "Ensure projectName property is provided."
      );
    }

    // Validate table name
    if (!props.tableName || props.tableName.trim().length === 0) {
      throw new Error(
        "Table name suffix is required.\n\n" +
          'Examples: "articles", "users", "sessions"\n' +
          "This will be combined with project and environment: {project}-{table}-{env}"
      );
    }

    // Validate provisioned capacity configuration
    if (props.billingMode === dynamodb.BillingMode.PROVISIONED) {
      if (!props.readCapacity || !props.writeCapacity) {
        throw new Error(
          "Read and write capacity are required for PROVISIONED billing mode.\n\n" +
            "Either:\n" +
            "  1. Set billingMode: BillingMode.PAY_PER_REQUEST (recommended)\n" +
            "  2. Provide readCapacity and writeCapacity values\n\n" +
            "Cost Comparison:\n" +
            "  On-Demand: $1.25 per million write requests, $0.25 per million read requests\n" +
            "  Provisioned: $0.47 per WCU-month, $0.09 per RCU-month (with auto-scaling)"
        );
      }
    }

    // Validate partition key
    if (!props.partitionKey || !props.partitionKey.name) {
      throw new Error(
        "Partition key is required for DynamoDB table.\n\n" +
          "Example: partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }"
      );
    }

    // Validate TTL attribute if specified
    if (props.timeToLive && props.timeToLive.enabled) {
      if (!props.timeToLive.attributeName) {
        throw new Error(
          "TTL attribute name is required when TTL is enabled.\n\n" +
            "The TTL attribute must contain a Unix epoch timestamp in seconds.\n" +
            'Example: timeToLive: { attributeName: "ttl", enabled: true }'
        );
      }
    }
  }

  /**
   * Add cost optimisation metadata as CloudFormation metadata
   */
  private addCostMetadata(
    props: DynamoDbTableConstructProps,
    isProduction: boolean,
    pointInTimeRecovery: boolean
  ): void {
    const billingMode =
      props.billingMode ?? dynamodb.BillingMode.PAY_PER_REQUEST;
    const encryption = props.encryption ?? dynamodb.TableEncryption.AWS_MANAGED;

    const cfnTable = this.table.node.defaultChild as dynamodb.CfnTable;
    cfnTable.addMetadata("CostOptimisation", {
      BillingMode:
        billingMode === dynamodb.BillingMode.PAY_PER_REQUEST
          ? "On-Demand (variable cost)"
          : "Provisioned (predictable cost)",
      Encryption:
        encryption === dynamodb.TableEncryption.AWS_MANAGED
          ? "AWS Managed (no additional cost)"
          : "Customer Managed KMS ($1/month + request fees)",
      PointInTimeRecovery: pointInTimeRecovery
        ? "Enabled (~20% of storage cost)"
        : "Disabled (no backup cost)",
      DeletionProtection: isProduction
        ? "Enabled (production safety)"
        : "Disabled (allows cleanup)",
      Environment: props.envName,
    });
  }

  /**
   * Add production warnings for critical configurations
   */
  private addProductionWarnings(
    props: DynamoDbTableConstructProps,
    isProduction: boolean
  ): void {
    const stack = cdk.Stack.of(this);

    if (isProduction) {
      // Warn if PITR is disabled in production
      if (props.pointInTimeRecovery === false) {
        cdk.Annotations.of(stack).addWarning(
          `Production Warning: Point-in-time recovery is disabled for table: ${props.tableName}\n\n` +
            `Risk: No ability to restore table to any point within last 35 days\n` +
            `Recommendation: Enable PITR for production tables\n` +
            `Additional Cost: ~20% of table storage costs`
        );
      }

      // Warn if deletion protection is disabled in production
      if (props.deletionProtection === false) {
        cdk.Annotations.of(stack).addWarning(
          `Production Warning: Deletion protection is disabled for table: ${props.tableName}\n\n` +
            `Risk: Table can be accidentally deleted via AWS Console/CLI/API\n` +
            `Recommendation: Enable deletion protection for critical tables\n` +
            `Cost: No additional cost`
        );
      }

      // Warn if using on-demand billing without justification
      if (
        !props.billingMode ||
        props.billingMode === dynamodb.BillingMode.PAY_PER_REQUEST
      ) {
        cdk.Annotations.of(stack).addInfo(
          `Production Notice: Using on-demand billing for table: ${props.tableName}\n\n` +
            `On-demand is suitable for:\n` +
            `  - Variable/unpredictable workloads\n` +
            `  - New applications without usage patterns\n` +
            `  - Tables with spiky traffic\n\n` +
            `Consider provisioned billing with auto-scaling if:\n` +
            `  - Workload is steady and predictable\n` +
            `  - Can save 30-50% with capacity planning`
        );
      }
    }

    // Warn if using customer managed KMS unnecessarily
    if (props.encryption === dynamodb.TableEncryption.CUSTOMER_MANAGED) {
      cdk.Annotations.of(stack).addInfo(
        `Cost Notice: Using customer managed KMS encryption for table: ${props.tableName}\n\n` +
          `Additional Cost: $1/month + $0.03 per 10,000 requests\n` +
          `AWS managed encryption (default) is sufficient for most use cases.\n\n` +
          `Only use customer managed KMS if:\n` +
          `  - Compliance requires customer control of keys\n` +
          `  - Need cross-account access to data\n` +
          `  - Require audit trail of key usage (CloudTrail)`
      );
    }
  }
}
