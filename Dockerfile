# syntax=docker/dockerfile:1.7
# web-colocation — single image serving the web app, the API and the WebSocket sync server.

FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY shared ./shared
COPY server ./server
COPY scripts ./scripts
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:26-slim AS runtime
LABEL org.opencontainers.image.title="web-colocation" \
      org.opencontainers.image.description="WebXR meeting rooms: shared objects, pens, whiteboards and voice" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    HEALTH_PORT=8081 \
    COLO_STATIC_DIR=/app/dist \
    LOG_FORMAT=json
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/scripts/hash-passcode.ts ./scripts/hash-passcode.ts
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
# The state volume must be writable by the app user (named Docker volumes copy this ownership).
RUN mkdir -p /data && chown 1000:1000 /data
# Numeric user so Kubernetes can verify runAsNonRoot.
USER 1000:1000
EXPOSE 8080 8081
VOLUME ["/data"]
CMD ["node", "server/main.ts"]
