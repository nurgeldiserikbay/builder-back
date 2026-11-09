FROM postgres:17-alpine
RUN apk add --no-cache rclone gnupg tzdata
COPY backup.sh restore.sh entrypoint.sh /scripts/
RUN chmod +x /scripts/*.sh
ENTRYPOINT ["/scripts/entrypoint.sh"]
