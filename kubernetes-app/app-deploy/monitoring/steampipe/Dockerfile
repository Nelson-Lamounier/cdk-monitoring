FROM ghcr.io/turbot/steampipe:latest

# Install the AWS plugin at build time (runtime install fails with 403)
RUN steampipe plugin install aws
