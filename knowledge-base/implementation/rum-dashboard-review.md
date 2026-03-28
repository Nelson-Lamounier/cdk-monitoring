# Real User Monitoring (RUM) Dashboard Review

## 1. What is the RUM Dashboard Used For?

The Real User Monitoring (RUM) Dashboard is a cornerstone of modern frontend observability. Unlike traditional backend monitoring (which measures the server's perspective, such as CPU usage or database query time), RUM measures the application from the *user's perspective*. It tracks the precise performance metrics, visual stability, and unhandled JavaScript errors that real, live users encounter while interacting with the application in their web browsers or mobile devices.

## 2. Why Does RUM Matter?

Monitoring backend health exclusively creates a false sense of security. A backend API might respond in 50 milliseconds, but if a bloated JavaScript bundle takes 5 seconds to execute on an older mobile device, the user perceives the application as "broken." RUM bridges this gap:

* **True User Experience Perspective**: RUM captures exactly how hardware device types, varying network constraints, and different browser engines actually affect the rendering and interactivity of your web pages.
* **Capturing the "Invisible" Bugs**: If a React or Next.js component crashes due to a `TypeError` in the browser, the backend server typically never knows. RUM captures these raw errors and sends them centrally to Loki, allowing your team to fix silent UX failures that users may never report.
* **SEO & Google Search Rankings**: Search engines actively prioritize websites with excellent "Core Web Vitals." This dashboard visualizes the exact same metrics (LCP, INP, CLS) that Google leverages to grade your site's SEO value and organic search ranking.

## 3. Architecture & Under-the-Hood Design

The RUM flow utilizes a powerful three-tier architecture specifically designed for scalable frontend telemetry data ingestion:

1. **Grafana Faro Web SDK (The Emitter)** 
   This extremely lightweight, open-source JavaScript library is embedded into the frontend application code. It actively hooks into the browser's native API observers (`PerformanceObserver`) and global error handlers (`window.onerror`, `unhandledrejection`). When an end-user navigates the page, clicks a button, or triggers an error, Faro generates a highly-structured JSON payload containing the telemetry logic and securely transmits it over HTTP to your ingestion endpoint.

2. **Grafana Alloy (The Collector & Receiver)** 
   Operating centrally within your Kubernetes cluster, Grafana Alloy acts as the high-throughput ingestion entry point for external data. Configured with a dedicated `faro.receiver` endpoint block, Alloy listens to the incoming traffic from the users' browsers. It parses the payloads, applies configurable rate limits to prevent DOS attacks, attaches Kubernetes metadata (like source IP maps or custom structured labels), and securely distributes logs and payloads directly into the backend storage.

3. **Loki & Prometheus (The Storage)** 
   * **Loki**: Stores the structured JSON events (such as the JavaScript application errors, console proxy logs, and dynamic web-vitals measurements).
   * **Prometheus**: Tracks internal agent health metrics, capturing how much RAM Grafana Alloy currently consumes, and providing active throughput analytics (measuring precisely how many Faro requests are actively accepted or dropped by Alloy per second).

## 4. Breakdown of Each Metric

### Core Web Vitals (The Performance Pillars)
These metrics directly determine if your website feels "fast" and visually "stable" to users:

* **LCP (Largest Contentful Paint)** 
  * *What it measures*: How long it takes for the largest visual element on the screen (such as a massive hero banner or the primary article text block) to fully render.
  * *The Goal*: Complete rendering in less than **2.5 seconds**.

* **INP (Interaction to Next Paint)** 
  * *What it measures*: The application's interactivity responsiveness. It tracks the longest delay between a user executing an engagement (clicking an add-to-cart button, swiping, or typing on the keyboard) and the browser painting the resulting screen update.
  * *The Goal*: Respond to interactions in less than **200 milliseconds**.

* **CLS (Cumulative Layout Shift)** 
  * *What it measures*: Visual stability score. It calculates how much the visible pieces of content uncomfortably "jump" or shift around unexpectedly while the page is currently loading (for example, a banner loads late and violently pushes the reading text down right as a user starts reading).
  * *The Goal*: Maintain a score lower than **0.1**.

* **TTFB (Time to First Byte)**
  * *What it measures*: Server/network responsiveness. The strict time separating the moment a user initiates a navigation to your app, and the microsecond the browser successfully downloads the very first byte of the HTTP response.
  * *The Goal*: Time to First Byte should be below **800 milliseconds**.

* **FCP (First Contentful Paint)**
  * *What it measures*: How rapidly the browser succeeds in drawing the first piece of meaningful DOM content structurally visible on the screen (even if it's purely a spinning skeleton loader or a header block).
  * *The Goal*: Paint content in less than **1.8 seconds**.

### Client-Side Exceptions (JavaScript Errors)
These visuals map fatal crashes affecting the users, which backends alone cannot expose:

* **JS Errors (1h)**: A clean summary tally of the total volume of exceptions hitting users over the last 60 minutes.
* **Error Rate Over Time**: A detailed timeline making it exceptionally easy to immediately discern if a brand new deployment rollout triggered a massive spike in exceptions.
* **Recent JavaScript Errors**: A live query table printing the raw browser engine stack traces, error messages, and the precise URLs they were triggered from.
* **Errors by Type**: Identifies specific clusters of recurring bugs by analyzing the distributions of JavaScript Exception Types (isolating `ReferenceError` vs `SyntaxError` vs `Error`).

### Faro Collector Health
These metrics verify your telemetry infrastructure limits are not causing you to drop vital data:

* **Alloy Status**: Verifies whether the Grafana Alloy data-ingestion pipeline is actively UP or DOWN.
* **Alloy Memory (RSS)**: Tracks the RAM utilization of the Alloy container to ensure horizontal pod autoscalers might behave appropriately and the agent won't be killed due to out-of-memory (OOM) circumstances under massive traffic loads.
* **Faro Receiver Throughput**: Plots the amount of telemetry data payloads successfully "Accepted vs Dropped" per second. If Dropped payloads spike consistently, it clearly indicates either rate limits are being exceeded, or a chaotic bug in the frontend might be spamming the system with continuous logs.
