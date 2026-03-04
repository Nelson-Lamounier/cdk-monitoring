#!/usr/bin/env ts-node
/**
 * Article Migration Script - MDX to DynamoDB
 *
 * This script migrates existing MDX articles from the filesystem to DynamoDB
 * and uploads associated images to S3.
 *
 * Prerequisites:
 * - AWS credentials configured (via env vars, ~/.aws/credentials, or IAM role)
 * - DynamoDB table created (see CDK stack in infrastructure repository)
 * - S3 bucket created for article assets
 *
 * Usage:
 *   npx tsx scripts/dynamodb/migrate-articles-to-dynamodb.ts --env development
 *   npx tsx scripts/dynamodb/migrate-articles-to-dynamodb.ts --env dev --profile dev-account
 *
 * CLI Arguments:
 *   --env           Environment (dev, development, staging, production)
 *   --profile       AWS CLI profile (optional, for local usage)
 *   --region        AWS region (default: eu-west-1)
 *   --dry-run       Preview without writing
 *   --force-update  Overwrite existing articles
 *
 * Environment Variables (legacy, CLI args take precedence):
 *   AWS_REGION          - AWS region (default: eu-west-1)
 *   DYNAMODB_TABLE_NAME - DynamoDB table name (overrides SSM)
 *   S3_BUCKET_NAME      - S3 bucket for article assets (overrides SSM)
 *   CLOUDFRONT_DOMAIN   - CloudFront domain for image URLs
 *   DRY_RUN             - Set to 'true' to preview without writing
 *   FORCE_UPDATE        - Set to 'true' to overwrite existing articles
 */

import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, extname, basename } from 'path'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { lookup } from 'mime-types'
import * as log from '../lib/logger.js'
import {
  parseArgs,
  buildAwsConfig,
  getSSMParameterWithFallbacks,
} from '../lib/aws-helpers.js'

// ========================================
// CLI Arguments
// ========================================

const args = parseArgs(
  [
    { name: 'env', description: 'Environment: dev, development, staging, prod', hasValue: true, default: 'dev' },
    { name: 'profile', description: 'AWS CLI profile', hasValue: true },
    { name: 'region', description: 'AWS region', hasValue: true, default: 'eu-west-1' },
    { name: 'dry-run', description: 'Preview without writing', hasValue: false, default: false },
    { name: 'force-update', description: 'Overwrite existing articles', hasValue: false, default: false },
  ],
  'Migrate MDX articles to DynamoDB and upload images to S3',
)

// ========================================
// Configuration (resolved at runtime)
// ========================================

interface MigrationConfig {
  region: string
  tableName: string
  bucketName: string
  cloudfrontDomain: string
  dryRun: boolean
  forceUpdate: boolean
  articlesDir: string
}

// ========================================
// Types
// ========================================

interface ArticleMetadata {
  title: string
  description: string
  author: string
  date: string
}

interface ComponentData {
  componentId: string
  componentType: string
  position: number
  props: Record<string, unknown>
}

interface ImageData {
  id: string
  s3Key: string
  localPath: string
  alt: string
  width?: number
  height?: number
}

interface MigrationResult {
  slug: string
  success: boolean
  metadata?: ArticleMetadata
  imagesUploaded: number
  error?: string
}

// ========================================
// Utility Functions
// ========================================

/**
 * Extracts article metadata from MDX export statement
 */
function extractMetadata(mdxContent: string): ArticleMetadata | null {
  // Match the export const article = { ... } pattern
  const articleExportMatch = mdxContent.match(
    /export\s+const\s+article\s*=\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/s,
  )

  if (!articleExportMatch) {
    return null
  }

  const articleBlock = articleExportMatch[1]

  // Extract individual fields
  const extractField = (fieldName: string): string => {
    // Handle multiline strings with template literals or quotes
    const patterns = [
      // Single line with quotes
      new RegExp(`${fieldName}:\\s*['"\`]([^'"\`]+)['"\`]`, 's'),
      // Multiline with quotes (greedy)
      new RegExp(`${fieldName}:\\s*['"\`]([\\s\\S]*?)['"\`]\\s*,`, 's'),
    ]

    for (const pattern of patterns) {
      const match = articleBlock.match(pattern)
      if (match) {
        return match[1].replace(/\s+/g, ' ').trim()
      }
    }

    return ''
  }

  return {
    title: extractField('title'),
    description: extractField('description'),
    author: extractField('author'),
    date: extractField('date'),
  }
}

/**
 * Extracts component usage from MDX content
 */
function extractComponentData(mdxContent: string): ComponentData[] {
  const components: ComponentData[] = []
  let position = 0

  // Extract ScenarioKeywords components
  const scenarioKeywordsRegex =
    /<ScenarioKeywords\s+keywords=\{([\s\S]*?)\}\s*\/>/g
  let match: RegExpExecArray | null

  while ((match = scenarioKeywordsRegex.exec(mdxContent)) !== null) {
    try {
      // Clean up the props string for JSON parsing
      const propsString = match[1]
        .replace(/'/g, '"')
        .replace(/(\w+):/g, '"$1":')
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']')

      const keywords = JSON.parse(propsString)

      components.push({
        componentId: `scenario-keywords-${position}`,
        componentType: 'ScenarioKeywords',
        position: position++,
        props: { keywords },
      })
    } catch (e) {
      console.warn('Failed to parse ScenarioKeywords props:', e)
    }
  }

  // Extract EliminationList components
  const eliminationListRegex =
    /<EliminationList\s+items=\{([\s\S]*?)\}\s*\/>/g

  while ((match = eliminationListRegex.exec(mdxContent)) !== null) {
    try {
      const propsString = match[1]
        .replace(/'/g, '"')
        .replace(/(\w+):/g, '"$1":')
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']')

      const items = JSON.parse(propsString)

      components.push({
        componentId: `elimination-list-${position}`,
        componentType: 'EliminationList',
        position: position++,
        props: { items },
      })
    } catch (e) {
      console.warn('Failed to parse EliminationList props:', e)
    }
  }

  return components
}

/**
 * Extracts image imports from MDX content
 */
function extractImageImports(
  mdxContent: string,
  articleDir: string,
): Map<string, ImageData> {
  const images = new Map<string, ImageData>()

  // Match import statements for images
  const importRegex = /import\s+(\w+)\s+from\s+['"]\.\/([^'"]+)['"]/g
  let match: RegExpExecArray | null

  while ((match = importRegex.exec(mdxContent)) !== null) {
    const [, variableName, relativePath] = match
    const ext = extname(relativePath).toLowerCase()

    // Only process image files
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) {
      const localPath = join(articleDir, relativePath)

      if (existsSync(localPath)) {
        images.set(variableName, {
          id: variableName,
          s3Key: '', // Will be set during upload
          localPath,
          alt: variableName.replace(/([A-Z])/g, ' $1').trim(),
        })
      }
    }
  }

  return images
}

/**
 * Cleans MDX content for storage
 * Removes imports and export statements, keeps the content
 */
function cleanMdxContent(mdxContent: string): string {
  let content = mdxContent

  // Remove import statements
  content = content.replace(/^import\s+.*$/gm, '')

  // Remove export const article = {...}
  content = content.replace(
    /export\s+const\s+article\s*=\s*\{[\s\S]*?\}\s*;?/g,
    '',
  )

  // Remove export const metadata = {...}
  content = content.replace(
    /export\s+const\s+metadata\s*=\s*\{[\s\S]*?\}\s*;?/g,
    '',
  )

  // Remove export default statement
  content = content.replace(/export\s+default\s+.*$/gm, '')

  // Trim leading/trailing whitespace and normalize line breaks
  content = content.trim()

  // Remove excessive blank lines (more than 2)
  content = content.replace(/\n{3,}/g, '\n\n')

  return content
}

/**
 * Calculates reading time from content
 */
function calculateReadingTime(content: string): number {
  const wordsPerMinute = 200
  const wordCount = content.split(/\s+/).filter(Boolean).length
  return Math.ceil(wordCount / wordsPerMinute)
}

/**
 * Uploads an image to S3
 */
async function uploadImageToS3(
  image: ImageData,
  slug: string,
  config: MigrationConfig,
  s3Client: S3Client,
): Promise<string> {
  const fileName = basename(image.localPath)
  const s3Key = `articles/${slug}/${fileName}`

  if (config.dryRun) {
    console.log(
      `  [DRY RUN] Would upload: ${image.localPath} -> s3://${config.bucketName}/${s3Key}`,
    )
    return s3Key
  }

  // Check if file already exists
  try {
    await s3Client.send(
      new HeadObjectCommand({
        Bucket: config.bucketName,
        Key: s3Key,
      }),
    )
    console.log(`  Image already exists: ${s3Key}`)
    return s3Key
  } catch {
    // File doesn't exist, proceed with upload
  }

  const fileContent = readFileSync(image.localPath)
  const contentType = lookup(image.localPath) || 'application/octet-stream'

  await s3Client.send(
    new PutObjectCommand({
      Bucket: config.bucketName,
      Key: s3Key,
      Body: fileContent,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  )

  console.log(`  Uploaded: ${s3Key}`)
  return s3Key
}

/**
 * Checks if article already exists in DynamoDB
 */
async function articleExists(
  slug: string,
  config: MigrationConfig,
  docClient: DynamoDBDocumentClient,
): Promise<boolean> {
  if (config.dryRun) {
    return false
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: config.tableName,
        Key: {
          pk: `ARTICLE#${slug}`,
          sk: 'METADATA',
        },
      }),
    )
    return !!result.Item
  } catch {
    return false
  }
}

/**
 * Creates tag index items for an article
 */
async function createTagIndexItems(
  slug: string,
  tags: string[],
  date: string,
  title: string,
  description: string,
  author: string,
  readingTime: number,
  config: MigrationConfig,
  docClient: DynamoDBDocumentClient,
): Promise<void> {
  if (!tags || tags.length === 0) {
    return
  }

  for (const tag of tags) {
    const tagIndexItem = {
      pk: `TAG#${tag.toLowerCase()}`,
      sk: `${date}#${slug}`,
      entityType: 'TAG_INDEX',
      tag: tag.toLowerCase(),
      
      // Denormalized article data for efficient queries
      articleSlug: slug,
      articleTitle: title,
      articleDescription: description,
      articleAuthor: author,
      articleDate: date,
      articleReadingTime: readingTime,
      articleTags: tags,
      
      gsi2pk: `TAG#${tag.toLowerCase()}`,
      gsi2sk: `${date}#${slug}`,
      createdAt: new Date().toISOString(),
    }

    if (config.dryRun) {
      console.log(`  [DRY RUN] Would create tag index: TAG#${tag.toLowerCase()}`)
    } else {
      await docClient.send(
        new PutCommand({
          TableName: config.tableName,
          Item: tagIndexItem,
        }),
      )
    }
  }

  if (!config.dryRun) {
    console.log(`  Created ${tags.length} tag index items`)
  }
}

/**
 * Writes article metadata to DynamoDB
 */
async function writeMetadataToDynamoDB(
  slug: string,
  metadata: ArticleMetadata,
  readingTime: number,
  config: MigrationConfig,
  docClient: DynamoDBDocumentClient,
  featuredImage?: string,
): Promise<void> {
  const now = new Date().toISOString()

  const item = {
    pk: `ARTICLE#${slug}`,
    sk: 'METADATA',
    entityType: 'ARTICLE_METADATA',

    slug,
    title: metadata.title,
    description: metadata.description,
    author: metadata.author,
    date: metadata.date,

    status: 'published',
    tags: extractTagsFromSlug(slug),
    category: 'AWS & DevOps',
    readingTimeMinutes: readingTime,
    featuredImage,

    createdAt: now, // PutCommand overwrites; for updates, updatedAt changes
    updatedAt: now,
    publishedAt: now,
    version: config.forceUpdate ? 2 : 1,

    gsi1pk: 'STATUS#published',
    gsi1sk: `${metadata.date}#${slug}`,
  }

  if (config.dryRun) {
    console.log(
      `  [DRY RUN] Would write metadata:`,
      JSON.stringify(item, null, 2),
    )
    return
  }

  await docClient.send(
    new PutCommand({
      TableName: config.tableName,
      Item: item,
    }),
  )

  console.log(`  Wrote metadata to DynamoDB`)
}

/**
 * Writes article content to DynamoDB
 */
async function writeContentToDynamoDB(
  slug: string,
  content: string,
  componentData: ComponentData[],
  images: Array<{ id: string; s3Key: string; alt: string }>,
  config: MigrationConfig,
  docClient: DynamoDBDocumentClient,
): Promise<void> {
  const now = new Date().toISOString()

  const item = {
    pk: `ARTICLE#${slug}`,
    sk: 'CONTENT#v1',
    entityType: 'ARTICLE_CONTENT',

    contentType: 'mdx',
    content,

    componentData: componentData.length > 0 ? componentData : undefined,
    images,

    version: config.forceUpdate ? 2 : 1,
    createdAt: now,
    changelog: config.forceUpdate ? 'Updated via FORCE_UPDATE' : 'Initial migration from MDX files',
  }

  if (config.dryRun) {
    console.log(
      `  [DRY RUN] Would write content (${content.length} chars, ${images.length} images)`,
    )
    return
  }

  await docClient.send(
    new PutCommand({
      TableName: config.tableName,
      Item: item,
    }),
  )

  console.log(`  Wrote content to DynamoDB (${content.length} chars)`)
}

/**
 * Extracts tags from article slug
 */
function extractTagsFromSlug(slug: string): string[] {
  const tags: string[] = []

  if (slug.includes('aws')) tags.push('aws')
  if (slug.includes('devops')) tags.push('devops')
  if (slug.includes('exam') || slug.includes('certification'))
    tags.push('certification')
  if (slug.includes('lambda') || slug.includes('serverless'))
    tags.push('serverless')
  if (slug.includes('xray') || slug.includes('observability'))
    tags.push('observability')
  if (slug.includes('ami') || slug.includes('ec2')) tags.push('compute')
  if (slug.includes('cloudformation') || slug.includes('cdk')) tags.push('iac')
  if (slug.includes('service-catalog') || slug.includes('governance'))
    tags.push('governance')

  // Always add these if empty
  if (tags.length === 0) {
    tags.push('aws', 'devops')
  }

  return [...new Set(tags)]
}

/**
 * Migrates a single article
 */
async function migrateArticle(
  slug: string,
  config: MigrationConfig,
  docClient: DynamoDBDocumentClient,
  s3Client: S3Client,
): Promise<MigrationResult> {
  const articleDir = join(config.articlesDir, slug)
  const mdxPath = join(articleDir, 'page.mdx')

  console.log(`\nMigrating: ${slug}`)

  try {
    // Check if MDX file exists
    if (!existsSync(mdxPath)) {
      return {
        slug,
        success: false,
        imagesUploaded: 0,
        error: 'MDX file not found',
      }
    }

    // Check if already migrated
    const exists = await articleExists(slug, config, docClient)
    if (exists && !config.forceUpdate) {
      console.log(`  Skipping: Already exists in DynamoDB (use --force-update to overwrite)`)
      return {
        slug,
        success: true,
        imagesUploaded: 0,
        error: 'Already migrated',
      }
    }
    if (exists && config.forceUpdate) {
      console.log(`  Updating: Overwriting existing article`)
    }

    // Read MDX content
    const mdxContent = readFileSync(mdxPath, 'utf-8')

    // Extract metadata
    const metadata = extractMetadata(mdxContent)
    if (!metadata || !metadata.title) {
      return {
        slug,
        success: false,
        imagesUploaded: 0,
        error: 'Could not extract metadata',
      }
    }

    console.log(`  Title: ${metadata.title}`)
    console.log(`  Date: ${metadata.date}`)

    // Extract images
    const imageImports = extractImageImports(mdxContent, articleDir)
    console.log(`  Found ${imageImports.size} images`)

    // Upload images to S3
    const uploadedImages: Array<{ id: string; s3Key: string; alt: string }> = []
    let featuredImage: string | undefined

    for (const [id, image] of imageImports) {
      const s3Key = await uploadImageToS3(image, slug, config, s3Client)
      uploadedImages.push({
        id,
        s3Key,
        alt: image.alt,
      })

      // Use first image as featured image
      if (!featuredImage && config.cloudfrontDomain) {
        featuredImage = `https://${config.cloudfrontDomain}/${s3Key}`
      }
    }

    // Extract component data
    const componentData = extractComponentData(mdxContent)
    console.log(`  Found ${componentData.length} custom components`)

    // Clean content
    const cleanContent = cleanMdxContent(mdxContent)
    const readingTime = calculateReadingTime(cleanContent)
    console.log(`  Reading time: ${readingTime} minutes`)

    // Write to DynamoDB
    const tags = extractTagsFromSlug(slug)
    await writeMetadataToDynamoDB(slug, metadata, readingTime, config, docClient, featuredImage)
    await writeContentToDynamoDB(
      slug,
      cleanContent,
      componentData,
      uploadedImages,
      config,
      docClient,
    )
    await createTagIndexItems(
      slug,
      tags,
      metadata.date,
      metadata.title,
      metadata.description,
      metadata.author,
      readingTime,
      config,
      docClient,
    )

    return {
      slug,
      success: true,
      metadata,
      imagesUploaded: uploadedImages.length,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`  Error: ${errorMessage}`)
    return {
      slug,
      success: false,
      imagesUploaded: 0,
      error: errorMessage,
    }
  }
}

/**
 * Gets all article slugs from filesystem
 */
function getArticleSlugs(articlesDir: string): string[] {
  const entries = readdirSync(articlesDir, { withFileTypes: true })

  return entries
    .filter((entry) => {
      if (!entry.isDirectory()) return false
      const mdxPath = join(articlesDir, entry.name, 'page.mdx')
      return existsSync(mdxPath)
    })
    .map((entry) => entry.name)
}

// ========================================
// Main Execution
// ========================================

async function main() {
  const awsConfig = buildAwsConfig(args)
  const dryRun = (args['dry-run'] as boolean) || process.env.DRY_RUN === 'true'
  const forceUpdate = (args['force-update'] as boolean) || process.env.FORCE_UPDATE === 'true'

  log.header('📝 Article Migration — MDX to DynamoDB')
  log.config('Configuration', {
    'AWS Region': awsConfig.region,
    'Environment': awsConfig.environment,
    'Dry Run': String(dryRun),
    'Force Update': String(forceUpdate),
  })

  const totalSteps = 4

  // Step 1: Resolve DynamoDB table name from SSM
  log.step(1, totalSteps, 'Discovering DynamoDB table from SSM...')

  let tableName = process.env.DYNAMODB_TABLE_NAME
  if (!tableName) {
    const tableResult = await getSSMParameterWithFallbacks(
      [
        `/nextjs/${awsConfig.environment}/dynamodb-table-name`,
        `/nextjs/${awsConfig.environment}/dynamodb/table-name`,
      ],
      awsConfig,
    )
    if (tableResult) {
      tableName = tableResult.value
    } else {
      log.fatal(
        `DynamoDB table name not found in SSM.\n` +
        `   Searched paths:\n` +
        `     /nextjs/${awsConfig.environment}/dynamodb-table-name\n` +
        `     /nextjs/${awsConfig.environment}/dynamodb/table-name\n` +
        `   Set DYNAMODB_TABLE_NAME env var or create the SSM parameter.`,
      )
    }
  } else {
    log.success(`Using table from env: ${tableName}`)
  }
  log.success(`Table: ${tableName}`)

  // Step 2: Resolve S3 bucket name from SSM
  log.step(2, totalSteps, 'Discovering S3 bucket from SSM...')

  let bucketName = process.env.S3_BUCKET_NAME
  if (!bucketName) {
    const bucketResult = await getSSMParameterWithFallbacks(
      [
        `/nextjs/${awsConfig.environment}/assets-bucket-name`,
        `/nextjs/${awsConfig.environment}/s3/article-assets-bucket`,
      ],
      awsConfig,
    )
    if (bucketResult) {
      bucketName = bucketResult.value
    } else {
      log.fatal(
        `S3 bucket name not found in SSM.\n` +
        `   Searched paths:\n` +
        `     /nextjs/${awsConfig.environment}/assets-bucket-name\n` +
        `     /nextjs/${awsConfig.environment}/s3/article-assets-bucket\n` +
        `   Set S3_BUCKET_NAME env var or create the SSM parameter.`,
      )
    }
  } else {
    log.success(`Using bucket from env: ${bucketName}`)
  }
  // Strip s3:// prefix and trailing slash if present
  bucketName = bucketName!.replace(/^s3:\/\//, '').replace(/\/$/, '')
  log.success(`Bucket: ${bucketName}`)

  const cloudfrontDomain = process.env.CLOUDFRONT_DOMAIN || ''

  // Build resolved config
  const config: MigrationConfig = {
    region: awsConfig.region,
    tableName: tableName!,
    bucketName,
    cloudfrontDomain,
    dryRun,
    forceUpdate,
    articlesDir: join(process.cwd(), 'src', 'app', 'articles'),
  }

  // Step 3: Discover articles
  log.step(3, totalSteps, 'Discovering articles from filesystem...')

  const slugs = getArticleSlugs(config.articlesDir)
  if (slugs.length === 0) {
    log.fatal(`No articles found in ${config.articlesDir}`)
  }

  log.success(`Found ${slugs.length} articles to migrate`)
  slugs.forEach((slug) => console.log(`  - ${slug}`))

  // Step 4: Migrate articles
  log.step(4, totalSteps, 'Running migration...')

  // Create AWS clients
  const clientConfig = {
    region: config.region,
    credentials: awsConfig.credentials,
  }
  const dynamoClient = new DynamoDBClient(clientConfig)
  const docClient = DynamoDBDocumentClient.from(dynamoClient)
  const s3Client = new S3Client(clientConfig)

  const results: MigrationResult[] = []

  for (const slug of slugs) {
    const result = await migrateArticle(slug, config, docClient, s3Client)
    results.push(result)
  }

  // Summary
  const successful = results.filter(
    (r) => r.success && !r.error?.includes('Already'),
  )
  const alreadyExisted = results.filter((r) => r.error?.includes('Already'))
  const failed = results.filter((r) => !r.success)

  const totalImages = results.reduce((sum, r) => sum + r.imagesUploaded, 0)

  log.summary('Migration Complete', {
    'Migrated': String(successful.length),
    'Already Existed': String(alreadyExisted.length),
    'Failed': String(failed.length),
    'Images Uploaded': String(totalImages),
  })

  if (successful.length > 0) {
    console.log('Migrated articles:')
    successful.forEach((r) =>
      console.log(`  ✓ ${r.slug} (${r.imagesUploaded} images)`),
    )
  }

  if (alreadyExisted.length > 0) {
    console.log('Already existed (skipped):')
    alreadyExisted.forEach((r) => console.log(`  - ${r.slug}`))
  }

  if (failed.length > 0) {
    console.log('Failed:')
    failed.forEach((r) => console.log(`  ✗ ${r.slug}: ${r.error}`))
  }

  if (dryRun) {
    console.log(
      '\n** This was a dry run. Run without --dry-run to apply changes. **',
    )
  }

  // Exit non-zero if ALL articles failed (nothing was migrated or already present)
  const totalSuccess = successful.length + alreadyExisted.length
  if (totalSuccess === 0 && !dryRun) {
    log.fatal(`Migration failed: no articles were successfully migrated out of ${slugs.length} found.`)
  }

  if (failed.length > 0) {
    console.error(`\n⚠️  ${failed.length} article(s) failed to migrate.`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('\nMigration failed:', error)
  process.exit(1)
})
