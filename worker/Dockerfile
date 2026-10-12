# Worker de mídia — yt-dlp + ffmpeg num container Fly.io.
# Expõe: GET /health, POST /fetch (metadados), POST /audio (MP3 base64).
FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg curl ca-certificates \
  && pip install --no-cache-dir --break-system-packages yt-dlp \
  && apt-get clean && rm -rf /var/lib/apt/lists/* \
  && yt-dlp --version && ffmpeg -version | head -1

WORKDIR /app
COPY worker/package.json ./
RUN npm install --omit=dev
COPY worker/server.js ./
COPY server/media.js ./server-media.js

ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
