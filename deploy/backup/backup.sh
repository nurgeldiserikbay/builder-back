#!/bin/sh
# Daily PostgreSQL backup: custom-format dump, integrity check, local retention, optional encrypted off-site copy.
# Uses PGHOST/PGUSER/PGPASSWORD/PGDATABASE. Exit code is non-zero on any failure so it shows up in the logs.
set -eu
dir=/backups
keep_days="${BACKUP_KEEP_DAYS:-14}"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="$dir/buildpath-$stamp.dump"
mkdir -p "$dir"

trap 'rm -f "$file.partial"' EXIT
pg_dump --format=custom --compress=6 --no-owner --file="$file.partial"
# A dump that pg_restore cannot list is broken; never keep it as a backup.
pg_restore --list "$file.partial" > /dev/null
mv "$file.partial" "$file"
echo "$(date -u +%FT%TZ) backup ok: $file ($(du -h "$file" | cut -f1))"

find "$dir" -name 'buildpath-*.dump' -mtime +"$keep_days" -print -delete
find "$dir" -name '*.partial' -mmin +120 -delete

if [ -n "${BACKUP_REMOTE:-}" ]; then
  upload="$file"
  if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
    upload="$file.gpg"
    printf '%s' "$BACKUP_ENCRYPTION_PASSPHRASE" | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 0 \
      --symmetric --cipher-algo AES256 --output "$upload" "$file"
  fi
  rclone copy --no-traverse "$upload" "$BACKUP_REMOTE"
  [ "$upload" != "$file" ] && rm -f "$upload"
  rclone delete --min-age "${keep_days}d" "$BACKUP_REMOTE" || echo "warning: could not prune old off-site copies"
  echo "$(date -u +%FT%TZ) off-site copy ok: $BACKUP_REMOTE"
fi
