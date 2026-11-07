#!/usr/bin/env bash
# `make load`: the whole bench on this machine, against the shared infra-postgres
# container (a disposable `openedbot_load` database, dropped at the end) and the fake
# Hermes streaming like a model. Nothing here reaches a lab runtime or a model.
#
#   LOAD_SESSIONS=50|100|200|500   connected operators (one SSE each)   [200]
#   LOAD_CONVERSATIONS=N           threads talking in a closed loop     [organizations]
#   LOAD_DURATION_SECONDS=N        conversation phase                   [60]
#   LOAD_THINK_MS=N                pause between two turns of a thread  [10000]
#   LOAD_WORKERS=N                 worker processes                     [2]
#   LOAD_SNAPSHOT_INTERVAL_MS=N    roster + history reload per session  [5000]
#   LOAD_STREAM_DELTAS=N           deltas per run, 100 ms apart         [30]
#   LOAD_API_DB_MAX / LOAD_WORKER_DB_MAX / LOAD_WORKER_MAX_ACTIVE_RUNS   pool and concurrency
#   LOAD_ENFORCE_SALES_GATE=1      60-minute soak with the RSS growth gate
#   LOAD_KEEP_DATABASE=1           keep openedbot_load for inspection
#
# The report also charges the conversation phase's CPU (average cores, from
# /proc) to the API, each worker and the fake Hermes.
#
# Artefacts: tmp/load/<timestamp>/{api,worker-1,worker-2,fake-hermes}.log and
# report.json; tmp/load/latest points at the last run.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
container="${OPENEDBOT_POSTGRES_CONTAINER:-infra-postgres}"
database="openedbot_load"
tier="${LOAD_SESSIONS:-200}"
api_port="${LOAD_API_PORT:-18790}"
fake_port="${LOAD_HERMES_PORT:-18642}"
fake_token="fake-hermes-token"
worker_token="load-worker-token"
metrics_token="load-metrics-token"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
artefacts="$root/tmp/load/$stamp"
temp_dir="$(mktemp -d)"
manifest="$temp_dir/manifest.json"
pids=()

say() { printf '[load] %s\n' "$*"; }

stop_all() {
  local pid
  for pid in "${pids[@]:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}

psql_admin() {
  docker exec -i "$container" psql -v ON_ERROR_STOP=1 -q -U "$pg_user" -d "$pg_admin_db"
}

drop_database() {
  psql_admin <<SQL >/dev/null
select pg_terminate_backend(pid) from pg_stat_activity where datname = '$database' and pid <> pg_backend_pid();
drop database if exists $database;
SQL
}

cleanup() {
  stop_all
  if [[ "${LOAD_KEEP_DATABASE:-0}" == "1" ]]; then
    say "keeping the disposable database $database for inspection"
  else
    drop_database || true
  fi
  rm -rf "$temp_dir"
}
trap cleanup EXIT

case "$tier" in 50|100|200|500) ;; *) say "LOAD_SESSIONS must be 50, 100, 200 or 500." >&2; exit 1 ;; esac

# The shared dev-infra container must already exist; db.sh --up restarts it when
# stopped, waits for it and never creates one.
bash "$root/scripts/db.sh" --up
pg_user="$(docker exec "$container" printenv POSTGRES_USER)"
pg_admin_db="$(docker exec "$container" printenv POSTGRES_DB)"
drop_database
psql_admin <<SQL >/dev/null
create database $database;
grant connect on database $database to openedbot_api, openedbot_worker;
SQL
for migration in "$root"/db/migrations/*.sql; do
  docker exec -i "$container" psql -v ON_ERROR_STOP=1 -q -U "$pg_user" -d "$database" < "$migration" >/dev/null
done
say "database $database migrated"

mkdir -p "$artefacts"
ln -sfn "$stamp" "$root/tmp/load/latest"
encryption_key="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
api_url="postgres://openedbot_api:openedbot_api_dev@127.0.0.1:5432/$database"
worker_url="postgres://openedbot_worker:openedbot_worker_dev@127.0.0.1:5432/$database"
fake_url="http://127.0.0.1:$fake_port"

RUNTIME_TOKEN_ENCRYPTION_KEY="$encryption_key" LOAD_DATABASE_URL="$api_url" LOAD_MANIFEST="$manifest" \
LOAD_SESSIONS="$tier" LOAD_HERMES_URL="$fake_url" LOAD_HERMES_TOKEN="$fake_token" \
  bun "$root/tests/load/seed.ts"

FAKE_HERMES_PORT="$fake_port" FAKE_HERMES_TOKEN="$fake_token" FAKE_HERMES_CAPACITY=1000 \
FAKE_HERMES_DELAY_MS="${LOAD_DELAY_MS:-40}" FAKE_HERMES_STREAM_DELTAS="${LOAD_STREAM_DELTAS:-30}" \
FAKE_HERMES_STREAM_INTERVAL_MS=100 \
  bun "$root/tests/fake-hermes/server.ts" >"$artefacts/fake-hermes.log" 2>&1 &
pids+=("$!")
watched="fake-hermes:$!"

OPENEDBOT_ENV=test API_PORT="$api_port" API_TRUST_PROXY=1 API_IDLE_TIMEOUT="${LOAD_API_IDLE_TIMEOUT:-30}" API_DB_MAX="${LOAD_API_DB_MAX:-16}" \
API_DATABASE_URL="$api_url" RUNTIME_TOKEN_ENCRYPTION_KEY="$encryption_key" \
EVENTS_INTERNAL_TOKEN="$worker_token-events" RELAY_INTERNAL_TOKEN="$worker_token-relay" \
INVENTORY_INTERNAL_TOKEN="$worker_token-inventory" RUN_KEY_SECRET="$worker_token-run-key" METRICS_INTERNAL_TOKEN="$metrics_token" \
BLOB_DRIVER=file BLOB_FILE_ROOT="$temp_dir/blobs" TEST_HERMES_URL="$fake_url" \
  bun "$root/apps/api/src/index.ts" >"$artefacts/api.log" 2>&1 &
pids+=("$!")
api_pid="${pids[-1]}"
watched="$watched,api:$api_pid"

for worker in $(seq 1 "${LOAD_WORKERS:-2}"); do
  OPENEDBOT_ENV=test WORKER_ID="load-worker-$worker" WORKER_DATABASE_URL="$worker_url" \
  RUNTIME_TOKEN_ENCRYPTION_KEY="$encryption_key" EVENTS_INTERNAL_TOKEN="$worker_token-events" \
  RELAY_INTERNAL_TOKEN="$worker_token-relay" RUN_KEY_SECRET="$worker_token-run-key" \
  API_INTERNAL_URL="http://127.0.0.1:$api_port" BLOB_DRIVER=file BLOB_FILE_ROOT="$temp_dir/blobs" \
  WORKER_DB_MAX="${LOAD_WORKER_DB_MAX:-16}" WORKER_MAX_ACTIVE_RUNS="${LOAD_WORKER_MAX_ACTIVE_RUNS:-}" \
  TEST_HERMES_URL="$fake_url" \
    bun "$root/apps/worker/src/index.ts" >"$artefacts/worker-$worker.log" 2>&1 &
  pids+=("$!")
  watched="$watched,worker-$worker:$!"
done

for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$api_port/api/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$api_pid" 2>/dev/null; then
    sed -n '1,80p' "$artefacts/api.log" >&2
    exit 1
  fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$api_port/api/health" >/dev/null
say "API, ${LOAD_WORKERS:-2} worker(s) and fake Hermes up; artefacts in tmp/load/$stamp"

status=0
LOAD_API_URL="http://127.0.0.1:$api_port" LOAD_MANIFEST="$manifest" LOAD_METRICS_TOKEN="$metrics_token" \
LOAD_SESSIONS="$tier" LOAD_LOG_DIR="$artefacts" LOAD_REPORT="$artefacts/report.json" LOAD_PIDS="$watched" \
BUN_CONFIG_MAX_HTTP_REQUESTS="${LOAD_MAX_HTTP_REQUESTS:-2048}" \
  bun "$root/tests/load/bench.ts" || status=$?
if [[ "$status" -eq 0 ]]; then say "PASS (report: tmp/load/$stamp/report.json)"; else say "FAIL with exit $status (report: tmp/load/$stamp/report.json)" >&2; fi
exit "$status"
