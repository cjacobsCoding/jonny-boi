# Host the jonny-boi game server on your NAS (Synology + DuckDNS, free public wss)

Mirrors the Menu Planner `nas-deploy` runbook, adapted for this **Node WebSocket**
server. Zero recurring cost (Synology/DuckDNS DDNS + Let's Encrypt + Docker are free),
always-on, no credit card. End result: a permanent **`wss://…`** URL the deployed PWA's
"Online" button uses — no PC, no tunnel.

The only difference from Menu Planner: this is a **WebSocket** server, so the reverse
proxy needs the **Upgrade/Connection header pass-through** (Step 4b). Everything else is
the same shape you already run.

## The shape
```
NAS folder (e.g. /volume1/docker/jonny-boi)  ← this repo (clone or unzip)
  └─ docker-compose.yml  → builds apps/server/Dockerfile, runs the WS server on :8787

Container: node → apps/server/dist/src/main.js   (binds 0.0.0.0:$PORT, PORT=8787)
  Health: GET /  → 200 "jonny-boi game server: ok"   (a normal HTTP probe; WS upgrades
  on the same port go to the game)

Synology, in front (one-time):
  DDNS    mtg.<you>.duckdns.org  (or <you>.synology.me)
  Reverse Proxy  HTTPS 443 (that host) → HTTP localhost 8787   + WebSocket headers
  Let's Encrypt cert assigned to that proxy
  Router: forward TCP 443 → NAS LAN IP
```

## Step 1 — files onto the NAS
Put this repo on a share, e.g. `/volume1/docker/jonny-boi` (git clone, or File Station →
upload a zip → Extract). Nothing app-specific to copy up — the server holds no data
(game rooms are in memory; a restart just drops any in-progress room, which is fine).

## Step 2 — build & run (Container Manager, DSM 7.2+)
1. **Package Center → install "Container Manager"** (if not already, from Menu Planner).
2. **Project → Create** → set the path to the `jonny-boi` folder; it detects the root
   `docker-compose.yml`.
3. **Build.** It starts on port **8787**. (SSH alternative: `sudo docker compose up -d --build`.)

## Step 3 — LAN test
From a PC at home: open `http://<nas-ip>:8787/` → you should see
`jonny-boi game server: ok`. That confirms the container is live and healthy.

## Step 4 — expose over public HTTPS (wss)
One-time Synology config (same as Menu Planner's `synology-public-https.md`, plus 4b):

**a. DDNS** — Control Panel → External Access → DDNS. Use your existing **DuckDNS**
   (or add a free `…synology.me`). Pick a host for this app, e.g. `mtg.<you>.duckdns.org`.

**b. Reverse proxy** — Control Panel → Login Portal → Advanced → Reverse Proxy → Create:
   - **Source:** HTTPS · hostname `mtg.<you>.duckdns.org` · port **443**
   - **Destination:** HTTP · hostname `localhost` · port **8787**
   - **⚠️ REQUIRED for WebSockets** → the entry's **Custom Header** tab → **Create → WebSocket**
     (this adds the `Upgrade` + `Connection` header pass-through). Without this, `wss://`
     handshakes fail and Online won't connect. (This is the one step Menu Planner skipped
     because its API is plain JSON.)

**c. Certificate** — Control Panel → Security → Certificate → Add → Let's Encrypt for
   `mtg.<you>.duckdns.org`, then **assign it to the reverse-proxy entry** (Settings/Configure).

**d. Router** — forward **TCP 443 only** to the NAS LAN IP. Do NOT forward 8787 or DSM's
   5000/5001. (If DuckDNS/443 is already forwarded for another app on a different hostname,
   the same 443 forward serves all reverse-proxy hostnames — no new forward needed.)

**e. Verify** — from a phone on **cellular**: `https://mtg.<you>.duckdns.org/` → padlock +
   `jonny-boi game server: ok`.

## Step 5 — point the app at it
Tell me the final URL and I'll wire it: I set the repo Actions variable
`VITE_SERVER_URL = wss://mtg.<you>.duckdns.org`, the PWA auto-rebuilds, and the live site's
**Online** button connects there for everyone — no PC, no tunnel, permanent.
(Manual: `gh variable set VITE_SERVER_URL --repo cjacobsCoding/jonny-boi --body "wss://mtg.<you>.duckdns.org"` then re-run the Deploy PWA action.)

## Step 6 — updating later
After code changes: Container Manager → Project → **Build** again (or `sudo docker compose
up -d --build`). No data volume to worry about — the server is stateless.

## Hardening / note
The game server has **no login** — anyone who reaches the URL can create/join game rooms.
There's no sensitive data (just transient MTG game state), so that's generally fine for a
game, but be aware it's public. Keep DSM Auto Block + Firewall on (allow 443; DSM ports
LAN-only), as with Menu Planner.
