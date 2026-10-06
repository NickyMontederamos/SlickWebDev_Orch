#!/usr/bin/env bash
# Applies the schema to a throwaway PostgreSQL + pgvector container and runs the assertions.
#
# The database lives in memory, has no network, and is removed when the script ends.
# This script takes no connection settings on purpose: it cannot be pointed at a real database.
#
# Needs: docker. Run: npm run test:sql        (PG_IMAGE overrides the image)
set -euo pipefail
cd "$(dirname "$0")/../.."

IMAGE="${PG_IMAGE:-pgvector/pgvector:pg16}"
NAME="orch-sqltest-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" --network none --memory 512m --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=throwaway -e POSTGRES_DB=nexus_test "$IMAGE" >/dev/null

# The image starts a temporary server to initialise, then restarts. Wait for the real one.
for _ in $(seq 1 60); do
  if docker logs "$NAME" 2>&1 | grep -q 'PostgreSQL init process complete' \
     && docker exec "$NAME" pg_isready -q -U postgres -d nexus_test; then break; fi
  sleep 1
done

run() { docker exec -i -e PGOPTIONS='-c client_min_messages=warning' "$NAME" psql -U postgres -d nexus_test -v ON_ERROR_STOP=1 -q "$@"; }

echo "1/3 apply schema"
run < sql/TCC_Integrated_Nexus_Schema.sql
echo "2/3 apply schema again (must be safe to repeat)"
run < sql/TCC_Integrated_Nexus_Schema.sql
echo "3/3 assertions"
run -o /dev/null < tests/sql/assertions.sql
echo "SQL: passed on $(run -At -c "select 'PostgreSQL ' || current_setting('server_version') || ', pgvector ' || extversion from pg_extension where extname = 'vector'")"
