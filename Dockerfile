FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY collab/ ./collab/

RUN mkdir -p /app/data

EXPOSE 3456

VOLUME ["/app/data"]

CMD ["node", "server.js"]
