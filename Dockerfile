FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --include=optional --no-audit --no-fund
COPY . .
RUN npm run build:standalone

FROM node:24.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production WW_PROFILE=self-hosted WW_HOST=0.0.0.0 WW_PORT=3000
WORKDIR /app
# vinext is the locked production server; retain its runtime dependency tree.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/scripts/setup.mjs /app/scripts/workspace-backup.mjs /app/scripts/create-account.mjs /app/scripts/healthcheck.mjs ./scripts/
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=6s --start-period=30s CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "server/start.mjs"]
