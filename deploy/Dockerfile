# syntax=docker/dockerfile:1
# Образы стенда и будущего дистрибутива (ADR-011, ADR-019). Одна сборка, два образа:
#   docker build --target api   -t oxrana-api:TAG   -f deploy/Dockerfile .
#   docker build --target proxy -t oxrana-proxy:TAG -f deploy/Dockerfile .
# `api`   — сервер (Fastify), миграции и «чистый старт» (`dist/migrate.js`, `dist/bootstrap.js`);
# `proxy` — Caddy со статикой кабинета (/) и поста (/gate/) и маршрутом /api → api.

ARG NODE_IMAGE=node:22.22.0-bookworm-slim
ARG CADDY_IMAGE=caddy:2.10.0-alpine

# hadolint ignore=DL3006
FROM ${NODE_IMAGE} AS build
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY . .
# Версия pnpm берётся из packageManager в package.json (corepack).
RUN pnpm install --frozen-lockfile
# Пост собирается под путь /gate/ общего домена (одна A-запись вместо двух).
RUN pnpm --filter @oxrana/api build \
 && pnpm --filter @oxrana/web build \
 && GATE_BASE=/gate/ pnpm --filter @oxrana/gate build
# Только продакшен-зависимости API; сборка (dist) копируется отдельно — pnpm deploy не берёт игнорируемые git файлы.
RUN pnpm --filter @oxrana/api --prod deploy --legacy /out/api

# hadolint ignore=DL3006
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build /out/api/node_modules ./node_modules
COPY --from=build /repo/apps/api/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/packages/db/migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]

# hadolint ignore=DL3006
FROM ${CADDY_IMAGE} AS proxy
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv/web
COPY --from=build /repo/apps/gate/dist /srv/gate
