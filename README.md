# Bun + Effect API template

Reference Plat5 business service: **Bun** runtime + package manager, **Effect** (`HttpApi` + `@effect/sql-sqlite-bun`).

Gateway admits the caller and fills `{subject.*}` into `upstream`. This service trusts that path and owns business logic only. It does not parse `Authorization` or `X-API-Key`, and it does not read identity from headers.

That trust is the security model: **nothing but the gateway may reach this service.** Anyone who can call it directly can name any org in the path. Locally, `plat5 start` puts the container on the Plat5 network, the gateway calls it as `http://api:3000`, and the host port is bound to `127.0.0.1` for your own curls. In production, don't publish the port at all.

## Stack

| Piece | Choice |
|-------|--------|
| Runtime / installs | Bun |
| HTTP | `effect` + `@effect/platform` + `@effect/platform-bun` |
| Schema | `effect/Schema` |
| DB | SQLite via `@effect/sql-sqlite-bun` |
| IDs | ULID |

## Demo domain

This process listens on the rewritten path.

| Resource | Scope | Credential | Edge | Listen path |
|----------|-------|------------|------|-------------|
| Profiles | `user` | user JWT or user API key | `/user/profile` | `/users/{user_id}/profile` |
| Projects | `organization` | member key or member session | `/org/projects` | `/organizations/{organization_id}/projects` |
| Tasks | `organization` | member key or member session | `/org/projects/{project_id}/tasks` | `.../projects/{project_id}/tasks` |

`GET` and `PUT` on the profile. Projects and tasks: `GET` and `POST` on the collection; `GET`, `PATCH`, and `DELETE` on `{project_id}` / `{task_id}`.

Profiles are the person's. Projects and tasks are the org's: they store the owner, not who made them (the org's audit log records who did what). Organization scope is a member key or member session, not a user JWT. Handlers read `user_id` and `organization_id` from those path params.

## Lists

Project and task lists page like every Plat5 list (plat5 [`docs/lists.md`](https://github.com/plat5dev/plat5/blob/master/docs/lists.md)). `src/plat5/Pagination.ts` reads the params.

| | |
|---|---|
| `limit` | Default 50, max 100. Over the max is clamped. Under 1 or not a number → **422** |
| `starting_after` | The `id` of the last item on the previous page. Not a ULID → **422** |
| Answer | `{"projects": [...], "has_more": false}`, in `id` order (oldest first) |

## Audit details

The gateway records each write before it reaches this service. Each write says what it changed on `X-Plat5-Audit-Details`, and a create names its new id on `X-Plat5-Audit-Created` (plat5 [`docs/audit.md`](https://github.com/plat5dev/plat5/blob/master/docs/audit.md#what-a-service-adds)). The gateway stores them with the event and strips them before the client sees the response. `src/plat5/Audit.ts` builds and encodes them; services call it where the old and new values are in hand, and it adds the headers to the current response.

| Write | Details |
|-------|---------|
| `POST` projects | `project_id`, `name`. Created: the project id |
| `PATCH` a project | `name`, `description` as changes |
| `POST` tasks | `task_id`, `title`, `status`. Created: the task id |
| `PATCH` a task | `title`, `status` as changes |
| `PUT` the profile | `display_name`, `bio` as changes |
| `DELETE` | None: the route and its path say what happened |

A change is `{"from": …, "to": …}`, only for fields that changed; a write that changed nothing sends no header. Never put a secret in either header.

## Quick start

```bash
plat5 init my-app --template bun-effect-api
cd my-app
plat5 start
```

You need Docker, nothing else. `plat5 start` runs Plat5, its modules, this API on `:3000`, and the starter web app on `:3001`, then prints every link, login, and a key to call the API with. Sign in to the web app as `dev@example.com` / `password`.

`plat5.template.yml` drives init: upstreams, routes, and `app:` (this compose file, and the web app's origin). The CLI fetches this repo, copies the tree, and writes `plat5.yml`.

To run the API on your own machine instead (your debugger, your editor's runner):

```bash
plat5 start -x app
bun install
bun run dev           # API :3000, health :3001
```

Community / fork:
```bash
plat5 init my-app --template plat5dev/template-bun-effect-api
# or: plat5 init my-app --template you/my-template
```

## Commands

```bash
bun run dev    # bun --watch src/main.ts
bun run start  # bun src/main.ts
bun run check  # tsc --noEmit
```

## Ports

| Port | Env | Purpose |
|------|-----|---------|
| 3000 | `PORT` | Public API (+ `/docs` OpenAPI) |
| 3001 | `INTERNAL_PORT` | `/health/live`, `/health/ready`, `/metrics` (health/metrics not traced) |

## Environment

See `.env.example`. Bun loads `.env` automatically.

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3000` | Public |
| `INTERNAL_PORT` | `3001` | Health + `/metrics` |
| `DATABASE_PATH` | `./data/app.db` | SQLite file |
| `OTEL_SERVICE_NAME` | `api` | Resource `service.name` (standard OTel) |
| `OTEL_RESOURCE_ATTRIBUTES` | unset | Standard bag: `service.namespace=…,service.version=…,…` |
| `OTEL_SERVICE_NAMESPACE` | `api` | Convenience → `service.namespace` |
| `OTEL_SERVICE_VERSION` | `0.0.0` | Convenience → `service.version` |
| `OTEL_SERVICE_INSTANCE_ID` | hostname | Convenience → `service.instance.id` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP destination. Unset → no OTLP |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset | Optional full traces URL |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | unset | Optional full metrics URL |
| `OTEL_TRACES_EXPORTER` | `otlp` when endpoint set | Include `otlp` to push traces |
| `OTEL_METRICS_EXPORTER` | `otlp` when endpoint set | Set `prometheus` to push-off; `/metrics` always on |
| `OTEL_METRIC_EXPORT_INTERVAL` | `30000` | ms (OTLP metrics) |
| `OTEL_SDK_DISABLED` | `false` | Force OTLP off; stdout + `/metrics` remain |
| `OTEL_TRACES_SAMPLER_RATIO` | `1` | Trace sampling ratio |
| `DEPLOYMENT_ENV` / `OTEL_DEPLOYMENT_ENV` | `development` | Resource `deployment.environment` (`OTEL_DEPLOYMENT_ENV` wins) |

## Telemetry

Telemetry aligns with Plat5 service conventions (JSON access logs, `/metrics`, optional OTLP).

| Signal | Path |
|--------|------|
| Logs | JSON access line per request on stdout (not OTLP logs) |
| Metrics scrape | Prometheus `/metrics` on `INTERNAL_PORT` |
| Traces | OTLP HTTP when endpoint set (default) |
| Metrics OTLP | On when endpoint set (default); set `OTEL_METRICS_EXPORTER=prometheus` to opt out |

```bash
# traces push + scrape metrics (no double count)
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 bun run dev

# full OTLP push — do not also scrape /metrics into the same backend
# OTEL_METRICS_EXPORTER=prometheus  # opt out of metrics push

# container → host-published collector
# OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318
```

Under `plat5 start`, the compose file gets `OTEL_EXPORTER_OTLP_ENDPOINT` from the CLI when the observability module is on. Running on your own machine, set it yourself.

Health on `INTERNAL_PORT` does not emit request spans.

## Docker

```bash
docker compose up --build
```

- `local` target: hot reload, source mount
- `prod` target: non-root, frozen `bun install`

## Layout

```
src/
  main.ts              # dual HTTP servers + SQL + optional OTLP
  Telemetry.ts         # OTel resource, scrape + optional OTLP, MetricsScrape
  Api.ts / Http.ts     # HttpApi composition
  InternalHttp.ts      # health + /metrics on INTERNAL_PORT (tracer off)
  AppConfig.ts         # Effect Config
  Sql.ts + migrations/ # SQLite + migrator
  plat5/               # errors, audit details, pagination, HTTP/DB observability
  domain/              # Profile, Project, Task models
  Profiles|Projects|Tasks/  # Api + Http + Repo + Service
routes.identity.yml    # identity public surface (edit or omit)
routes.audit.yml       # GET /org/audit-events, /user/audit-events (omit with AUDIT_ENABLED=false)
routes.yml             # app routes (edge path + upstream)
roles.yml              # roles → labels (member gets projects:write)
```

## Plat5 contracts (do / don't)

**Do**

- Trust the path the gateway wrote. `{subject.*}` is filled into `upstream` before this process sees the request. So nothing but the gateway may reach this service
- Read `user_id` from `/users/{user_id}/profile` (user scope; edge `GET`/`PUT /user/profile`)
- Read `organization_id` from `/organizations/{organization_id}/...` (organization scope; edge `/org/projects...`). A member key or member session, not a user JWT
- Return Plat5 error envelope (`error.type/code/message/request_id/details`)
- Page lists with `limit` / `starting_after` and answer `has_more`
- Say what a write changed on `X-Plat5-Audit-Details`, and a create's id on `X-Plat5-Audit-Created`
- Log one JSON access line per request (`request_id`, `duration_ms`, subject ids from the path when present)
- OTLP traces + metrics when endpoint set; always stdout + `/metrics`
- Publish `routes.yml` to the control plane. A route that needs the subject sets `upstream`

**Don't**

- Parse `Authorization` or `X-API-Key`, or validate JWTs
- Read identity from request headers
- Implement CORS (gateway owns it)
- Set `X-Request-ID` on responses
- Return 401 — the gateway admits the caller

