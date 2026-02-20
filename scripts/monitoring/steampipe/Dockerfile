# =============================================================================
# Custom Steampipe image with AWS plugin pre-installed
# =============================================================================
# The upstream steampipe image ships without plugins. The AWS plugin
# must be installed from the Steampipe plugin registry. Installing it at
# build time avoids runtime registry access issues and makes container
# startup deterministic.
#
# Uses GHCR image which pulls plugins from GitHub Container Registry
# (avoids Google Artifact Registry 403 auth issues).
# =============================================================================

FROM ghcr.io/turbot/steampipe:v0.24.2

# Disable update checks at build time and install the AWS plugin
ENV STEAMPIPE_UPDATE_CHECK=false
RUN steampipe plugin install aws

