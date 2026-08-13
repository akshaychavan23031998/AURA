# Docker infrastructure

Phase 8 provides an isolated PostgreSQL 17.6 development dependency. It does not containerize any AURA application service.

From the repository root, supply a local-only password and start PostgreSQL:

```powershell
$env:POSTGRES_PASSWORD = "replace-with-local-password"
docker compose -f infrastructure/docker/postgres.compose.yml up -d
```

The container is named `aura-postgres` and binds only `127.0.0.1:5433` to PostgreSQL's container port `5432`, keeping it separate from other local PostgreSQL instances. The named volume preserves local database data. Use a separate database whose name ends in `_test` for `TEST_DATABASE_URL`; identity tests deliberately rebuild that database's `public` schema.
