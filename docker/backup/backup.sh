#!/bin/sh
# 全量备份：pg_dump 自定义格式 + AES-256 加密 + SHA256 校验 + 按天保留。
# 用法：docker compose --profile tools run --rm backup
set -eu

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_SUPERUSER:?POSTGRES_SUPERUSER is required}"
: "${POSTGRES_SUPERUSER_PASSWORD:?POSTGRES_SUPERUSER_PASSWORD is required}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE is required}"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$BACKUP_DIR/ticket-$TIMESTAMP.dump.enc"

mkdir -p "$BACKUP_DIR"
export PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD"

echo "[backup] dumping $POSTGRES_DB -> $TARGET"
pg_dump -h postgres -U "$POSTGRES_SUPERUSER" -d "$POSTGRES_DB" -Fc \
  | openssl enc -aes-256-cbc -salt -pbkdf2 -pass env:BACKUP_ENCRYPTION_PASSPHRASE -out "$TARGET"

sha256sum "$TARGET" > "$TARGET.sha256"

find "$BACKUP_DIR" -name 'ticket-*.dump.enc' -type f -mtime +"$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -name 'ticket-*.dump.enc.sha256' -type f -mtime +"$RETENTION_DAYS" -delete

echo "[backup] done: $(ls -lh "$TARGET" | awk '{print $5}')"
ls -1t "$BACKUP_DIR"/ticket-*.dump.enc | head -5