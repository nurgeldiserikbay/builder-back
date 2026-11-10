#!/bin/sh
# Restores a dump into the database. Destroys the current data, so it asks for confirmation.
# Usage (stop the app first, see deploy/README.md):
#   docker compose -f compose.prod.yaml --env-file .env.production run --rm --entrypoint /scripts/restore.sh backup /backups/buildpath-....dump[.gpg]
set -eu
file="${1:?usage: restore.sh /backups/buildpath-YYYYMMDDTHHMMSSZ.dump[.gpg]}"
[ -f "$file" ] || { echo "No such file: $file"; exit 1; }

case "$file" in
  *.gpg)
    : "${BACKUP_ENCRYPTION_PASSPHRASE:?set BACKUP_ENCRYPTION_PASSPHRASE to decrypt}"
    plain="/tmp/restore.dump"
    printf '%s' "$BACKUP_ENCRYPTION_PASSPHRASE" | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 0 --decrypt --output "$plain" "$file"
    file="$plain" ;;
esac

pg_restore --list "$file" > /dev/null
if [ "${RESTORE_CONFIRM:-}" != "yes" ]; then
  printf 'This replaces ALL data in database "%s" on %s with %s. Type yes to continue: ' "$PGDATABASE" "$PGHOST" "$1"
  read -r answer
  [ "$answer" = "yes" ] || { echo "Cancelled."; exit 1; }
fi
pg_restore --clean --if-exists --no-owner --exit-on-error --single-transaction --dbname="$PGDATABASE" "$file"
echo "Restored $1. Start the app again and check it."
