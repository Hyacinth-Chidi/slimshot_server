# syntax=docker/dockerfile:1

# SlimShot API image. Built by docker-compose.yml; see docs/deploy/vps-setup.md.
#
#   build   — every dependency, the compiled app, and the Prisma CLI. The one-off
#             `migrate` service runs from this stage (migrations + seed).
#   runtime — production dependencies and dist/ only, run as the unprivileged `node` user.

FROM node:24-bookworm-slim AS build
WORKDIR /app
# openssl: the Prisma CLI's schema engine; python3/make/g++: argon2's native build
# if no prebuilt binary matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM build AS prune
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# tini forwards SIGTERM so Nest's shutdown hooks close the queue and database cleanly.
# postgresql-client-17 is pg_dump for database backups. pg_dump refuses a server newer
# than itself, so it must match postgres:17 in docker-compose.yml (a test keeps the two
# in step), and Debian's own client is older: it comes from the PostgreSQL repository.
# curl only fetches the repository's key, and goes again.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini curl \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && . /etc/os-release \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && apt-get purge -y --auto-remove curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=prune --chown=node:node /app/package.json ./package.json
COPY --from=prune --chown=node:node /app/node_modules ./node_modules
COPY --from=prune --chown=node:node /app/dist ./dist
USER node
EXPOSE 2700
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 2700) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
