# ======================================================================
# Local — hot reload
# ======================================================================
FROM oven/bun:1 AS local

WORKDIR /app

# sqlite3, to look in the database or reset the lifecycle cursor (README).
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

ENV PORT=3000
ENV INTERNAL_PORT=3001
ENV DATABASE_PATH=/data/app.db

EXPOSE 3000

CMD ["bun", "--watch", "src/main.ts"]

# ======================================================================
# Prod — minimal
# ======================================================================
FROM oven/bun:1-slim AS prod

WORKDIR /app

RUN groupadd -r app && useradd -r -g app app \
  && mkdir -p /data && chown app:app /data

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production \
  && chown -R app:app /app

COPY --chown=app:app . .

# The release this image reports as service.version; dev without one.
ARG VERSION=dev
RUN bun -e 'await Bun.write("src/Version.ts", `export const VERSION = ${JSON.stringify(process.env.VERSION)}\n`)'

USER app

ENV NODE_ENV=production
ENV PORT=3000
ENV INTERNAL_PORT=3001
ENV DATABASE_PATH=/data/app.db

EXPOSE 3000

CMD ["bun", "src/main.ts"]
