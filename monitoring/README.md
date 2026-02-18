# Monitoring Stack (Prometheus + Grafana)

Docker Compose-based monitoring stack for EC2 deployment.

## Components

| Service        | Port | Description                      |
|----------------|------|----------------------------------|
| Prometheus     | 9090 | Metrics collection & alerting    |
| Grafana        | 3000 | Visualization & dashboards       |
| Node Exporter  | 9100 | EC2 host metrics                 |

## CDK Deployment (Recommended)

The monitoring stack is fully automated via CDK:

```typescript
// In your bin/app.ts
import { VpcStack } from '../lib/vpc-stack';
import { MonitoringSecurityGroupStack } from '../lib/monitoring-security-group-stack';
import { MonitoringEc2Stack } from '../lib/ec2-stack';

const vpcStack = new VpcStack(app, 'VpcStack');

const sgStack = new MonitoringSecurityGroupStack(app, 'MonitoringSecurityGroup', {
    vpc: vpcStack.vpc,
    trustedCidrs: ['YOUR_IP/32'],
});

new MonitoringEc2Stack(app, 'MonitoringEc2', {
    vpc: vpcStack.vpc,
    securityGroup: sgStack.securityGroup,
    grafanaAdminPassword: 'your-secure-password',
});
```

Deploy:
```bash
cdk deploy VpcStack MonitoringSecurityGroup MonitoringEc2
```

## Manual Deployment (Alternative)
```bash
# Install Docker
sudo yum update -y
sudo yum install -y docker
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker ec2-user

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

### 2. Configure
```bash
cp .env.example .env
# Edit .env with your credentials and EC2 public IP
```

### 3. Deploy
```bash
docker-compose up -d
```

### 4. Access
- **Grafana**: `http://<EC2_PUBLIC_IP>:3000`
- **Prometheus**: `http://<EC2_PUBLIC_IP>:9090`

## Security Considerations

> ⚠️ **Important**: Configure your EC2 Security Group to restrict access to ports 3000, 9090, and 9100.

### CDK Security Group Stack

A production-ready security group is available via CDK:

```typescript
import { MonitoringSecurityGroupStack } from '../lib/monitoring-security-group-stack';

new MonitoringSecurityGroupStack(app, 'MonitoringSecurityGroup', {
    vpc: vpcStack.vpc,
    trustedCidrs: [
        'YOUR_IP/32',           // Your home/office IP
        'OFFICE_CIDR/24',       // Office network
    ],
    allowSsh: true,
});
```

Deploy with:
```bash
cdk deploy MonitoringSecurityGroup
```

### Production Best Practices
- Use an Application Load Balancer with HTTPS
- Restrict inbound rules to trusted IPs only
- Change default Grafana credentials
- Use AWS Secrets Manager for credentials

## Adding Application Targets

Edit `prometheus/prometheus.yml` to add your application:

```yaml
scrape_configs:
  - job_name: 'my-app'
    static_configs:
      - targets: ['app-host:8080']
    metrics_path: /metrics
```

Then reload Prometheus:
```bash
docker-compose exec prometheus kill -HUP 1
```
