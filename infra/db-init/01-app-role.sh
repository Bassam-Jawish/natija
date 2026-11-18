#!/bin/sh
# Runs once when the database volume is first created: the application role, which can never
# bypass row-level security, with the password from APP_DB_PASSWORD.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v app_password="$APP_DB_PASSWORD" <<'EOSQL'
SELECT format('CREATE ROLE natija_app LOGIN NOBYPASSRLS PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'natija_app') \gexec
EOSQL
