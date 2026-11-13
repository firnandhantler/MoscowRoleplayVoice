#!/bin/sh
set -eu

: "${APP_DB_USER:?Переменная APP_DB_USER не задана}"
: "${APP_DB_PASSWORD:?Переменная APP_DB_PASSWORD не задана}"
: "${POSTGRES_DB:?Переменная POSTGRES_DB не задана}"

# Пароль не передаётся аргументом командной строки: он читается psql
# из переменных окружения через \getenv. Это не позволяет увидеть его
# в списке процессов.
psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_user APP_DB_USER
\getenv app_password APP_DB_PASSWORD
\getenv db_name POSTGRES_DB

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec

SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'app_user', :'app_password') \gexec

GRANT CONNECT ON DATABASE :"db_name" TO :"app_user";
GRANT USAGE, CREATE ON SCHEMA public TO :"app_user";
SQL

echo "Роль приложения ${APP_DB_USER} подготовлена."
