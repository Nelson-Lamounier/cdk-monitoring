FROM ghcr.io/turbot/steampipe:latest

# ── Install AWS plugin from GitHub releases ──────────────────────────
# The official `steampipe plugin install aws` command fails with 403
# because us-docker.pkg.dev blocks unauthenticated OCI pulls.
# Workaround: download the plugin binary directly from GitHub releases
# and install it as a local plugin.

USER root

ARG PLUGIN_VERSION=1.29.0
ARG TARGETARCH=amd64

RUN apt-get update -qq && apt-get install -y -qq curl tar > /dev/null 2>&1 \
    && mkdir -p /home/steampipe/.steampipe/plugins/local/aws \
    && curl -sSL \
    "https://github.com/turbot/steampipe-plugin-aws/releases/download/v${PLUGIN_VERSION}/steampipe-plugin-aws_linux_${TARGETARCH}.tar.gz" \
    | tar -xz -C /home/steampipe/.steampipe/plugins/local/aws \
    && chown -R steampipe:steampipe /home/steampipe/.steampipe \
    && apt-get remove -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

USER steampipe
