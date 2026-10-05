# syntax=docker/dockerfile:1

# SlimShot API image. Built by docker-compose.prod.yml; see docs/deploy/vps-setup.md.
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
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini \
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
