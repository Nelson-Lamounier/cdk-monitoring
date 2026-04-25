import {
  CreateLaunchTemplateVersionCommand,
  EC2Client,
  ModifyLaunchTemplateCommand,
} from '@aws-sdk/client-ec2';
import {
  AutoScalingClient,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

export interface UpdateLaunchTemplateEvent {
  paramName: string;
  role: 'workers' | 'control-plane';
}

export interface UpdateLaunchTemplateResult {
  role: string;
  env: string;
  amiId: string;
}

export async function handler(
  event: UpdateLaunchTemplateEvent,
  ec2Client: EC2Client = new EC2Client({}),
  ssmClient: SSMClient = new SSMClient({}),
  asgClient: AutoScalingClient = new AutoScalingClient({}),
): Promise<UpdateLaunchTemplateResult> {
  const env = event.paramName.split('/')[2];
  if (!env) throw new Error(`Cannot extract env from paramName: ${event.paramName}`);

  const amiParam = await ssmClient.send(new GetParameterCommand({ Name: event.paramName }));
  const amiId = amiParam.Parameter?.Value;
  if (!amiId) throw new Error(`SSM parameter ${event.paramName} has no value`);

  // SSM stores Launch Template *names* and ASG *names* (concrete strings, no CDK tokens).
  // CloudFormation rejects $Latest/$Default as ASG LT version, so CDK writes a pinned
  // version at synth. The Lambda updates the ASG via UpdateAutoScalingGroup API (which
  // does accept $Default at runtime) so new instances pick up the new LT version without
  // a CDK redeploy.
  const pairs = await getLtAsgPairs(env, event.role, ssmClient);

  for (const { ltName, asgName } of pairs) {
    const created = await ec2Client.send(new CreateLaunchTemplateVersionCommand({
      LaunchTemplateName: ltName,
      SourceVersion: '$Latest',
      LaunchTemplateData: { ImageId: amiId },
    }));
    const versionNumber = created.LaunchTemplateVersion?.VersionNumber;
    if (versionNumber == null) throw new Error(`CreateLaunchTemplateVersion returned no VersionNumber for ${ltName}`);
    const newVersion = String(versionNumber);

    await ec2Client.send(new ModifyLaunchTemplateCommand({
      LaunchTemplateName: ltName,
      DefaultVersion: newVersion,
    }));

    // Update ASG to reference $Default — AWS API allows this at runtime even though
    // CloudFormation forbids it in template resources.
    await asgClient.send(new UpdateAutoScalingGroupCommand({
      AutoScalingGroupName: asgName,
      LaunchTemplate: { LaunchTemplateName: ltName, Version: '$Default' },
    }));
  }

  return { role: event.role, env, amiId };
}

interface LtAsgPair {
  ltName: string;
  asgName: string;
}

async function getLtAsgPairs(env: string, role: string, ssmClient: SSMClient): Promise<LtAsgPair[]> {
  if (role === 'workers') {
    const [ltParam, asgParam] = await Promise.all([
      ssmClient.send(new GetParameterCommand({ Name: `/k8s/${env}/ami-refresh/workers/lt-names` })),
      ssmClient.send(new GetParameterCommand({ Name: `/k8s/${env}/ami-refresh/workers/asg-names` })),
    ]);
    const ltNames: string[] = JSON.parse(ltParam.Parameter?.Value ?? 'null');
    const asgNames: string[] = JSON.parse(asgParam.Parameter?.Value ?? 'null');
    if (!Array.isArray(ltNames) || !Array.isArray(asgNames) || ltNames.length !== asgNames.length) {
      throw new Error(`workers lt-names and asg-names must be non-empty arrays of equal length`);
    }
    return ltNames.map((ltName, i) => ({ ltName, asgName: asgNames[i] }));
  }
  const [ltParam, asgParam] = await Promise.all([
    ssmClient.send(new GetParameterCommand({ Name: `/k8s/${env}/ami-refresh/control-plane/lt-name` })),
    ssmClient.send(new GetParameterCommand({ Name: `/k8s/${env}/ami-refresh/control-plane/asg-name` })),
  ]);
  const ltName = ltParam.Parameter?.Value;
  const asgName = asgParam.Parameter?.Value;
  if (!ltName) throw new Error(`SSM /k8s/${env}/ami-refresh/control-plane/lt-name has no value`);
  if (!asgName) throw new Error(`SSM /k8s/${env}/ami-refresh/control-plane/asg-name has no value`);
  return [{ ltName, asgName }];
}
