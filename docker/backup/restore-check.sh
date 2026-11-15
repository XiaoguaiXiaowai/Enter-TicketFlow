#!/bin/sh
# 恢复演练：取最新加密备份 -> 校验 -> 恢复到独立数据库 -> 校验核心表行数 -> 清理。
# 不触碰 ticket 生产库；用于上线前与定期演练。
# 用法：docker compose --profile tools run --rm restore-check
set -eu

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_SUPERUSER:?POSTGRES_SUPERUSER is required}"
: "${POSTGRES_SUPERUSER_PASSWORD:?POSTGRES_SUPERUSER_PASSWORD is required}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE is required}"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
LATEST="$(ls -1t "$BACKUP_DIR"/ticket-*.dump.enc 2>/dev/null | head -1 || true)"
if [ -z "$LATEST" ]; then
  echo "[restore-check] no backup found in $BACKUP_DIR" >&2
  exit 1
fi

echo "[restore-check] verifying checksum: $LATEST"
sha256sum -c "$LATEST.sha256"

export PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD"
SCRATCH_DB="restore_check_$(date -u +%s)"
PLAIN_DUMP="$(mktemp)"

cleanup() {
  dropdb -h postgres -U "$POSTGRES_SUPERUSER" --if-exists "$SCRATCH_DB" >/dev/null 2>&1 || true
  rm -f "$PLAIN_DUMP"
}
trap cleanup EXIT

openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPTION_PASSPHRASE -in "$LATEST" -out "$PLAIN_DUMP"

echo "[restore-check] restoring into $SCRATCH_DB"
createdb -h postgres -U "$POSTGRES_SUPERUSER" "$SCRATCH_DB"
pg_restore -h postgres -U "$POSTGRES_SUPERUSER" -d "$SCRATCH_DB" \
  --no-owner --no-privileges --exit-on-error "$PLAIN_DUMP" >/dev/null

TENANTS="$(psql -h postgres -U "$POSTGRES_SUPERUSER" -d "$SCRATCH_DB" -tA -c 'SELECT count(*) FROM tenants')"
TICKETS="$(psql -h postgres -U "$POSTGRES_SUPERUSER" -d "$SCRATCH_DB" -tA -c 'SELECT count(*) FROM tickets')"
AUDIT="$(psql -h postgres -U "$POSTGRES_SUPERUSER" -d "$SCRATCH_DB" -tA -c 'SELECT count(*) FROM audit_logs')"

echo "[restore-check] ok tenants=$TENANTS tickets=$TICKETS audit_logs=$AUDIT backup=$LATEST"