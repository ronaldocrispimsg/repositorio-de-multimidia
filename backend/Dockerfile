FROM node:20-alpine

WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm ci --omit=dev

COPY shared /app/shared
COPY backend/ ./

RUN mkdir -p /data && chown -R 1000:1000 /data /app

EXPOSE 8000

CMD ["node", "server.js"]
