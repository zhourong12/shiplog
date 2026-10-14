# syntax=docker/dockerfile:1

# ---- build: compile the client and server ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: production dependencies and the build output only ----
FROM node:22-bookworm-slim AS runtime
# git reads repositories mounted for self-hosted (local) mode. Mounted repositories belong to
# another uid, so mark them safe; SHIPLOG_LOCAL_ROOTS still limits what is read.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8792 \
    SHIPLOG_DB_PATH=/data/shiplog.db
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8792
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# The server handles SIGTERM itself (finishes requests, closes the database), so node can be PID 1.
CMD ["node", "--disable-warning=ExperimentalWarning", "dist-server/index.js"]
