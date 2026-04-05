#!/bin/bash
set -e

PGDATA="/data/postgresql"
VALKEY_DIR="/data/valkey"

# Ensure data directories exist
mkdir -p "$PGDATA" "$VALKEY_DIR"
chown postgres:postgres "$PGDATA"

# --- PostgreSQL ---
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "Initializing PostgreSQL..."
  su postgres -c "/usr/lib/postgresql/16/bin/initdb -D $PGDATA"
  # Allow local connections without password (IPv4 + IPv6)
  echo "local all all trust" > "$PGDATA/pg_hba.conf"
  echo "host all all 127.0.0.1/32 trust" >> "$PGDATA/pg_hba.conf"
  echo "host all all ::1/128 trust" >> "$PGDATA/pg_hba.conf"
  # Listen on localhost only
  sed -i "s/#listen_addresses = 'localhost'/listen_addresses = 'localhost'/" "$PGDATA/postgresql.conf"
  PG_FIRST_RUN=1
fi

# --- Start PostgreSQL and Valkey in parallel ---
echo "Starting PostgreSQL and Valkey..."
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA -l /dev/null start"

valkey-server \
  --daemonize yes \
  --bind 127.0.0.1 \
  --dir "$VALKEY_DIR" \
  --appendonly yes \
  --appendfsync everysec \
  --loglevel warning

# Wait for both to be ready
until su postgres -c "/usr/lib/postgresql/16/bin/pg_isready" > /dev/null 2>&1; do
  sleep 0.2
done
echo "PostgreSQL is ready."

until valkey-cli ping 2>/dev/null | grep -q PONG; do
  sleep 0.2
done
echo "Valkey is ready."

# Create yhub role and database on first run
if [ "$PG_FIRST_RUN" = "1" ]; then
  su postgres -c "psql -c \"CREATE ROLE yhub WITH LOGIN PASSWORD 'yhub';\""
  su postgres -c "psql -c \"CREATE DATABASE yhub OWNER yhub;\""
  echo "Created yhub role and database."
fi

# --- Init DB tables + Redis consumer group ---
echo "Initializing yhub tables..."
node ./bin/init-db.js

# --- Graceful shutdown ---
cleanup() {
  echo "Shutting down..."
  kill "$YHUB_PID" 2>/dev/null || true
  wait "$YHUB_PID" 2>/dev/null || true
  valkey-cli shutdown nosave 2>/dev/null || true
  su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA stop -m fast" 2>/dev/null || true
  exit 0
}
trap cleanup SIGTERM SIGINT

# --- Start yhub ---
echo "Starting yhub..."
node ./bin/yhub.js &
YHUB_PID=$!
wait "$YHUB_PID"
