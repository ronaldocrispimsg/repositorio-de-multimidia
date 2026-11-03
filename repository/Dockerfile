FROM node:20-alpine

WORKDIR /app/repository

COPY repository/package*.json ./
RUN npm ci --omit=dev

COPY shared /app/shared
COPY repository/ ./

RUN chown -R 1000:1000 /app

EXPOSE 8001

CMD ["node", "server.js"]
