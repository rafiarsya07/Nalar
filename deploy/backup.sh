#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# backup.sh — dump the Nalar database, rotate old dumps, and (optionally)
# push a copy to another machine.
#
# A local-only backup on the same disk that might fail is not really a
# backup, so step 3 (the offsite copy) is the one that actually matters.
#
# Which database: by default this reads DATABASE_URL from the project's .env,
# so it always dumps whatever the app itself is connected to, whatever that
# database happens to be called. Set DB_NAME / DB_USER to override.
#
# Usage (manual):
#   ./deploy/backup.sh
#
# Usage (cron, daily at 3am):
#   crontab -e
#   0 3 * * * /home/<you>/nalar/deploy/backup.sh >> /home/<you>/nalar/deploy/backup.log 2>&1
# ---------------------------------------------------------------------------
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- config: override any of these via environment variables ---------------
if [ -z "${DATABASE_URL:-}" ] && [ -f "$PROJECT_DIR/.env" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$PROJECT_DIR/.env" | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
fi
DB_NAME="${DB_NAME:-}"
DB_USER="${DB_USER:-}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/nalar-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"          # how many days of local dumps to keep
# Optional: set this to an rclone remote (e.g. "b2:my-bucket/nalar") to
# also push each dump off-device. Leave empty to skip offsite upload.
RCLONE_REMOTE="${RCLONE_REMOTE:-}"

mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DUMP_FILE="$BACKUP_DIR/nalar-$TIMESTAMP.sql.gz"

if [ -n "$DB_NAME" ]; then
  echo "[backup] $(date) — dumping $DB_NAME..."
  pg_dump -U "${DB_USER:-$DB_NAME}" "$DB_NAME" | gzip > "$DUMP_FILE"
elif [ -n "${DATABASE_URL:-}" ]; then
  echo "[backup] $(date) — dumping the database from DATABASE_URL..."
  pg_dump "$DATABASE_URL" | gzip > "$DUMP_FILE"
else
  echo "[backup] no DATABASE_URL in .env and no DB_NAME set — nothing to dump" >&2
  exit 1
fi
echo "[backup] wrote $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"

# --- rotate: delete local dumps older than KEEP_DAYS ------------------------
find "$BACKUP_DIR" -name 'nalar-*.sql.gz' -mtime "+$KEEP_DAYS" -print -delete

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
