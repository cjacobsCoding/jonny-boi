# jonny-boi online game server.
#
# Built from the MONOREPO ROOT (the server imports sibling workspace packages), so
# run `docker build -f apps/server/Dockerfile .` with the repo root as the context.
# A WebSocket-capable host (Render/Fly/Railway) just needs to expose $PORT; the
# server binds it (see apps/server/src/config.ts → DEFAULT_PORT fallback 8787).

FROM node:20-slim

WORKDIR /app

# Install all workspace deps from the lockfile (deterministic). Copying the whole
# repo first keeps it simple and correct; the build is infrequent.
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN npm ci

# Compile the server (and the packages it depends on) to JS.
RUN npm run build

# The host injects $PORT; the server reads it (resolvePort) and falls back to 8787.
ENV PORT=8787
EXPOSE 8787

# Run the compiled entry point.
CMD ["node", "apps/server/dist/src/main.js"]
