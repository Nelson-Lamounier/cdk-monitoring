#!/bin/bash
# etcd Restore RTO Test
#
# Run this on the control plane node to measure real RTO.
# Times the full restore sequence from snapshot pull to healthy cluster.
#
# Pre-requisites:
#   - Run on the control plane node (has etcd, kubeadm PKI, kubectl access)
#   - AWS CLI authenticated with instance role (dr-backups/* read access)
#   - Bucket name resolved from SSM (see below)
#
# Usage:
#   BUCKET=$(aws ssm get-parameter --name /k8s/development/scripts-bucket \
#              --query Parameter.Value --output text)
#   sudo bash etcd-restore-rto-test.sh "$BUCKET"
#
# The script does a real restore — run against a non-critical cluster state
# or immediately before a planned maintenance window. The original data dir
# is preserved as /var/lib/etcd-backup-<timestamp> for rollback.

set -euo pipefail

BUCKET="${1:?Usage: $0 <s3-bucket-name>}"
SNAPSHOT_KEY="dr-backups/etcd/snapshot.db"
SNAPSHOT_PATH="/tmp/etcd-snapshot-rto-test.db"
RESTORE_DIR="/var/lib/etcd-restore"
ETCD_CERTS="--cacert=/etc/kubernetes/pki/etcd/ca.crt \
            --cert=/etc/kubernetes/pki/etcd/server.crt \
            --key=/etc/kubernetes/pki/etcd/server.key"
ETCD_ENDPOINT="https://127.0.0.1:2379"

CP_IP=$(hostname -I | awk '{print $1}')
CP_NAME=$(hostname)

START=$(date +%s)
echo "=== etcd Restore RTO Test ==="
echo "Started: $(date)"
echo "Control plane: ${CP_NAME} (${CP_IP})"
echo ""

echo "[1/6] Stopping etcd..."
sudo systemctl stop etcd
echo "      etcd stopped at +$(( $(date +%s) - START ))s"

echo ""
echo "[2/6] Pulling snapshot from S3..."
aws s3 cp "s3://${BUCKET}/${SNAPSHOT_KEY}" "${SNAPSHOT_PATH}"
echo "      Snapshot downloaded at +$(( $(date +%s) - START ))s"
SNAPSHOT_SIZE=$(du -sh "${SNAPSHOT_PATH}" | cut -f1)
echo "      Snapshot size: ${SNAPSHOT_SIZE}"

echo ""
echo "[3/6] Restoring snapshot..."
sudo ETCDCTL_API=3 etcdctl snapshot restore "${SNAPSHOT_PATH}" \
  --data-dir="${RESTORE_DIR}" \
  --name="${CP_NAME}" \
  --initial-cluster="${CP_NAME}=https://${CP_IP}:2380" \
  --initial-advertise-peer-urls="https://${CP_IP}:2380"
echo "      Restore complete at +$(( $(date +%s) - START ))s"

echo ""
echo "[4/6] Swapping data directory..."
BACKUP_DIR="/var/lib/etcd-backup-$(date +%s)"
sudo mv /var/lib/etcd "${BACKUP_DIR}"
sudo mv "${RESTORE_DIR}" /var/lib/etcd
echo "      Original data preserved at: ${BACKUP_DIR}"

echo ""
echo "[5/6] Restarting etcd..."
sudo systemctl start etcd
echo "      etcd started at +$(( $(date +%s) - START ))s"

echo ""
echo "[6/6] Waiting for cluster healthy..."
until sudo ETCDCTL_API=3 etcdctl endpoint health \
  --endpoints="${ETCD_ENDPOINT}" \
  ${ETCD_CERTS} 2>/dev/null; do
  echo "      ...waiting (+$(( $(date +%s) - START ))s)"
  sleep 2
done

END=$(date +%s)
ELAPSED=$(( END - START ))

echo ""
echo "=== RESULT ==="
echo "Restore RTO: ${ELAPSED} seconds ($(( ELAPSED / 60 )) min $(( ELAPSED % 60 )) sec)"
echo "Finished: $(date)"
echo ""
echo "Next step: update reasearch-brain/local/dora-metrics-*.md with this number."
echo "Rollback available at: ${BACKUP_DIR}"
