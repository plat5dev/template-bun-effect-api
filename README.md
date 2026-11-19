# Bun + Effect API starter

A lean Plat5 reference API built with **Bun 1.4**, **Effect v4** (`HttpApi` + `@effect/sql-sqlite-bun`), TypeScript 7, and Effect's native Prometheus + OTLP observability. It serves tasks scoped to Plat5 `project` nodes and a user-scoped profile.

Plat5's gateway owns auth, node resolution, and authorization; this service owns business logic only ([`docs/guides/write-a-service.md`](https://github.com/plat5dev/plat5/blob/master/docs/guides/write-a-service.md)).

## Quick start

```bash
plat5 start
```

`plat5 start` runs Plat5, applies `plat5.yml`, and runs this API beside it via `docker-compose.yml`. Call it through the gateway with the personal key from `plat5 status`:

```bash
KEY=plat5-k-2-…
curl -X POST localhost:5400/orgs/dev/projects -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"display_name": "Demo"}'
curl -X POST localhost:5400/orgs/dev/projects/demo/tasks -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"title": "Ship it"}'
curl localhost:5400/orgs/dev/projects/demo/tasks -H "Authorization: Bearer $KEY"
curl -X PUT localhost:5400/user/profile -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"bio": "Hello"}'
```

To run locally outside Docker (`-x app` points the gateway at your host port 3000):

```bash
plat5 start -x app
bun install
TASK_ASSIGNEE_PERMISSION=project:read bun run dev
```

## Endpoints

| Gateway path | Upstream path | Notes |
|---|---|---|
| `GET …/tasks` | `GET /projects/{project_id}/tasks` | Cursor pagination (`limit` default 50, max 100; `starting_after` lowercase ULID) ([`lists.md`](https://github.com/plat5dev/plat5/blob/master/docs/reference/lists.md)) |
| `POST …/tasks` | `POST /projects/{project_id}/tasks` | Requires `X-Plat5-Member-Id`; evaluates `assignee_id` against identity |
| `GET / PATCH / DELETE …/tasks/{task_id}` | `/projects/{project_id}/tasks/{task_id}` | Tenant-scoped by `project_id`; no-op `PATCH` skips DB write |
| `GET / PUT /user/profile` | `/users/{user_id}/profile` | `GET` lazily creates an empty profile; `PUT` validates `bio` ≤ 2000 code points |
| — | `GET /openapi.json`, `GET /docs` | OpenAPI 3.1 spec + Swagger UI |
| Internal (`INTERNAL_PORT=3001`) | `GET /health/live`, `GET /health/ready`, `GET /metrics` | Liveness, SQLite readiness (2s timeout), Prometheus scrape ([`health.md`](https://github.com/plat5dev/plat5/blob/master/docs/reference/health.md)) |

## Plat5 conventions implemented

- **Errors** ([`errors.md`](https://github.com/plat5dev/plat5/blob/master/docs/reference/errors.md)): Uniform `{ error: { type, code, message, request_id, details } }` envelope for `400`/`404`/`422`/`500`/`503`.
- **Audit headers** ([`audit.md`](https://github.com/plat5dev/plat5/blob/master/docs/concepts/audit.md)): Writes emit `X-Plat5-Audit-Details` (visible-ASCII JSON, ≤ 4096 bytes) and `POST` emits `X-Plat5-Audit-Created`.
- **Access evaluation** ([`internal.md`](https://github.com/plat5dev/plat5/blob/master/docs/reference/api/internal.md)): Setting an `assignee_id` checks `POST {IDENTITY_INTERNAL_URL}/access/v1/evaluation` for `TASK_ASSIGNEE_PERMISSION` (fail-closed `503`), forwarding `X-Request-ID` and W3C `traceparent`.
- **Lifecycle consumer** ([`lifecycle.md`](https://github.com/plat5dev/plat5/blob/master/docs/concepts/lifecycle.md)): Follows `GET {IDENTITY_INTERNAL_URL}/internal/events?types=node.purged,user.deleted&limit=100`, committing deletes + `feed_cursors` in one SQLite transaction, resetting on `409 CURSOR_AHEAD`, and retrying failures after 5s.
- **Telemetry** ([`telemetry.md`](https://github.com/plat5dev/plat5/blob/master/docs/reference/telemetry.md)): JSON stdout logs (`timestamp`, `level`, `message`, `request_id`, `trace_id`, `span_id`), Prometheus `/metrics`, and opt-in OTLP traces/metrics via Effect's native `OtlpTracer` / `OtlpMetrics` when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

## Environment

See `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `INTERNAL_PORT` | `3000` / `3001` | Public API and internal health/metrics ports |
| `DATABASE_PATH` | `./data/app.db` | SQLite database path |
| `APP_VERSION` | `dev` | Reported as `service.version` (set via `VERSION` build arg in `Dockerfile`) |
| `TASK_ASSIGNEE_PERMISSION` | **required** | Permission checked for task assignees (e.g. `project:read`) |
| `IDENTITY_INTERNAL_URL` | unset | Identity internal base URL for assignee checks and lifecycle log |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP HTTP base URL (`OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_*_EXPORTER`, `OTEL_TRACES_SAMPLER_RATIO`, `OTEL_SDK_DISABLED` supported) |

## Layout

```
src/
  main.ts                 # Single composition root (servers + SQL + telemetry + lifecycle)
  Config.ts               # AppConfig and TelemetryConfig via Effect Config
  Sql.ts + migrations/    # SQLite client and migrations
  Access.ts               # Identity access evaluation client
  Lifecycle.ts            # Identity lifecycle event consumer
  Telemetry.ts            # Prometheus scrape, process metrics, OTLP exporters
  Http.ts                 # HttpApi composition, route handlers, /openapi.json, /docs
  InternalHttp.ts         # /health/live, /health/ready, /metrics
  Tasks.ts                # Task model, repo, service, and HttpApi group
  Profiles.ts             # Profile model, repo, service, and HttpApi group
  plat5/
    Errors.ts             # Plat5 error envelope + HttpApi schema-error middleware
    Audit.ts              # X-Plat5-Audit-Details / X-Plat5-Audit-Created helpers
    Log.ts                # Structured JSON stdout logger with trace & request correlation
    HttpObservability.ts  # Server spans, HTTP metrics, access logs, query redaction
    Pagination.ts         # ULID & cursor pagination helpers
```

## Commands & Docker

```bash
bun run check             # tsc --noEmit
bun test                  # bun test (in-memory HttpRouter suites)
docker build --target prod --build-arg VERSION=v1.2.3 -t api .
```
