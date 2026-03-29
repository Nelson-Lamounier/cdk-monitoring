---
title: "Frontend Performance Dashboard Implementation"
doc_type: implementation
domain: observability
tags:
  - traefik
  - prometheus
  - grafana
  - frontend-performance
  - golden-signals
  - latency
  - sli
related_docs:
  - observability/observability-implementation.md
  - observability/rum-dashboard-review.md
  - frontend/frontend-integration.md
last_updated: "2026-03-28"
author: Nelson Lamounier
status: accepted
---

# Frontend Performance Implementation

**Last Updated:** 2026-03-28

## Overview

The **Frontend Performance Dashboard** provides a critical, server-side (edge) perspective of the Next.js application by aggregating metrics exposed by the Traefik Ingress Controller. 

Unlike the RUM (Real User Monitoring) dashboard that tracks client-side performance from the browser's perspective, this implementation focuses exclusively on network routing and Node.js server health. It monitors metrics such as `traefik_service_requests_total`, `traefik_service_request_duration_seconds_bucket`, and `traefik_service_open_connections`, specifically filtered for `service=~"nextjs-app.*"`.

## Purpose & Need

Next.js operates as a hybrid framework, handling both Static Site Generation (SSG) and Server-Side Rendering (SSR). This dashboard is necessary to monitor the health of the Node.js compute layer and the network routing leading to it, without relying on the client's browser to successfully load a page and send telemetry.

Without edge-level monitoring, any error that prevents the page from loading (such as a 502 Bad Gateway) creates a monitoring blind spot, as the client-side observability SDK (Faro) is never initialized.

## Key Capabilities

1. **Golden Signals Monitoring:** Captures Request Rates (RPS) and Error Rates at the ingress level before they reach the application instance.
2. **Service Level Indicators (SLIs):** Directly tracks overall "Frontend Availability" using the formula:
   ```math
   (1 - (sum(5xx errors) / sum(total requests))) * 100
   ```
3. **Latency Percentiles:** Uses Prometheus histogram quantiles to track P50, P95, and P99 request durations, reflecting pure server response times.
4. **Connection Health:** Displays active open connections and provides a clear breakdown of HTTP Status codes (distinguishing between 4xx and 5xx errors).

## Problems Resolved

### 1. Catching Connection Issues Early (The "Dead Client" Problem)
If the Node.js backend crashes or the network is misconfigured, a user's browser will receive a connection timeout or a `502 Bad Gateway`. The Faro RUM SDK will never initialize to report the error. This Traefik-based dashboard is the *only* way to detect early, critical failures that happen before rendering.

### 2. Separating Network Delay from Render Delay
When RUM reports terrible "Time To First Byte" (TTFB), it is often unclear whether the fault lies with the user's network or the server. 
* If this dashboard shows **low p95 Latency**, the server is fast, implying the client's network is the bottleneck.
* If this dashboard shows **high p95 Latency**, the Next.js server is the bottleneck (e.g., slow database queries during SSR).

### 3. Guiding Autoscaling (Capacity Planning)
By cross-referencing the "Request Rate" panel with the "Latency (p50/p95)" panels, operators can spot infrastructure saturation. If a spike in traffic causes a linear spike in p99 latency or open connections, it indicates that the current ReplicaSet is overwhelmed and the Horizontal Pod Autoscaler (HPA) must scale up the service.

### 4. Identifying Bot & Malicious Traffic
The "Status Code Distribution" separating 4xx versus 5xx errors is crucial. It helps isolate genuine application bugs and crashes (500s) from malicious scanners, vulnerability probes, or dead links (404s/403s) which RUM often fails to distinguish accurately.

## Transferable Skills Demonstrated

- **SLI/SLO definition** — deriving golden signals (latency, errors, traffic, saturation) from reverse proxy metrics
- **Prometheus metric modelling** — crafting rate(), histogram_quantile(), and label-based filtering
- **Grafana dashboard design** — building production-grade panels with variables, thresholds, and alerting
- **Edge observability** — instrumenting Traefik ingress controller for per-service visibility

## Summary

This document covers the Frontend Performance Dashboard, which provides server-side (edge) monitoring of the Next.js application by aggregating Traefik Ingress Controller metrics. It captures golden signals (request rate, error rate), SLIs (frontend availability), latency percentiles (P50, P95, P99), and connection health — filling the monitoring blind spot where client-side Faro RUM cannot detect pre-render failures.

## Keywords

traefik, prometheus, grafana, frontend-performance, golden-signals, latency, sli, request-rate, error-rate, ttfb, autoscaling
