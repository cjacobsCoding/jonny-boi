# Host an internet-playable jonny-boi game from THIS PC, with no cloud account.
#
# What it does (Option A — tunnel hosting):
#   1. Ensures `cloudflared` (downloads it once to scripts/.cache/, gitignored).
#   2. Starts the authoritative game server on localhost:8787 (if not already up).
#   3. Opens a public Cloudflare quick tunnel to it (anonymous, no login).
#   4. Prints the shareable PLAY LINK — open it yourself and send it to your opponent;
#      both of you load it, one Creates a room, shares the code, the other Joins.
#
# Keep this window open while you play (it hosts the game). Ctrl+C stops hosting.
# The tunnel URL is per-session: re-run this to get a fresh link.

$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot
$cache = Join-Path $PSScriptRoot '.cache'
$cf    = Join-Path $cache 'cloudflared.exe'
$appUrl = 'https://cjacobscoding.github.io/jonny-boi-app/'
$port  = 8787

New-Item -ItemType Directory -Force -Path $cache | Out-Null

if (-not (Test-Path $cf)) {
  Write-Host 'Downloading cloudflared (one-time, ~50MB)...'
  Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cf -UseBasicParsing
}

# Start the game server if nothing is listening on the port yet.
$listening = (Test-NetConnection -ComputerName localhost -Port $port -WarningAction SilentlyContinue).TcpTestSucceeded
if (-not $listening) {
  Write-Host "Starting game server on ws://localhost:$port ..."
  Start-Process -FilePath 'node' -ArgumentList '--import','tsx','apps/server/src/main.ts' `
    -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep -Seconds 5
}

# Open the public tunnel and capture its URL.
$tlog = Join-Path $cache 'tunnel.log'
if (Test-Path $tlog) { Remove-Item $tlog -Force }
Write-Host 'Opening public tunnel...'
$tunnel = Start-Process -FilePath $cf -ArgumentList 'tunnel','--no-autoupdate','--url',"http://localhost:$port" `
  -RedirectStandardOutput $tlog -RedirectStandardError (Join-Path $cache 'tunnel.err') -WindowStyle Hidden -PassThru

$wss = $null
for ($i = 0; $i -lt 30 -and -not $wss; $i++) {
  Start-Sleep -Seconds 1
  $txt = (Get-Content $tlog, (Join-Path $cache 'tunnel.err') -ErrorAction SilentlyContinue) -join "`n"
  $m = [regex]::Match($txt, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($m.Success) { $wss = 'wss://' + $m.Value.Substring('https://'.Length) }
}

if (-not $wss) { Write-Host 'Could not get a tunnel URL — check your connection and re-run.'; exit 1 }

$link = $appUrl + '?server=' + [uri]::EscapeDataString($wss)
Write-Host ''
Write-Host '================  jonny-boi is hosted!  ================' -ForegroundColor Green
Write-Host 'Share this PLAY LINK with your opponent (and open it yourself):'
Write-Host ''
Write-Host "  $link"
Write-Host ''
Write-Host 'One of you clicks Create room; share the room code; the other Joins.'
Write-Host 'Keep this window open while playing. Press Ctrl+C to stop hosting.'
Write-Host '======================================================='

# Stay alive so the tunnel keeps running until the user stops it.
Wait-Process -Id $tunnel.Id
