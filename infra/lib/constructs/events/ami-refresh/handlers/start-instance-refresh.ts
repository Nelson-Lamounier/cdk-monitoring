import {
  AutoScalingClient,
  StartInstanceRefreshCommand,
} from '@aws-sdk/client-auto-scaling';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const asg = new AutoScalingClient({});
const ssm = new SSMClient({});

export interface StartInstanceRefreshEvent {
  paramName: string;
  role: 'workers' | 'control-plane';
}

export interface StartInstanceRefreshResult {
  role: string;
  env: string;
  refreshIds: Array<{ asgName: string; refreshId: string }>;
}

export async function handler(
  event: StartInstanceRefreshEvent,
): Promise<StartInstanceRefreshResult> {
  const env = event.paramName.split('/')[2];
  if (!env) throw new Error(`Cannot extract env from paramName: ${event.paramName}`);

  const asgNames = await getAsgNames(env, event.role);

  const refreshIds: Array<{ asgName: string; refreshId: string }> = [];
  for (const asgName of asgNames) {
    const resp = await asg.send(new StartInstanceRefreshCommand({
      AutoScalingGroupName: asgName,
      Preferences: { MinHealthyPercentage: 0, InstanceWarmup: 60 },
    }));
    const refreshId = resp.InstanceRefreshId;
    if (!refreshId) throw new Error(`StartInstanceRefresh returned no InstanceRefreshId for ${asgName}`);
    refreshIds.push({ asgName, refreshId });
  }

  return { role: event.role, env, refreshIds };
}

async function getAsgNames(env: string, role: string): Promise<string[]> {
  if (role === 'workers') {
    const p = await ssm.send(
      new GetParameterCommand({ Name: `/k8s/${env}/ami-refresh/workers/asg-names` }),
    );
    const val = p.Parameter?.Value;
    if (!val) throw new Error(`SSM parameter /k8s/${env}/ami-refresh/workers/asg-names has no value`);
    const parsed: unknown = JSON.parse(val);
    if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== 'string') {
      throw new Error(`SSM parameter /k8s/${env}/ami-refresh/workers/asg-names must be a non-empty JSON string array`);
    }
    return parsed as string[];
  }
  const p = await ssm.send(
    new GetParameterCommand({ Name: `/k8s/${env}/ami-refresh/control-plane/asg-name` }),
  );
  const val = p.Parameter?.Value;
  if (!val) throw new Error(`SSM parameter /k8s/${env}/ami-refresh/control-plane/asg-name has no value`);
  return [val];
}
