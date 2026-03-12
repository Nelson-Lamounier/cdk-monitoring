/** @format */

/**
 * CloudFormation Custom Resource Response Utility
 *
 * Shared utility for sending responses back to CloudFormation
 * from Lambda-backed Custom Resources.
 */

import * as https from "https";
import * as url from "url";

import {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceResponse,
  Context,
} from "aws-lambda";

/**
 * Send response to CloudFormation
 *
 * @param event - CloudFormation Custom Resource event
 * @param context - Lambda context
 * @param response - Response to send
 */
export async function sendCfnResponse(
  event: CloudFormationCustomResourceEvent,
  context: Context,
  response: CloudFormationCustomResourceResponse
): Promise<void> {
  const responseBody = JSON.stringify({
    Status: response.Status,
    Reason:
      response.Reason ||
      `See CloudWatch Logs: ${context.logGroupName} / ${context.logStreamName}`,
    PhysicalResourceId: response.PhysicalResourceId || context.logStreamName,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: response.Data || {},
  });

  console.log("Sending CloudFormation response:", responseBody);

  const parsedUrl = url.parse(event.ResponseURL);
  const options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.path,
    method: "PUT",
    headers: {
      "content-type": "",
      "content-length": Buffer.byteLength(responseBody),
    },
  };

  await new Promise<void>((resolve, reject) => {
    const req = https.request(options, (res) => {
      console.log(`CloudFormation response status: ${res.statusCode}`);
      res.on("data", () => undefined);
      res.on("end", () => {
        console.log("CloudFormation response sent successfully");
        resolve();
      });
    });

    req.on("error", (err) => {
      console.error("Failed to send CloudFormation response:", err);
      reject(err);
    });

    req.write(responseBody);
    req.end();
  });
}

/**
 * Create a success response for CloudFormation
 *
 * @param event - CloudFormation Custom Resource event
 * @param physicalResourceId - Physical resource ID
 * @param data - Additional data to return
 */
export function createSuccessResponse(
  event: CloudFormationCustomResourceEvent,
  physicalResourceId: string,
  data?: Record<string, unknown>
): CloudFormationCustomResourceResponse {
  return {
    Status: "SUCCESS",
    PhysicalResourceId: physicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data || {},
  };
}

/**
 * Create a failure response for CloudFormation
 *
 * @param event - CloudFormation Custom Resource event
 * @param error - Error object or message string
 * @param defaultPhysicalId - Default physical resource ID if not present in event
 * @returns CloudFormation failure response
 */
export function createFailureResponse(
  event: CloudFormationCustomResourceEvent,
  error: Error | string,
  defaultPhysicalId: string
): CloudFormationCustomResourceResponse {
  const physicalResourceId =
    "PhysicalResourceId" in event && event.PhysicalResourceId
      ? event.PhysicalResourceId
      : defaultPhysicalId;

  const reason = error instanceof Error ? error.message : String(error);

  return {
    Status: "FAILED",
    Reason: reason,
    PhysicalResourceId: physicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: {},
  };
}
