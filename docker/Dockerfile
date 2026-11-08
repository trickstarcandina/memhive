FROM node:26-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS build
WORKDIR /app
# No compiler toolchain: better-sqlite3 and sqlite-vec load prebuilt binaries shipped in their
# packages. --ignore-scripts stops npm from running node-gyp anyway because binding.gyp exists.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:26-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072
WORKDIR /app
ENV NODE_ENV=production
# Inside the container the hub must listen on all interfaces; compose publishes it on loopback only.
ENV HOST=0.0.0.0
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
# Named volume /data inherits this ownership on first use.
RUN mkdir -p /data && chown node:node /data
EXPOSE 7777
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7777)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
USER node
CMD ["node", "dist/memhive.cjs", "serve"]
