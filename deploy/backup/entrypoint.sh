#!/bin/sh
# Runs backup.sh on BACKUP_SCHEDULE (cron syntax, server time; default 02:30 every day).
set -eu
echo "${BACKUP_SCHEDULE:-30 2 * * *} /scripts/backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root
echo "Backups scheduled: ${BACKUP_SCHEDULE:-30 2 * * *}; keeping ${BACKUP_KEEP_DAYS:-14} days in /backups${BACKUP_REMOTE:+, copying to $BACKUP_REMOTE}"
exec crond -f -l 8
