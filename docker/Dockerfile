FROM node:22-slim AS build
WORKDIR /app
# better-sqlite3 compiles from source here; the toolchain stays out of the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
# Named volume /data inherits this ownership on first use.
RUN mkdir -p /data && chown node:node /data
EXPOSE 7777
USER node
CMD ["node", "dist/memhub.cjs", "serve"]
