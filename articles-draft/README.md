# Article Drafts

Place your raw `.md` article drafts here to trigger the **Bedrock Publisher Pipeline**.

## How It Works

1. Write your article as a standard `.md` file
2. Commit and push to `develop`
3. The `publish-article.yml` GitHub Action detects the change
4. The runner uploads the file to `s3://{bucket}/drafts/{filename}.md`
5. The S3 event trigger invokes the **Publisher Lambda**
6. The Lambda transforms the markdown into polished MDX via Claude (Principal Editor persona)
7. Results are written to:
   - `s3://bucket/published/{slug}.mdx` — latest MDX
   - DynamoDB `ARTICLE#{slug}` — metadata + shot list

## File Naming

- Use **kebab-case** filenames: `deploying-k8s-on-aws.md`
- The filename becomes the article slug
- Each file is uploaded with a flat key: `drafts/{filename}.md`

## What Happens After Upload

The Principal Editor (Claude) will:
- Transform your markdown into a professional blog post
- Insert `<MermaidChart />` components for any fenced mermaid blocks
- Add `<ImageRequest />` Director's Notes where visuals are needed
- Generate a `shotList` manifest of all required visual assets
- Write metadata to DynamoDB for the frontend consumer

## Monitoring

Check Lambda logs after pushing:
```bash
aws logs tail /aws/lambda/bedrock-development-publisher --follow --region eu-west-1
```
