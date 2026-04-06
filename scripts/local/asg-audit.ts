import {AutoScalingClient, DescribeAutoScalingGroupsCommand} from '@aws-sdk/client-auto-scaling';
import { CloudWatchClient, ListDashboardsCommand, GetDashboardCommand} from '@aws-sdk/client-cloudwatch';
import {DescribeParametersCommand, SSMClient} from '@aws-sdk/client-ssm';
import {EC2Client, DescribeVolumesCommand} from '@aws-sdk/client-ec2';
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import { LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { CloudFrontClient, ListDistributionsCommand } from "@aws-sdk/client-cloudfront";
import { SFNClient, ListStateMachinesCommand } from "@aws-sdk/client-sfn";


import { parseArgs, buildAwsConfig } from '../lib/aws-helpers.js';




const args = parseArgs(
    [
        { name: 'env', description: 'Environment: development, staging, production', hasValue: true, default: 'development' },
        { name: 'profile', description: 'AWS CLI profile', hasValue: true },
        { name: 'region', description: 'AWS region', hasValue: true, default: 'eu-west-1' },
    ],
    'Audit Auto Scaling Groups — list all ASGs and detail those without subscriptions',
)
 interface ASGDetail {
    arn: string;
    name: string; 
    tags: string; 
 } 

interface DashboardDetail {
    dashboardName: string;
    dashboardArn: string;
    monitoredAsgs: string[];
    monitoredNlbs: string[];
    monitoredLambdas: string[];
    monitoredCloudFront: string[];
    monitoredStateMachines: string[];
}

interface ParameterDetail {
    name: string;
    value: string;
}

interface EbsVolumeDetail {
    volumeId: string;
    size: number;
    state: string; 
    stackNameOrName: string; // Renaming to represent the fallback logic
    lifecycle: string;
    tags: string;
}

const listCloudFormationEbsVolumes = async (client: EC2Client): Promise<EbsVolumeDetail[]> => {
    const volumes: EbsVolumeDetail[] = [];
    let nextToken: string | undefined;

    do {
        const response = await client.send(
            new DescribeVolumesCommand({
                // This filter tells AWS: "Only return volumes tagged with managed-by=cdk"
                // AND that are currently 'in-use' or 'available'
                Filters: [
                    {
                        Name: 'tag:managed-by',
                        Values: ['cdk'],
                    },
                    {
                        Name: 'status',
                        Values: ['in-use', 'available'],
                    }
                ],
                NextToken: nextToken,
            }),
        );
        nextToken = response.NextToken;

        for (const volume of response.Volumes ?? []) {
            const parsedTags = (volume.Tags ?? []).reduce((acc, tag) => {
                if (tag.Key && tag.Value) {
                    acc[tag.Key] = tag.Value;
                }
                return acc;
            }, {} as Record<string, string>);

            // Safely check if the volume will be deleted when the instance terminates
            let lifecycle = 'Permanent (Unattached)';
            if (volume.Attachments && volume.Attachments.length > 0) {
                if (volume.Attachments[0].DeleteOnTermination) {
                    lifecycle = 'Ephemeral (DeleteOnTermination)';
                } else {
                    lifecycle = 'Permanent (Attached)';
                }
            }

            volumes.push({
                volumeId: volume.VolumeId ?? 'UNKNOWN_ID',
                size: volume.Size ?? 0,
                state: volume.State ?? 'UNKNOWN_STATE',
                // Use CFN Stack Name if present, otherwise fallback to the instances Name tag
                stackNameOrName: parsedTags['aws:cloudformation:stack-name'] ?? parsedTags['Name'] ?? 'UNKNOWN_SOURCE',
                lifecycle: lifecycle,
                tags: Object.entries(parsedTags)
                    .filter(([k]) => !['managed-by', 'cost-centre', 'owner', 'version', 'project', 'component', 'Name', 'aws:cloudformation:stack-name', 'aws:cloudformation:logical-id'].includes(k))
                    .map(([k, v]) => `${k}=${v}`).join(', ') || 'Standard Tags Only',
            });
        }
    } while (nextToken);
    return volumes;
}
    
    

 const listAllASGs = async (client: AutoScalingClient): Promise<ASGDetail[]> => {
    const asgs: ASGDetail[] = [];
    let nextToken: string | undefined;
    do {
        const response = await client.send(
            new DescribeAutoScalingGroupsCommand({ NextToken: nextToken }),
        );
        nextToken = response.NextToken;

        for (const asg of response.AutoScalingGroups ?? []) {

            // 1. Convert AWs Tag Array -> Clean Key/Value 
            const parsedTags = (asg.Tags ?? []).reduce((acc, tag) => {
                if (tag.Key && tag.Value) {
                    acc[tag.Key] = tag.Value;
                }
                return acc;
            }, {} as Record<string, string>);

            // 2. Push to array
            asgs.push({
                arn: asg.AutoScalingGroupARN ?? 'UNKNOWN_ARN',
                name: asg.AutoScalingGroupName ?? 'UNKNOWN_NAME',
                tags: Object.entries(parsedTags)
                     .filter(([k]) => !['managed-by', 'cost-centre', 'owner', 'version', 'project', 'component', 'Name', 'aws:cloudformation:stack-name', 'aws:cloudformation:logical-id'].includes(k))
                     .map(([k, v]) => `${k}=${v}`).join(', ') || 'Standard Tags Only',
            });
        }
    } while (nextToken);
    return asgs;
 }

 const listAllNlbs = async (client: ElasticLoadBalancingV2Client): Promise<string[]> => {
    const nlbs: string[] = [];
    let nextToken: string | undefined;
    do {
        const res = await client.send(new DescribeLoadBalancersCommand({ Marker: nextToken }));
        nextToken = res.NextMarker;
        for (const lb of res.LoadBalancers ?? []) {
            if (lb.Type === 'network' && lb.LoadBalancerArn) {
                // Extracts "net/name/id" from "arn:aws:...:loadbalancer/net/name/id"
                const parts = lb.LoadBalancerArn.split('loadbalancer/');
                if (parts.length === 2) {
                    nlbs.push(parts[1]);
                }
            }
        }
    } while (nextToken);
    return nlbs;
 }

 const listAllLambdas = async (client: LambdaClient): Promise<string[]> => {
    const lambdas: string[] = [];
    let nextToken: string | undefined;
    do {
        const res = await client.send(new ListFunctionsCommand({ Marker: nextToken }));
        nextToken = res.NextMarker;
        for (const fn of res.Functions ?? []) {
            if (fn.FunctionName) lambdas.push(fn.FunctionName);
        }
    } while (nextToken);
    return lambdas;
 }

 const listAllCloudFronts = async (client: CloudFrontClient): Promise<string[]> => {
    const distros: string[] = [];
    let nextToken: string | undefined;
    do {
        const res = await client.send(new ListDistributionsCommand({ Marker: nextToken }));
        nextToken = res.DistributionList?.NextMarker;
        for (const dist of res.DistributionList?.Items ?? []) {
            if (dist.Id) distros.push(dist.Id);
        }
    } while (nextToken);
    return distros;
 }

 const listAllStateMachines = async (client: SFNClient): Promise<string[]> => {
    const sfns: string[] = [];
    let nextToken: string | undefined;
    do {
        const res = await client.send(new ListStateMachinesCommand({ nextToken }));
        nextToken = res.nextToken;
        for (const sfn of res.stateMachines ?? []) {
            if (sfn.stateMachineArn) sfns.push(sfn.stateMachineArn);
        }
    } while (nextToken);
    return sfns;
 }

 const listParemeters = async (client: SSMClient): Promise<ParameterDetail[]> => {
    const parameters: ParameterDetail[] = [];
    let nextToken: string | undefined;
    do {
        const response = await client.send(
            new DescribeParametersCommand({
                NextToken: nextToken }),
        );
        nextToken = response.NextToken;

        for (const parameter of response.Parameters ?? []) {
            parameters.push({
                name: parameter.Name ?? 'UNKNOWN_NAME',
                value: 'VALUE_HIDDEN_BY_DESCRIBE',
            });
        }
    } while (nextToken);
    return parameters;
 }

 const listAllDashboards = async (client: CloudWatchClient): Promise<DashboardDetail[]> => {
    const dashboards: DashboardDetail[] = [];
    let nextToken: string | undefined;

    do {
        // 1. LIST the dashboards
        const response = await client.send(
            new ListDashboardsCommand({ NextToken: nextToken }),
        );
        nextToken = response.NextToken;

        // 2. Loop through the list
        for (const dashboard of response.DashboardEntries ?? []) {

            // 3. GET the dashboard body
            const name = dashboard.DashboardName ?? "UNKNOWN_NAME";

            try {
                // The script pauses until AWS returns the body
                const detail = await client.send(
                    new GetDashboardCommand({ DashboardName: name }),
                );
                const bodyStr = detail.DashboardBody ?? "{}";

                // PARSE the body
                const bodyStructure = JSON.parse(bodyStr);
                
                // Track sets to avoid duplicates
                const asgSet = new Set<string>();
                const nlbSet = new Set<string>();
                const cloudFrontSet = new Set<string>();
                const lambdaSet = new Set<string>();
                const stateMachineSet = new Set<string>();

                for(const widget of bodyStructure.widgets ?? []) {
                    const metrics = widget.properties?.metrics ?? [];
                 
                    for(const metricRow of metrics) {
                        for (let i = 0; i < metricRow.length; i++) {
                            const val = metricRow[i];
                            if (val === 'AutoScalingGroupName') asgSet.add(metricRow[i+1]);
                            else if (val === 'LoadBalancer') nlbSet.add(metricRow[i+1]);
                            else if (val === 'DistributionId') cloudFrontSet.add(metricRow[i+1]);
                            else if (val === 'FunctionName') lambdaSet.add(metricRow[i+1]);
                            else if (val === 'StateMachineArn') stateMachineSet.add(metricRow[i+1]);
                        }
                    }
                }

                dashboards.push({
                    dashboardName: name,
                    dashboardArn: dashboard.DashboardArn ?? 'UNKNOWN_ARN',
                    monitoredAsgs: Array.from(asgSet),
                    monitoredNlbs: Array.from(nlbSet),
                    monitoredCloudFront: Array.from(cloudFrontSet),
                    monitoredLambdas: Array.from(lambdaSet),
                    monitoredStateMachines: Array.from(stateMachineSet),
                });

            } catch (error) {
                console.error(`Failed to fetch body for ${name}:`, error);
            }
        }
    } while (nextToken);
    return dashboards;
 }

 interface OrphanReport {
    OrphanASGs: string[];
    OrphanNLBs: string[];
    OrphanLambdas: string[];
    OrphanCloudFronts: string[];
    OrphanStateMachines: string[];
 }

 const auditComprehensiveCoverage = (
    asgs: ASGDetail[], 
    nlbs: string[], 
    lambdas: string[], 
    cloudFronts: string[], 
    stateMachines: string[], 
    dashboards: DashboardDetail[]
 ): OrphanReport => {
    const monitoredAsgs = new Set<string>();
    const monitoredNlbs = new Set<string>();
    const monitoredLambdas = new Set<string>();
    const monitoredCloudFronts = new Set<string>();
    const monitoredStateMachines = new Set<string>();

    for (const d of dashboards) {
        d.monitoredAsgs.forEach(a => monitoredAsgs.add(a));
        d.monitoredNlbs.forEach(n => monitoredNlbs.add(n));
        d.monitoredLambdas.forEach(l => monitoredLambdas.add(l));
        d.monitoredCloudFront.forEach(c => monitoredCloudFronts.add(c));
        d.monitoredStateMachines.forEach(s => monitoredStateMachines.add(s));
    }

    return {
        OrphanASGs: asgs.filter(a => !monitoredAsgs.has(a.name)).map(a => a.name),
        OrphanNLBs: nlbs.filter(n => !monitoredNlbs.has(n)),
        // Exclude standard CDK Custom Resource lambdas
        OrphanLambdas: lambdas.filter(l => !monitoredLambdas.has(l) && !l.includes('awscdk') && !l.includes('CustomResource') && !l.includes('LogRetention')),
        OrphanCloudFronts: cloudFronts.filter(c => !monitoredCloudFronts.has(c)),
        OrphanStateMachines: stateMachines.filter(s => !monitoredStateMachines.has(s)),
    };
 };
    

 const printHeader = (title: string) => {
    console.log('\n================================================');
    // Align text closer to center dynamically depending on string length
    const padding = Math.max(0, Math.floor((48 - title.length) / 2));
    console.log(' '.repeat(padding) + title);
    console.log('================================================\n');
 };

 const printTree = (prefixBadge: string, nodeName: string, properties: Record<string, string | string[]>) => {
    console.log(`${prefixBadge} \x1b[36m${nodeName}\x1b[0m`);
    
    const entries = Object.entries(properties);
    // Automatically find the longest key word so the colons always perfectly align!
    const maxKeyLen = Math.max(0, ...entries.map(([k]) => k.length));
    
    entries.forEach(([key, value], index) => {
        const isLast = index === entries.length - 1;
        const treeBranch = isLast ? '   └─ ' : '   ├─ ';
        
        const paddedKey = key.padEnd(maxKeyLen, ' ');
        const displayValue = Array.isArray(value) 
            ? (value.join(', ') || 'None')
            : (value || 'None');
            
        console.log(`${treeBranch}${paddedKey}: ${displayValue}`);
    });
    console.log('');
};

 const main = async () => {
    try {
        const config = buildAwsConfig(args);

        const ec2Client = new EC2Client({
            region: config.region,
            credentials: config.credentials,
        });

        const asgClient = new AutoScalingClient({
        region: config.region,
        credentials: config.credentials})

        const dashboardClient = new CloudWatchClient({
            region: config.region,
            credentials: config.credentials})

        const ssmClient = new SSMClient({
            region: config.region,
            credentials: config.credentials})

        const elbClient = new ElasticLoadBalancingV2Client({ region: config.region, credentials: config.credentials });
        const lambdaClient = new LambdaClient({ region: config.region, credentials: config.credentials });
        const cloudFrontClient = new CloudFrontClient({ region: config.region, credentials: config.credentials });
        const sfnClient = new SFNClient({ region: config.region, credentials: config.credentials });

        const [asgResult, dashboardResult, parameterResult, ebsResult, nlbResult, lambdaResult, cloudFrontResult, sfnResult] = await Promise.all([
            listAllASGs(asgClient),
            listAllDashboards(dashboardClient),
            listParemeters(ssmClient),
            listCloudFormationEbsVolumes(ec2Client),
            listAllNlbs(elbClient),
            listAllLambdas(lambdaClient),
            listAllCloudFronts(cloudFrontClient),
            listAllStateMachines(sfnClient)
        ]);

        printHeader('EBS Volumes (CloudFormation)');
        console.table(ebsResult);

        printHeader('Auto Scaling Groups');
        console.table(asgResult);

        printHeader('CloudWatch Dashboards');
        for (const d of dashboardResult) {
            printTree('📊 Dashboard:', d.dashboardName, {
                'ASGs': d.monitoredAsgs,
                'NLBs': d.monitoredNlbs,
                'Lambdas': d.monitoredLambdas,
                'CloudFront': d.monitoredCloudFront,
                'StepFunctions': d.monitoredStateMachines
            });
        }

        printHeader('SSM Parameters');
        console.table(parameterResult);

        const orphans = auditComprehensiveCoverage(asgResult, nlbResult, lambdaResult, cloudFrontResult, sfnResult, dashboardResult);

        printHeader('Unmonitored Orphan Resources');
        
        const hasOrphans =
            orphans.OrphanASGs.length > 0 ||
            orphans.OrphanNLBs.length > 0 ||
            orphans.OrphanLambdas.length > 0 ||
            orphans.OrphanCloudFronts.length > 0 ||
            orphans.OrphanStateMachines.length > 0;

        if (hasOrphans) {
            printTree('🚨 WARNING:', 'Missing Dashboard Integrations', {
                'ASGs': orphans.OrphanASGs,
                'NLBs': orphans.OrphanNLBs,
                'Lambdas': orphans.OrphanLambdas,
                'CloudFront': orphans.OrphanCloudFronts,
                'StepFunctions': orphans.OrphanStateMachines
            });
        } else {
            console.log('✅ Incredible! All resources (ASGs, NLBs, Lambdas, CloudFront Distros, StateMachines) are safely monitored!');
        }
        
    } catch (error) {
        console.error("Script failed:", error);
        process.exit(1);
    }
 }

 main();
 
