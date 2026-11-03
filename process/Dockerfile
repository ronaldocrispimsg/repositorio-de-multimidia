FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app/process

COPY process/package*.json ./
RUN npm ci --omit=dev

COPY shared /app/shared
COPY process/ ./

RUN chown -R 1000:1000 /app

CMD ["node", "worker.js"]
