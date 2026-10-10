#!/bin/bash
# Sourced only from the immutable benchmark image. Never production databases.
start_fixture_postgres() {
  local pg_bin=/usr/lib/postgresql/16/bin
  [[ $(id -u) == 10001 ]] || { echo 'PostgreSQL fixture requires isolated nonroot UID' >&2; return 64; }
  mkdir -m 0700 /work/postgres /work/postgres-socket
  timeout 30s "$pg_bin/initdb" -D /work/postgres --auth-local=trust --auth-host=trust --username=matrix_ci_fixture >/work/results/postgres-init.log
  timeout 30s "$pg_bin/pg_ctl" -D /work/postgres -l /work/results/postgres.log \
    -o "-h 127.0.0.1 -p 5432 -k /work/postgres-socket -c max_connections=128 -c shared_buffers=128MB" -w start
  timeout 10s "$pg_bin/createdb" -h 127.0.0.1 -U matrix_ci_fixture matrix_ci_platform_fixture_admin
  export MATRIX_PLATFORM_FIXTURE_POSTGRES_URL=postgresql://matrix_ci_fixture@127.0.0.1:5432/matrix_ci_platform_fixture_admin
  # MATRIX_TEST_POSTGRES_URL deliberately stays unset: hosted race/root contracts
  # keep their original collection gates and are separate required checks.
}
stop_fixture_postgres() {
  [[ -f /work/postgres/postmaster.pid ]] || return 0
  timeout 15s /usr/lib/postgresql/16/bin/pg_ctl -D /work/postgres -m immediate -w stop || {
    echo 'PostgreSQL fixture cleanup failed; disposable container teardown will terminate it' >&2
    return 1
  }
}
