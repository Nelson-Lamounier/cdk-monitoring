# Setup Node.js with Yarn and Caching

Centralised composite action for setting up Node.js, Yarn v4, and dependency caching in GitHub Actions workflows.

## Purpose

This action consolidates the repetitive Node.js + Yarn setup pattern used across CI/CD workflows, replacing the previous `setup-infrastructure` action with a more focused, reusable component.

## Features

- Node.js setup with configurable version
- Corepack enablement for Yarn v4+ support
- Intelligent dependency caching (node_modules, Yarn cache, PnP)
- Turbo build cache integration
- Automatic dependency installation with lockfile validation
- Installation verification with CDK availability check

## Usage

### Basic Usage

```yaml
- name: Setup Node.js and Yarn
  uses: ./.github/actions/setup-node-yarn
```

### With Custom Node Version

```yaml
- name: Setup Node.js 20 with Yarn
  uses: ./.github/actions/setup-node-yarn
  with:
    node-version: "20"
```

### Skip Dependency Installation

```yaml
- name: Setup Node.js and Yarn (no install)
  uses: ./.github/actions/setup-node-yarn
  with:
    install-dependencies: "false"
```

### With Cache Key Output

```yaml
- name: Setup Node.js and Yarn
  id: setup-node
  uses: ./.github/actions/setup-node-yarn

- name: Use Cache Key
  run: echo "Cache key: ${{ steps.setup-node.outputs.cache-key }}"
```

## Inputs

| Input                  | Description                                      | Required | Default     |
| ---------------------- | ------------------------------------------------ | -------- | ----------- |
| `node-version`         | Node.js version to install                       | No       | `22`        |
| `install-dependencies` | Whether to run `yarn install`                    | No       | `true`      |
| `cache-dependency-path`| Path to lockfile for cache key generation       | No       | `yarn.lock` |

## Outputs

| Output         | Description                              |
| -------------- | ---------------------------------------- |
| `cache-hit`    | Whether dependency cache was hit (boolean) |
| `cache-key`    | Dependency cache key used (string)       |
| `node-version` | Node.js version installed (string)       |

## Cache Strategy

### Dependency Cache

Caches the following paths:
- `node_modules` - Installed packages
- `.yarn/cache` - Yarn offline cache
- `.yarn/unplugged` - Unpacked packages
- `.yarn/install-state.gz` - Installation state
- `.pnp.cjs` - Plug'n'Play loader
- `.pnp.loader.mjs` - PnP ESM loader

Cache key format: `deps-{OS}-node{VERSION}-{HASH}`

Where `{HASH}` is the SHA256 of `yarn.lock` + `package.json`.

### Turbo Cache

Caches `.turbo` directory with SHA-based keys for build optimisation.

## Installation Behaviour

The action always runs `yarn install --immutable` when `install-dependencies` is `true`, even on cache hits. This ensures:

1. Binaries are linked correctly (e.g., `cdk`, `tsc`)
2. Workspace setup is complete
3. No accidental dependency modifications (--immutable)

With Yarn v4, this operation is extremely fast on cache hits (~2-5 seconds).

## Migration from setup-infrastructure

### Before (setup-infrastructure)

```yaml
- name: Setup Infrastructure
  uses: ./.github/actions/setup-infrastructure
  with:
    node-version: ${{ env.NODE_VERSION }}
```

### After (setup-node-yarn)

```yaml
- name: Setup Node.js and Yarn
  uses: ./.github/actions/setup-node-yarn
  with:
    node-version: ${{ env.NODE_VERSION }}
```

The interface is identical, making migration seamless.

## Examples

### CI Workflow Setup Job

```yaml
setup:
  name: Setup Dependencies
  runs-on: ubuntu-latest
  outputs:
    cache-key: ${{ steps.setup.outputs.cache-key }}
    node-version: ${{ steps.setup.outputs.node-version }}

  steps:
    - name: Checkout
      uses: actions/checkout@v4

    - name: Setup Node.js and Yarn
      id: setup
      uses: ./.github/actions/setup-node-yarn
```

### Deployment Job with Dependency Restoration

```yaml
deploy:
  name: Deploy Infrastructure
  needs: setup
  runs-on: ubuntu-latest

  steps:
    - name: Checkout
      uses: actions/checkout@v4

    - name: Setup Node.js and Yarn
      uses: ./.github/actions/setup-node-yarn
      with:
        node-version: ${{ needs.setup.outputs.node-version }}

    - name: Build and Deploy
      run: yarn cdk deploy --all
```

## Performance

### Cache Hit Scenario
- Node.js setup: ~5 seconds
- Corepack enable: ~1 second
- Cache restore: ~3 seconds
- Yarn install: ~2 seconds
- **Total: ~11 seconds**

### Cache Miss Scenario
- Node.js setup: ~5 seconds
- Corepack enable: ~1 second
- Cache restore: ~1 second
- Yarn install: ~45 seconds
- Cache save: ~5 seconds
- **Total: ~57 seconds**

## Troubleshooting

### CDK Command Not Found

If the verification step reports "CDK CLI not found":

1. Verify `aws-cdk` is in `package.json` dependencies
2. Check `install-dependencies` input is `true`
3. Review Yarn install logs for errors

### Cache Not Restoring

If cache misses occur on every run:

1. Verify `yarn.lock` is committed
2. Check cache key generation logs
3. Ensure GitHub Actions cache is not disabled

### Yarn Version Mismatch

If wrong Yarn version is used:

1. Verify `.yarnrc.yml` has `yarnPath` configured
2. Check `packageManager` field in `package.json`
3. Review Corepack enablement logs

## Related Actions

- `setup-cdk-deployment` - Builds on this action with AWS credential setup
- `deploy-cdk-stack` - Uses this action indirectly via setup-cdk-deployment

## Version History

- **v1.0.0** - Initial release, replacing setup-infrastructure action
