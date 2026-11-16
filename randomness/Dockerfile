FROM node:22-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node lib ./lib
COPY --chown=node:node keeper ./keeper
COPY --chown=node:node artifacts ./artifacts
COPY --chown=node:node deployments ./deployments
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "keeper/index.mjs"]
