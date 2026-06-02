#!/bin/sh
set -e
mkdir -p /app/data
chown aprs:aprs /app/data
exec gosu aprs "$@"
