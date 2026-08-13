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

# Compile ONLY the server and the packages it depends on (core → protocol →
# data-tools → cards → ai → sim → server). Deliberately NOT the root `build`, which
# also runs the web app's Vite build — that's hosted separately (GitHub Pages) and
# building it here would waste minutes and memory on modest NAS hardware.
RUN npm run build:server

# The host injects $PORT; the server reads it (resolvePort) and falls back to 8787.
ENV PORT=8787
EXPOSE 8787

# Run the compiled entry point. (The server tsconfig sets rootDir=src, so the build
# emits dist/main.js — NOT dist/src/main.js.)
CMD ["node", "apps/server/dist/main.js"]
