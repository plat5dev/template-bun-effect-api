# ======================================================================
# Local — hot reload
# ======================================================================
FROM oven/bun:1 AS local

WORKDIR /app

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

USER app

ENV NODE_ENV=production
ENV PORT=3000
ENV INTERNAL_PORT=3001
ENV DATABASE_PATH=/data/app.db

EXPOSE 3000

CMD ["bun", "src/main.ts"]
