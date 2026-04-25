import {
  CreateLaunchTemplateVersionCommand,
  EC2Client,
  ModifyLaunchTemplateCommand,
} from '@aws-sdk/client-ec2';
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
): Promise<UpdateLaunchTemplateResult> {
  const env = event.paramName.split('/')[2];
  if (!env) throw new Error(`Cannot extract env from paramName: ${event.paramName}`);

  const amiParam = await ssmClient.send(new GetParameterCommand({ Name: event.paramName }));
  const amiId = amiParam.Parameter?.Value;
  if (!amiId) throw new Error(`SSM parameter ${event.paramName} has no value`);

  // SSM stores Launch Template *names* (concrete strings, no CDK cross-stack token).
  // The EC2 API accepts LaunchTemplateName wherever LaunchTemplateId is accepted.
  const ltNames = await getLtNames(env, event.role, ssmClient);

  for (const ltName of ltNames) {
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
  }

  return { role: event.role, env, amiId };
}

async function getLtNames(env: string, role: string, ssmClient: SSMClient): Promise<string[]> {
  if (role === 'workers') {
    const p = await ssmClient.send(
      new GetParameterCommand({ Name: `/k8s/${env}/ami-refresh/workers/lt-names` }),
    );
    const val = p.Parameter?.Value;
    if (!val) throw new Error(`SSM parameter /k8s/${env}/ami-refresh/workers/lt-names has no value`);
    return JSON.parse(val);
  }
  const p = await ssmClient.send(
    new GetParameterCommand({ Name: `/k8s/${env}/ami-refresh/control-plane/lt-name` }),
  );
  const val = p.Parameter?.Value;
  if (!val) throw new Error(`SSM parameter /k8s/${env}/ami-refresh/control-plane/lt-name has no value`);
  return [val];
}
