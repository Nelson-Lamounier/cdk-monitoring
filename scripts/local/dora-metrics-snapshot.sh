#!/bin/bash
# DORA Metrics Snapshot
# Computes CI/CD lead time, deployment frequency, and CFR from GitHub Actions history.
# Run from repo root. Requires: gh CLI authenticated, jq.
#
# Note: durationMs is not available in gh run list — duration is computed from
# startedAt and updatedAt fields. Workflow names must match the display name
# exactly (not the filename). Use `gh workflow list --repo <REPO>` to enumerate.

REPO="Nelson-Lamounier/cdk-monitoring"

echo "=== DORA METRICS SNAPSHOT ==="
echo "Generated: $(date)"
echo "Repo: $REPO"
echo ""

echo "--- CI run time (last 10 successful: 'Continuous Integration') ---"
gh run list --repo "$REPO" --workflow "Continuous Integration" \
  --limit 10 --json conclusion,startedAt,updatedAt \
  --jq '[.[] | select(.conclusion=="success") |
        ((.updatedAt | fromdateiso8601) - (.startedAt | fromdateiso8601))] |
        (add / length / 60) | "Average: \(. * 10 | round / 10) min"'

echo ""
echo "--- Frontend CD run time (last 10 successful: 'Deploy Frontend (Dev)') ---"
gh run list --repo "$REPO" --workflow "Deploy Frontend (Dev)" \
  --limit 20 --json conclusion,startedAt,updatedAt \
  --jq '[.[] | select(.conclusion=="success") |
        ((.updatedAt | fromdateiso8601) - (.startedAt | fromdateiso8601))] |
        (add / length / 60) | "Average: \(. * 10 | round / 10) min"'

echo ""
echo "--- Deployment frequency: Frontend (last 30 days) ---"
gh run list --repo "$REPO" --workflow "Deploy Frontend (Dev)" \
  --limit 100 --json conclusion,createdAt \
  --jq '[.[] | select(.conclusion=="success") |
        select((.createdAt | fromdateiso8601) > (now - 2592000))] |
        length | "Successful deploys in last 30 days: \(.)"'

echo ""
echo "--- CFR: CI (last 50 runs, success+failure only) ---"
gh run list --repo "$REPO" --workflow "Continuous Integration" \
  --limit 50 --json conclusion \
  --jq '[.[] | select(.conclusion == "success" or .conclusion == "failure")] |
        {"total": length, "failed": ([.[] | select(.conclusion=="failure")] | length)} |
        "CFR: \(.failed)/\(.total) = \(.failed / .total * 100 | round)% (note: all failures on develop — WIP noise, not production gate)"'

echo ""
echo "--- CFR: Frontend deploy (last 20 runs) ---"
gh run list --repo "$REPO" --workflow "Deploy Frontend (Dev)" \
  --limit 20 --json conclusion \
  --jq '[.[] | select(.conclusion == "success" or .conclusion == "failure")] |
        {"total": length, "failed": ([.[] | select(.conclusion=="failure")] | length)} |
        "CFR: \(.failed)/\(.total) = \(.failed / .total * 100 | round)%"'

echo ""
echo "--- Workflow name discovery (for updating this script) ---"
gh run list --repo "$REPO" --limit 30 --json workflowName \
  --jq '[.[].workflowName] | unique | sort | .[]'

echo ""
echo "=== END ==="
