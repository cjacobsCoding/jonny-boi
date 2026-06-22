# Deploying the jonny-boi online game server

The server is a Node WebSocket server (`ws`) — the authoritative referee for online
MTG games. It needs a host that supports **long-lived WebSocket connections** (not a
plain serverless function). It binds `process.env.PORT` (falling back to `8787`
locally) and serves WebSocket connections at the root path.

> The deploy itself is account-gated — **you** run it. This doc gives concrete steps;
> nothing here requires a secret to be committed.

## Local dev

```sh
npm install          # once, at the repo root
npm run server       # starts the server (from the repo root)
# → [server] jonny-boi game server listening on ws://localhost:8787
```

The web client should connect to **`ws://localhost:8787`** in local dev (override the
port with `PORT=<n> npm run server` if 8787 is taken).

## Build the production bundle

```sh
npm run build        # compiles every package + the server to dist/
node apps/server/dist/index.js   # runs the compiled server
```

## Deploy to Render (recommended — first-class WebSocket support)

A `render.yaml` Blueprint is included. The Docker build uses the **repo root** as its
context because the server imports sibling workspace packages.

1. Push this repo to GitHub/GitLab.
2. In the Render dashboard: **New + → Blueprint**, and select the repo. Render reads
   `apps/server/render.yaml`, which defines a Docker web service.
3. Render injects `PORT`; the server binds it automatically. No secrets needed.
4. After the first deploy, your WebSocket URL is `wss://<service-name>.onrender.com`
   (Render terminates TLS, so clients use `wss://`).

Alternatively, configure it by hand instead of the Blueprint:
- Environment: **Docker**, Dockerfile path `apps/server/Dockerfile`, context `.`.
- Health check path: `/`.

## Alternatives

- **Fly.io** — `fly launch` from the repo root, point it at `apps/server/Dockerfile`
  with the repo root as the build context, and set the internal port to `8787` (or
  whatever you set `PORT` to). Fly proxies WebSockets transparently.
- **Railway** — create a service from the repo, set the Dockerfile to
  `apps/server/Dockerfile`. Railway injects `PORT`; the server honors it. WebSockets
  work out of the box on Railway's HTTP edge.

In every case the build is the same Docker image; only the platform glue differs.

## Notes

- **TLS:** locally the client uses `ws://`. Once deployed behind a host that
  terminates TLS (Render/Fly/Railway all do), the client must use `wss://`.
- **CORS/origin:** raw WebSocket connections aren't subject to CORS preflight; the
  server accepts connections from the dev origin without extra config.
- **Heartbeat:** the server pings idle sockets every 30s and drops half-open ones,
  so a dropped client is detected and its seat freed for reconnection.
