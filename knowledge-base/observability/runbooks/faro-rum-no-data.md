---
title: "Faro RUM No Data Troubleshooting"
doc_type: runbook
domain: observability
tags:
  - faro
  - rum
  - grafana
  - loki
  - alloy
  - troubleshooting
  - no-data
related_docs:
  - observability/rum-dashboard-review.md
  - observability/observability-implementation.md
last_updated: "2026-03-30"
author: Nelson Lamounier
status: accepted
---

# Runbook: Grafana Faro RUM Dashboard Shows "No Data"

**Last Updated:** 2026-03-30
**Operator:** Solo — infrastructure owner

## Trigger

The Real User Monitoring (RUM) dashboard in Grafana shows "No data" across all panels (Web Vitals, exceptions, logs), despite the frontend application actively sending telemetry via the Faro Web SDK to the `/faro/collect` endpoint.

## Diagnosis Steps

### 1. Verify Faro Endpoint Reachability

Check if the `/faro/collect` endpoint is accessible and correctly routed by Traefik to the Grafana Alloy receiver:
```bash
curl -I https://ops.nelsonlamounier.com/faro/collect
```
*A `405 Method Not Allowed` on a GET/HEAD request is expected and confirms the endpoint is reachable (Faro expects POST).*

### 2. Verify Alloy Pod Logs

Check if Alloy's `faro.receiver` component is running without errors:
```bash
kubectl logs deploy/alloy -n monitoring | grep faro
```
*Look for confirmation that the receiver started on port 12347.*

### 3. Check Loki for Faro Telemetry Streams

If the endpoint is up and Alloy is running, the issue is likely data ingestion or missing labels. Query Loki directly to see if Faro logs are arriving *without* the expected job label:
```bash
# Query for Faro payloads without specifying the job label
kubectl run loki-cli --image=grafana/logcli --rm -i --restart=Never -- \
  --addr=http://loki.monitoring.svc.cluster.local:3100 \
  query '{kind="exception"}' --limit=5
```
If logs are returned, but querying `{job="faro"}` returns nothing, the dashboard cannot find the data because it relies strictly on the `job="faro"` label.

### 4. Check CORS Preflight at Ingress

If the browser DevTools show the Faro SDK failing with CORS errors on `OPTIONS` preflight requests, the issue is at the Traefik ingress layer. The Alloy `cors_allowed_origins` only handles CORS for requests that *reach* the pod — Traefik may reject the preflight before it gets there.

Verify the IngressRoute has a CORS middleware:
```bash
kubectl get middleware -n monitoring alloy-cors -o yaml
```
If missing, create a Traefik `Middleware` resource that handles `OPTIONS` preflight:
```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: alloy-cors
  namespace: monitoring
spec:
  headers:
    accessControlAllowMethods: ["GET", "POST", "OPTIONS"]
    accessControlAllowOriginList:
      - "https://nelsonlamounier.com"
      - "https://www.nelsonlamounier.com"
    accessControlAllowHeaders: ["Content-Type", "x-faro-session-id"]
    accessControlMaxAge: 86400
```
Then reference it in the alloy IngressRoute's `routes[].middlewares` array.

## Root Cause

By default, the `faro.receiver` component in Grafana Alloy accepts telemetry payloads and forwards them to a `loki.write` component, but **it does not automatically inject the `job="faro"` label**.

When viewing the RUM dashboard JSON configuration under `kubernetes-app/platform/charts/monitoring/chart/dashboards/rum.json`, all PromQL and LogQL queries are strictly scoped to `{job="faro"}`:
```logql
avg_over_time({job="faro"} | json | kind="measurement" | measurement_type="web-vitals" ...)
```

Without this specific label on the ingested log streams, the RUM dashboards will show "No Data" even though Loki successfully stores the payloads.

## The Fix

To resolve this, intercept the output of `faro.receiver` with a `loki.process` component to inject the required static label before forwarding the stream to `loki.write`.

**1. Update the Alloy ConfigMap (`alloy-config`):**

In `kubernetes-app/platform/charts/monitoring/chart/templates/alloy/configmap.yaml`:

```alloy
    // --- Faro Receiver ---
    faro.receiver "default" {
      server {
        listen_address = "0.0.0.0"
        listen_port    = {{ .Values.alloy.service.faroPort }}
        cors_allowed_origins = [
          "https://nelsonlamounier.com",
          "https://www.nelsonlamounier.com",
        ]
      }

      output {
        // CHANGED: Route logs to the processor instead of directly to writer
        logs   = [loki.process.faro.receiver]
        traces = [otelcol.exporter.otlp.tempo.input]
      }
    }

    // --- Relabel Faro Logs ---
    // Inject the job="faro" static label required by the RUM dashboard queries
    loki.process "faro" {
      forward_to = [loki.write.default.receiver]
      
      stage.static_labels {
        values = {
          job = "faro",
        }
      }
    }
```

**2. Rollout the Change:**
Apply the updated Helm template to the cluster and restart the Alloy pod to force a configuration reload:
```bash
helm template monitoring ./kubernetes-app/platform/charts/monitoring/chart -n monitoring -s templates/alloy/configmap.yaml | kubectl apply -f -
kubectl delete pod -n monitoring -l app=alloy
```

## Validation

Simulate a client telemetry payload using cURL:
```bash
curl -X POST -H "Content-Type: application/json" -d '{
  "meta": {
    "browser": { "name": "Chrome", "version": "100" }
  },
  "logs": [
    {
      "message": "Faro test log",
      "level": "info",
      "timestamp": "2026-03-28T19:15:00.000Z"
    }
  ]
}' https://ops.nelsonlamounier.com/faro/collect
```

Query Loki for `{job="faro"}`:
```bash
kubectl run loki-cli --image=grafana/logcli --rm -i --restart=Never -- \
  --addr=http://loki.monitoring.svc.cluster.local:3100 \
  query '{job="faro"}' --limit=1
```
The output should now display the test log along with the `job="faro"` label. The RUM dashboard will immediately reflect the ingested measurements and exceptions.

## Transferable Skills Demonstrated

- **End-to-end telemetry debugging** — tracing data flow from browser SDK through Alloy pipeline to Loki/Grafana
- **Log format analysis** — identifying logfmt vs JSON mismatches in panel queries
- **Kubernetes ConfigMap management** — live-patching Alloy collector configuration
- **Dashboard query engineering** — writing LogQL and PromQL queries for real-user monitoring

## Summary

This runbook provides step-by-step diagnosis for missing RUM data in Grafana dashboards: verifying Faro SDK initialisation, checking Alloy collector health, validating Loki log ingestion, and fixing pipeline configuration gaps between the frontend telemetry and the Grafana query layer.

## Keywords

faro, rum, grafana, loki, alloy, troubleshooting, no-data, logfmt, ingressroute, web-sdk, telemetry-pipeline
