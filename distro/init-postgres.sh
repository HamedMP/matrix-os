#!/bin/bash
# Create per-user databases for multi-user dev profile.
# Mounted as /docker-entrypoint-initdb.d/init-postgres.sh
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE matrixos_alice;
    CREATE DATABASE matrixos_bob;
    GRANT ALL PRIVILEGES ON DATABASE matrixos_alice TO matrixos;
    GRANT ALL PRIVILEGES ON DATABASE matrixos_bob TO matrixos;
EOSQL
