#!/bin/sh
# Nightly logical backup of the natija database, kept for RETAIN_DAYS days.
# Copy /backups to a second provider (e.g. object storage) for an off-site copy.
set -e
mkdir -p /backups
while true; do
  stamp=$(date +%Y%m%d-%H%M%S)
  pg_dump -h db -U postgres -d natija -Fc -f "/backups/natija-$stamp.dump" && echo "backup natija-$stamp.dump done"
  find /backups -name 'natija-*.dump' -mtime +"${RETAIN_DAYS:-14}" -delete
  sleep 86400
done
