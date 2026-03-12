#!/usr/bin/env tsx
/**
 * Add Tag Index Entries to DynamoDB
 *
 * This script creates separate tag index items for the gsi2-tag-date index.
 * Each article-tag combination gets its own item to enable efficient tag queries.
 *
 * Pattern: For each article with tags [tag1, tag2, tag3]:
 * - Create items with gsi2pk = "TAG#tag1", gsi2sk = "date#slug"
 * - These items are queryable via the gsi2-tag-date index
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb'
import { unmarshall } from '@aws-sdk/util-dynamodb'

// Configuration
const CONFIG = {
  region: process.env.AWS_REGION || 'eu-west-1',
  tableName: process.env.TABLE_NAME || 'webapp-articles-development',
  profile: process.env.AWS_PROFILE || 'dev-account',
  dryRun: process.env.DRY_RUN === 'true',
}

// AWS Client Configuration
const clientConfig: any = {
  region: CONFIG.region,
}

if (CONFIG.profile) {
  const { fromIni } = await import('@aws-sdk/credential-providers')
  clientConfig.credentials = fromIni({ profile: CONFIG.profile })
}

const dynamodb = new DynamoDBClient(clientConfig)

interface ArticleMetadata {
  pk: string
  sk: string
  slug: string
  title: string
  date: string
  tags: string[]
  [key: string]: any
}

/**
 * Scan all article metadata items
 */
async function getAllArticleMetadata(): Promise<ArticleMetadata[]> {
  const articles: ArticleMetadata[] = []
  let lastEvaluatedKey: Record<string, any> | undefined

  do {
    const command = new ScanCommand({
      TableName: CONFIG.tableName,
      FilterExpression: 'entityType = :type',
      ExpressionAttributeValues: {
        ':type': { S: 'ARTICLE_METADATA' },
      },
      ExclusiveStartKey: lastEvaluatedKey,
    })

    const result = await dynamodb.send(command)

    if (result.Items) {
      articles.push(...result.Items.map((item) => unmarshall(item) as ArticleMetadata))
    }

    lastEvaluatedKey = result.LastEvaluatedKey
  } while (lastEvaluatedKey)

  return articles
}

/**
 * Create tag index item for an article-tag pair
 */
async function createTagIndexItem(
  article: ArticleMetadata,
  tag: string,
): Promise<void> {
  const tagIndexPk = `TAG#${tag.toLowerCase()}`
  const tagIndexSk = `${article.date}#${article.slug}`

  // Check if tag index item already exists
  const existsCommand = new GetItemCommand({
    TableName: CONFIG.tableName,
    Key: {
      pk: { S: tagIndexPk },
      sk: { S: tagIndexSk },
    },
  })

  if (!CONFIG.dryRun) {
    const existingItem = await dynamodb.send(existsCommand)
    if (existingItem.Item) {
      console.log(`    ✓ Tag index already exists: ${tagIndexPk} / ${tagIndexSk}`)
      return
    }
  }

  // Create tag index item with denormalized article data for efficient queries
  const tagIndexItem = {
    pk: { S: tagIndexPk },
    sk: { S: tagIndexSk },
    entityType: { S: 'TAG_INDEX' },
    tag: { S: tag.toLowerCase() },
    
    // Denormalized article data (avoids second query in Lambda)
    articleSlug: { S: article.slug },
    articleTitle: { S: article.title },
    articleDescription: article.description ? { S: article.description } : { NULL: true },
    articleAuthor: article.author ? { S: article.author } : { NULL: true },
    articleDate: { S: article.date },
    articleReadingTime: article.readingTimeMinutes ? { N: String(article.readingTimeMinutes) } : { NULL: true },
    articleTags: { L: article.tags.map(t => ({ S: t })) },
    
    gsi2pk: { S: tagIndexPk },
    gsi2sk: { S: tagIndexSk },
    createdAt: { S: new Date().toISOString() },
  }

  if (CONFIG.dryRun) {
    console.log(`    [DRY RUN] Would create tag index:`)
    console.log(`      pk: ${tagIndexPk}`)
    console.log(`      sk: ${tagIndexSk}`)
    console.log(`      gsi2pk: ${tagIndexPk}`)
    console.log(`      gsi2sk: ${tagIndexSk}`)
    console.log(`      + denormalized article data`)
  } else {
    const putCommand = new PutItemCommand({
      TableName: CONFIG.tableName,
      Item: tagIndexItem,
    })

    await dynamodb.send(putCommand)
    console.log(`    ✓ Created tag index: ${tagIndexPk} / ${tagIndexSk}`)
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('============================================================')
  console.log('Add Tag Index Entries to DynamoDB')
  console.log('============================================================')
  console.log('')
  console.log('Configuration:')
  console.log(`  Region:      ${CONFIG.region}`)
  console.log(`  Profile:     ${CONFIG.profile}`)
  console.log(`  Table:       ${CONFIG.tableName}`)
  console.log(`  Dry Run:     ${CONFIG.dryRun}`)
  console.log('')

  if (CONFIG.dryRun) {
    console.log('** DRY RUN MODE - No changes will be made **')
    console.log('')
  }

  try {
    // Get all articles
    console.log('Fetching articles from DynamoDB...')
    const articles = await getAllArticleMetadata()
    console.log(`Found ${articles.length} articles`)
    console.log('')

    let tagIndexCount = 0

    // Process each article
    for (const article of articles) {
      console.log(`Processing: ${article.slug}`)
      console.log(`  Tags: ${article.tags.join(', ')}`)

      if (!article.tags || article.tags.length === 0) {
        console.log(`  ⚠️  No tags found, skipping...`)
        continue
      }

      // Create tag index item for each tag
      for (const tag of article.tags) {
        await createTagIndexItem(article, tag)
        tagIndexCount++
      }

      console.log('')
    }

    console.log('============================================================')
    console.log('Summary')
    console.log('============================================================')
    console.log(`Articles processed: ${articles.length}`)
    console.log(`Tag index items: ${tagIndexCount}`)
    console.log('')

    if (CONFIG.dryRun) {
      console.log('This was a DRY RUN. No changes were made.')
      console.log('Run without DRY_RUN=true to apply changes.')
    } else {
      console.log('✅ Tag index entries created successfully!')
      console.log('')
      console.log('Test the tag query:')
      console.log(
        '  curl https://h48c36idp0.execute-api.eu-west-1.amazonaws.com/api/articles/tag/aws',
      )
    }
  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  }
}

main()
