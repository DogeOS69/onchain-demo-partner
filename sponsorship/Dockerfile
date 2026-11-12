FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node scripts/patch-alto.mjs ./scripts/patch-alto.mjs
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node lib ./lib
COPY --chown=node:node artifacts ./artifacts
COPY --chown=node:node config ./config
COPY --chown=node:node server.mjs ./server.mjs
ENV NODE_ENV=production PORT=4341 SPONSOR_STATE_DIR=/data
RUN mkdir -p /data && chown node:node /data
EXPOSE 4341
CMD ["sh", "-c", "chown -R node:node /data && exec su -s /bin/sh node -c 'exec node server.mjs'"]
