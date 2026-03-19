/**
 * @format
 * @nelsonlamounier/cdk-governance-aspects
 *
 * CDK Aspects for automated resource tagging and DynamoDB access governance.
 *
 * @packageDocumentation
 */

export {
    TaggingAspect,
    type TagConfig,
    type CostCentre,
} from './tagging-aspect';

export {
    EnforceReadOnlyDynamoDbAspect,
    type EnforceReadOnlyDynamoDbProps,
    DYNAMODB_WRITE_ACTIONS,
    DYNAMODB_ADMIN_ACTIONS,
    FORBIDDEN_DYNAMODB_ACTIONS,
} from './enforce-readonly-dynamodb-aspect';
