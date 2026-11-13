FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG NEXT_PUBLIC_DOGEOS_CLIENT_ID
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
ARG NEXT_PUBLIC_SOCIAL_LOGIN_ENABLED=false
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
