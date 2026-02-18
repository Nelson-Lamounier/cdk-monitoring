# GitHub CLI - Managing Secrets and Variables

Complete guide for managing GitHub Actions secrets and variables using the GitHub CLI.

## Table of Contents
- [Environment Secrets](#environment-secrets)
- [Repository Secrets](#repository-secrets)
- [Environment Variables](#environment-variables)
- [Repository Variables](#repository-variables)
- [Secret File Structure](#secret-file-structure)

---

## Environment Secrets

### Create/Update Environment Secrets

```bash
# Basic command (prompts for value)
gh secret set SECRET_NAME --env ENVIRONMENT_NAME

# Pipe secret value
echo "secret_value" | gh secret set SECRET_NAME --env production

# Set secret with inline value
gh secret set API_KEY --env staging --body "my-api-key-value"

# Set secret from a file
gh secret set AWS_ACCESS_KEY --env production < secret.txt

# Set secret in a specific repository
gh secret set DATABASE_URL --env production --repo owner/repo
```

**Note:** The `set` command both creates new secrets and updates existing ones.

### List Environment Secrets

```bash
# List secrets for a specific environment
gh secret list --env production
```

### Delete Environment Secrets

```bash
# Remove a secret from an environment
gh secret remove SECRET_NAME --env production

# Remove from specific repository
gh secret remove SECRET_NAME --env production --repo owner/repo
```

---

## Repository Secrets

### Create/Update Repository Secrets

```bash
# Basic command (prompts for value)
gh secret set SECRET_NAME

# Pipe secret value
echo "my-secret-value" | gh secret set DATABASE_URL

# Set secret with inline value
gh secret set API_KEY --body "my-api-key-value"

# Set secret from a file
gh secret set AWS_CREDENTIALS < credentials.txt

# Set secret in a specific repository
gh secret set SECRET_NAME --repo owner/repo
```

### List Repository Secrets

```bash
# List all repository secrets
gh secret list

# List secrets for a specific repository
gh secret list --repo owner/repo
```

### Delete Repository Secrets

```bash
# Remove a repository secret
gh secret remove SECRET_NAME

# Remove from specific repository
gh secret remove SECRET_NAME --repo owner/repo
```

---

## Environment Variables

### Create/Update Environment Variables

```bash
# Basic command (prompts for value)
gh variable set VARIABLE_NAME --env ENVIRONMENT_NAME

# Pipe variable value
echo "production" | gh variable set NODE_ENV --env production

# Set variable with inline value
gh variable set API_URL --env staging --body "https://staging-api.example.com"

# Set variable from a file
gh variable set CONFIG --env production < config.txt

# Set variable in a specific repository
gh variable set REGION --env production --repo owner/repo
```

### List Environment Variables

```bash
# List variables for a specific environment
gh variable list --env production
```

### Delete Environment Variables

```bash
# Remove a variable from an environment
gh variable remove VARIABLE_NAME --env production

# Remove from specific repository
gh variable remove VARIABLE_NAME --env production --repo owner/repo
```

---

## Repository Variables

### Create/Update Repository Variables

```bash
# Basic command (prompts for value)
gh variable set VARIABLE_NAME

# Pipe variable value
echo "main" | gh variable set DEFAULT_BRANCH

# Set variable with inline value
gh variable set NODE_VERSION --body "18.x"

# Set variable from a file
gh variable set BUILD_CONFIG < build-config.txt

# Set variable in a specific repository
gh variable set VARIABLE_NAME --repo owner/repo
```

### List Repository Variables

```bash
# List all repository variables
gh variable list

# List variables for a specific repository
gh variable list --repo owner/repo
```

### Delete Repository Variables

```bash
# Remove a repository variable
gh variable remove VARIABLE_NAME

# Remove from specific repository
gh variable remove VARIABLE_NAME --repo owner/repo
```

---

## Secret File Structure

### Single-line Secret File

For simple secrets, just put the value in the file with no newlines:

```txt
my-secret-value-here
```

**Example: `secret.txt`**
```txt
ghp_1234567890abcdefghijklmnopqrstuvwxyz
```

### Multi-line Secret File

For secrets like SSH keys, certificates, or JSON credentials:

```txt
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA1234567890abcdef...
abcdefghijklmnopqrstuvwxyz1234567890
...
-----END RSA PRIVATE KEY-----
```

**Example: `aws-credentials.txt`**
```json
{
  "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
  "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "region": "us-east-1"
}
```

**Example: `.env` file format**
```txt
DATABASE_URL=postgresql://user:pass@localhost:5432/db
API_KEY=abc123xyz789
SECRET_TOKEN=super-secret-token
```

### Usage with Files

```bash
# Single-line secret
gh secret set API_KEY < api-key.txt

# Multi-line secret (SSH key)
gh secret set SSH_PRIVATE_KEY < ~/.ssh/id_rsa

# JSON credentials
gh secret set AWS_CREDENTIALS < aws-credentials.json

# Certificate
gh secret set TLS_CERT < certificate.pem
```

---

## Important Notes

1. **Environment must exist first** - Create the environment in your repository settings before adding secrets/variables to it
2. **Repository permissions** - You need admin or write access to the repository
3. **Secrets vs Variables**:
   - **Secrets**: Encrypted, hidden in logs, for sensitive data (API keys, passwords, tokens)
   - **Variables**: Plain text, visible in logs, for non-sensitive configuration (URLs, versions, feature flags)
4. **Organization-level**: For organization secrets/variables, use `gh secret set --org ORGANIZATION_NAME` or `gh variable set --org ORGANIZATION_NAME`
5. **Update = Set**: The `set` command creates new entries or updates existing ones
6. **File content**: The entire file content becomes the secret value, including newlines

## Complete Example Workflow

```bash
# Create production environment secrets
echo $AWS_ACCESS_KEY_ID | gh secret set AWS_ACCESS_KEY_ID --env production
echo $AWS_SECRET_ACCESS_KEY | gh secret set AWS_SECRET_ACCESS_KEY --env production
gh secret set DATABASE_URL --env production < db-url.txt

# Create production environment variables
echo "https://api.production.example.com" | gh variable set API_URL --env production
gh variable set NODE_ENV --env production --body "production"

# Create repository-level secrets (available to all workflows)
gh secret set NPM_TOKEN
gh secret set DOCKER_PASSWORD < docker-pass.txt

# Create repository-level variables
gh variable set NODE_VERSION --body "20.x"
gh variable set DEFAULT_REGION --body "us-east-1"

# List everything
gh secret list --env production
gh variable list --env production
gh secret list
gh variable list

# Delete when needed
gh secret remove OLD_SECRET --env production
gh variable remove OLD_VARIABLE
```

---

## Quick Reference

| Action | Secrets | Variables |
|--------|---------|-----------|
| Create/Update (Environment) | `gh secret set NAME --env ENV` | `gh variable set NAME --env ENV` |
| Create/Update (Repository) | `gh secret set NAME` | `gh variable set NAME` |
| List (Environment) | `gh secret list --env ENV` | `gh variable list --env ENV` |
| List (Repository) | `gh secret list` | `gh variable list` |
| Delete (Environment) | `gh secret remove NAME --env ENV` | `gh variable remove NAME --env ENV` |
| Delete (Repository) | `gh secret remove NAME` | `gh variable remove NAME` |

This is much more convenient than manually managing secrets and variables through the GitHub web interface!