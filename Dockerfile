# Build Stage
FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN apk add --no-cache --virtual .gyp python3 make g++ \
    && npm ci --omit=optional \
    && apk del .gyp

COPY tsconfig.json ./
COPY src ./src
COPY exampleconfig.json ./exampleconfig.json
COPY config.json ./config.json
RUN npm run build
RUN npm prune --omit=dev --omit=optional

# Runtime Stage
FROM node:24-alpine AS runtime

USER node
WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/config.json ./config.json

EXPOSE 3000
ENV PORT=3000

CMD ["node", "./dist/index.js"]
