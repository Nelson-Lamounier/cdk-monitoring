import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AmiRefreshConstruct } from '../../../../lib/constructs/events/ami-refresh/ami-refresh-construct';

function buildTemplate(): Template {
  const app = new cdk.App({
    context: { 'aws:cdk:bundling-stacks': [] },
  });
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'eu-west-1' },
  });
  new AmiRefreshConstruct(stack, 'AmiRefresh', {
    ssmPrefix: '/k8s/development',
    workerLtNames: ['k8s-dev-general-lt', 'k8s-dev-monitoring-lt'],
    workerAsgNames: ['k8s-dev-general-asg', 'k8s-dev-monitoring-asg'],
    controlPlaneLtName: 'k8s-dev-control-plane-lt',
    controlPlaneAsgName: 'k8s-dev-control-plane-asg',
  });
  return Template.fromStack(stack);
}

describe('AmiRefreshConstruct', () => {
  let template: Template;
  beforeAll(() => { template = buildTemplate(); });

  it('creates a Standard Step Functions state machine with X-Ray tracing and ALL-level logging', () => {
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineType: 'STANDARD',
      TracingConfiguration: { Enabled: true },
      LoggingConfiguration: Match.objectLike({
        Level: 'ALL',
        IncludeExecutionData: true,
      }),
    });
  });

  it('creates an EventBridge rule with correct SSM filter (suffix and operation)', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.ssm'],
        'detail-type': ['Parameter Store Change'],
        detail: {
          name: [{ suffix: '/golden-ami/latest' }],
          operation: ['Update'],
        },
      },
    });
  });

  it('writes worker lt-names SSM parameter', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/k8s/development/ami-refresh/workers/lt-names',
      Value: JSON.stringify(['k8s-dev-general-lt', 'k8s-dev-monitoring-lt']),
    });
  });

  it('writes worker asg-names SSM parameter', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/k8s/development/ami-refresh/workers/asg-names',
      Value: JSON.stringify(['k8s-dev-general-asg', 'k8s-dev-monitoring-asg']),
    });
  });

  it('writes control-plane lt-name SSM parameter', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/k8s/development/ami-refresh/control-plane/lt-name',
      Value: 'k8s-dev-control-plane-lt',
    });
  });

  it('writes control-plane asg-name SSM parameter', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/k8s/development/ami-refresh/control-plane/asg-name',
      Value: 'k8s-dev-control-plane-asg',
    });
  });

  it('creates at least three Lambda functions (update-lt, start-refresh, check-status)', () => {
    // Use >= 3 to tolerate any CDK-injected custom resource Lambdas (e.g. log retention)
    const lambdas = template.findResources('AWS::Lambda::Function');
    expect(Object.keys(lambdas).length).toBeGreaterThanOrEqual(3);
  });

  it('Lambda role has ec2:CreateLaunchTemplateVersion and ec2:ModifyLaunchTemplate permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'ec2:CreateLaunchTemplateVersion',
              'ec2:ModifyLaunchTemplate',
            ]),
          }),
        ]),
      },
    });
  });

  it('Lambda role has autoscaling:StartInstanceRefresh and autoscaling:DescribeInstanceRefreshes permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'autoscaling:StartInstanceRefresh',
              'autoscaling:DescribeInstanceRefreshes',
            ]),
          }),
        ]),
      },
    });
  });

  it('Lambda role has ssm:GetParameter permission', () => {
    // ssm:GetParameter may appear as a string (single action) or in an array;
    // use a custom matcher that handles both forms.
    const lambdaRolePolicies = template.findResources('AWS::IAM::Policy', {
      Properties: {
        Roles: Match.arrayWith([Match.objectLike({ Ref: Match.stringLikeRegexp('AmiRefreshLambdaRole') })]),
      },
    });
    const statements: unknown[] = Object.values(lambdaRolePolicies).flatMap(
      (r: any) => r.Properties.PolicyDocument.Statement as unknown[],
    );
    const hasSsmGet = statements.some((stmt: any) => {
      const action: string | string[] = stmt.Action;
      return Array.isArray(action)
        ? action.includes('ssm:GetParameter')
        : action === 'ssm:GetParameter';
    });
    expect(hasSsmGet).toBe(true);
  });
});
