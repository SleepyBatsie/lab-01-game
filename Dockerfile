# Stage 1: Build client bundle
FROM node:22-alpine AS builder
WORKDIR /app

ENV NODE_ENV=development

COPY package.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN npm install --no-audit --no-fund

COPY shared ./shared
COPY client ./client

RUN npm run build:client

# Stage 2: Minimal production runtime (< 200 MB, non-root)
FROM node:22-alpine AS runner
WORKDIR /app

ARG BUILD_SHA=unknown
ENV NODE_ENV=production
ENV PORT=3000
ENV BUILD_SHA=${BUILD_SHA}

COPY package.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/

RUN npm install --omit=dev --no-audit --no-fund --workspace=shared --workspace=server && npm cache clean --force

COPY shared/src ./shared/src
COPY shared/tsconfig.json ./shared/tsconfig.json
COPY server/src ./server/src
COPY server/tsconfig.json ./server/tsconfig.json
COPY --from=builder /app/client/dist ./client/dist

RUN chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "--experimental-strip-types", "server/src/index.ts"]