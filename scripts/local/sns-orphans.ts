#!/usr/bin/env tsx
/**
 * SNS Orphan Topic Audit
 *
 * Lists all SNS topics in a region and identifies those without subscriptions.
 * For orphan topics, provides detailed metadata: owner, encryption, FIFO status, and tags.
 *
 * Usage:
 *   Local: npx tsx scripts/local/sns-orphans.ts --env development --profile dev-account
 *   CI:    npx tsx scripts/local/sns-orphans.ts --env development
 */

import {
  SNSClient,
  ListTopicsCommand,
  ListSubscriptionsByTopicCommand,
  GetTopicAttributesCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-sns'
import type { Topic, Tag } from '@aws-sdk/client-sns'
import * as log from '../lib/logger.js'
import { startFileLogging, stopFileLogging } from '../lib/logger.js'
import { parseArgs, buildAwsConfig, resolveAuth } from '../lib/aws-helpers.js'
import type { AwsConfig } from '../lib/aws-helpers.js'

// ========================================
// CLI Arguments
// ========================================

const args = parseArgs(
  [
    { name: 'env', description: 'Environment: development, staging, production', hasValue: true, default: 'development' },
    { name: 'profile', description: 'AWS CLI profile', hasValue: true },
    { name: 'region', description: 'AWS region', hasValue: true, default: 'eu-west-1' },
  ],
  'Audit SNS topics — list all topics and detail those without subscriptions',
)

// ========================================
// Types
// ========================================

/** Summary of a single SNS topic with subscription count */
interface TopicSummary {
  /** The SNS topic ARN */
  arn: string
  /** Short name extracted from the ARN */
  name: string
  /** Number of confirmed subscriptions */
  subscriptionCount: number
}

/** Detailed metadata for an orphan topic */
interface OrphanDetail {
  /** The SNS topic ARN */
  arn: string
  /** Short name extracted from the ARN */
  name: string
  /** AWS account ID that owns the topic */
  owner: string
  /** Optional display name configured on the topic */
  displayName: string
  /** KMS key ID for encryption, or empty if using default */
  kmsKeyId: string
  /** Whether the topic is a FIFO topic */
  isFifo: boolean
  /** Tags attached to the topic */
  tags: Tag[]
}

// ========================================
// Core Logic
// ========================================

/**
 * Fetch all SNS topic ARNs in the region, handling pagination.
 *
 * @param client - The SNS SDK client
 * @returns Array of Topic objects
 */
async function listAllTopics(client: SNSClient): Promise<Topic[]> {
  const topics: Topic[] = []
  let nextToken: string | undefined

  do {
    const response = await client.send(
      new ListTopicsCommand({ NextToken: nextToken }),
    )
    if (response.Topics) {
      topics.push(...response.Topics)
    }
    nextToken = response.NextToken
  } while (nextToken)

  return topics
}

/**
 * Count the number of subscriptions for a given topic.
 *
 * @param client - The SNS SDK client
 * @param topicArn - The ARN of the topic to check
 * @returns The number of subscriptions
 */
async function countSubscriptions(client: SNSClient, topicArn: string): Promise<number> {
  const response = await client.send(
    new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }),
  )
  return response.Subscriptions?.length ?? 0
}

/**
 * Fetch detailed attributes and tags for an orphan topic.
 *
 * @param client - The SNS SDK client
 * @param topicArn - The ARN of the topic
 * @param topicName - The short name of the topic
 * @returns Detailed orphan metadata
 */
async function getOrphanDetail(
  client: SNSClient,
  topicArn: string,
  topicName: string,
): Promise<OrphanDetail> {
  const [attrsResponse, tagsResponse] = await Promise.all([
    client.send(new GetTopicAttributesCommand({ TopicArn: topicArn })),
    client.send(new ListTagsForResourceCommand({ ResourceArn: topicArn })),
  ])

  const attrs = attrsResponse.Attributes ?? {}

  return {
    arn: topicArn,
    name: topicName,
    owner: attrs['Owner'] ?? 'N/A',
    displayName: attrs['DisplayName'] ?? '',
    kmsKeyId: attrs['KmsMasterKeyId'] ?? '',
    isFifo: attrs['FifoTopic'] === 'true',
    tags: tagsResponse.Tags ?? [],
  }
}

/**
 * Extract the short topic name from a full ARN.
 *
 * @param arn - The full SNS topic ARN
 * @returns The portion after the last colon
 */
function topicNameFromArn(arn: string): string {
  return arn.split(':').pop() ?? arn
}

/**
 * Print the detailed review of a single orphan topic.
 *
 * @param detail - The orphan topic metadata
 */
function printOrphanDetail(detail: OrphanDetail): void {
  console.log(`  ┌─ ${detail.name}`)
  console.log(`  │  ARN: ${detail.arn}`)
  console.log(`  │  Owner: ${detail.owner}`)
  console.log(`  │  Display Name: ${detail.displayName || 'N/A'}`)

  if (detail.kmsKeyId) {
    console.log(`  │  KMS Key: ${detail.kmsKeyId}`)
  } else {
    console.log('  │  KMS Key: None (default encryption)')
  }

  console.log(`  │  FIFO: ${detail.isFifo}`)

  if (detail.tags.length > 0) {
    console.log('  │  Tags:')
    for (const tag of detail.tags) {
      console.log(`  │    ${tag.Key} = ${tag.Value}`)
    }
  } else {
    console.log('  │  Tags: None')
  }

  console.log('  └──────────────────────────────────────────────────────')
  console.log('')
}

// ========================================
// Main
// ========================================

async function main(): Promise<void> {
  const logFile = startFileLogging('sns-orphans')
  const config: AwsConfig = buildAwsConfig(args)
  const auth = resolveAuth(config.profile)

  log.header(`  SNS Topic Audit (${config.environment} / ${config.region})`)

  log.info(`Auth: ${auth.mode}`)
  console.log('')

  const client = new SNSClient({
    region: config.region,
    credentials: config.credentials,
  })

  // ─── Step 1: Discover all topics ────────────────────────────────────
  log.step(1, 3, 'Discovering SNS topics...')
  const topics = await listAllTopics(client)

  if (topics.length === 0) {
    log.warn('No SNS topics found.')
    return
  }
  log.success(`Found ${topics.length} topic(s)`)
  console.log('')

  // ─── Step 2: Check subscriptions for each topic ─────────────────────
  log.step(2, 3, 'Checking subscription counts...')
  console.log('')

  const summaries: TopicSummary[] = []
  const orphanArns: string[] = []

  for (const topic of topics) {
    const arn = topic.TopicArn ?? ''
    const name = topicNameFromArn(arn)
    const subCount = await countSubscriptions(client, arn)

    summaries.push({ arn, name, subscriptionCount: subCount })

    if (subCount === 0) {
      orphanArns.push(arn)
      log.fail(`${name}  (0 subscriptions)`)
    } else {
      log.success(`${name}  (${subCount} subscription(s))`)
    }
  }

  console.log('')
  console.log('──────────────────────────────────────────────────────────────')
  console.log(`  Summary: ${topics.length} topics total, ${orphanArns.length} without subscriptions`)
  console.log('──────────────────────────────────────────────────────────────')

  // ─── Step 3: Detailed review of orphans ─────────────────────────────
  if (orphanArns.length === 0) {
    console.log('')
    log.success('All topics have at least one subscription.')
    return
  }

  console.log('')
  log.step(3, 3, 'Fetching detailed metadata for orphan topics...')
  console.log('')

  const details = await Promise.all(
    orphanArns.map((arn) => getOrphanDetail(client, arn, topicNameFromArn(arn))),
  )

  console.log('  Detailed review of topics without subscriptions:')
  console.log('')
  for (const detail of details) {
    printOrphanDetail(detail)
  }

  log.summary('Audit Complete', {
    'Total Topics': String(topics.length),
    'With Subscriptions': String(topics.length - orphanArns.length),
    'Without Subscriptions (Orphans)': String(orphanArns.length),
  })

  stopFileLogging()
  log.info(`\nLog saved to: ${logFile}`)
}

main().catch((error: Error) => {
  log.fatal(`SNS audit failed: ${error.message}`)
})
