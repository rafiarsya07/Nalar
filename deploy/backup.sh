#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# backup.sh — dump the ThoughtLog database, rotate old dumps, and (optionally)
# push a copy off the mini PC.
#
# Why this exists: the mini PC's NVMe has a history of I/O instability from
# chronic power-cycling. A local-only backup on the same disk that might
# fail is not really a backup — so step 3 is the one that actually matters.
#
# Usage (manual):
#   ./deploy/backup.sh
#
# Usage (cron, daily at 3am):
#   crontab -e
#   0 3 * * * /home/<you>/thoughtlog/deploy/backup.sh >> /home/<you>/thoughtlog/deploy/backup.log 2>&1
# ---------------------------------------------------------------------------
set -euo pipefail

# --- config: override any of these via environment variables ---------------
DB_NAME="${DB_NAME:-thoughtlog}"
DB_USER="${DB_USER:-thoughtlog}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/thoughtlog-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"          # how many days of local dumps to keep
# Optional: set this to an rclone remote (e.g. "b2:my-bucket/thoughtlog") to
# also push each dump off-device. Leave empty to skip offsite upload.
RCLONE_REMOTE="${RCLONE_REMOTE:-}"

mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DUMP_FILE="$BACKUP_DIR/thoughtlog-$TIMESTAMP.sql.gz"

echo "[backup] $(date) — dumping $DB_NAME..."
pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$DUMP_FILE"
echo "[backup] wrote $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"

# --- rotate: delete local dumps older than KEEP_DAYS ------------------------
find "$BACKUP_DIR" -name 'thoughtlog-*.sql.gz' -mtime "+$KEEP_DAYS" -print -delete

# --- optional offsite copy --------------------------------------------------
if [ -n "$RCLONE_REMOTE" ]; then
  if command -v rclone >/dev/null 2>&1; then
    echo "[backup] syncing to $RCLONE_REMOTE ..."
    rclone copy "$DUMP_FILE" "$RCLONE_REMOTE"
    echo "[backup] offsite copy done"
  else
    echo "[backup] RCLONE_REMOTE is set but rclone isn't installed — skipping offsite copy" >&2
  fi
else
  echo "[backup] RCLONE_REMOTE not set — dump kept locally only. Set it (or use rsync/scp) to get a real offsite copy."
fi

echo "[backup] done."
