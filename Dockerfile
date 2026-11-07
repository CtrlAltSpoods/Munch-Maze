# Munch Maze: zero-dependency Node.js game server
FROM node:22-alpine

LABEL org.opencontainers.image.title="Munch Maze" \
      org.opencontainers.image.description="Self-hosted multiplayer maze-chase game for the browser" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    PUID=1000 \
    PGID=1000

WORKDIR /app
COPY package.json ./
COPY shared ./shared
COPY server ./server
COPY public ./public

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080

# The server starts as root only long enough to chown /data, then drops to PUID:PGID.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["node", "server/index.js"]
