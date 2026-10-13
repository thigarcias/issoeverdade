# Worker de mídia — yt-dlp + ffmpeg num container Fly.io.
# Expõe: GET /health, POST /fetch, POST /audio, POST /frames, POST /upload.
# Copia server/net.js e server/proc.js para manter a mesma árvore relativa do
# repositório (imports ../server/*.js), evitando duas cópias da fronteira de rede.
FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg curl ca-certificates \
  && pip install --no-cache-dir --break-system-packages yt-dlp \
  && apt-get clean && rm -rf /var/lib/apt/lists/* \
  && yt-dlp --version && ffmpeg -version | head -1

WORKDIR /app
COPY server ./server
COPY worker/package.json ./worker/package.json
COPY worker/server.js ./worker/server.js
RUN cd worker && npm install --omit=dev

ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["node", "worker/server.js"]
