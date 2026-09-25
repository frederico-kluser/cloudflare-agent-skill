#!/usr/bin/env bash
# Expose a local server on the internet via a Cloudflare quick tunnel,
# protected by a one-time password shown as a QR code in the terminal.
#
# Usage: ./expose-port.sh <target>
#   <target>  the local server, in any of these forms:
#     8080
#     localhost:8080
#     127.0.0.1:8080
#     http://localhost:8080
#     https://127.0.0.1:9443/path   (https upstream = dev/self-signed certs)
#
# Prints the public URL + QR. The password lives in the URL (?key=...),
# is consumed on first access, and the URL is cleaned right after.
# Stop with ./stop.sh; mint another password with ./new-link.sh.
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "usage: $0 <http://host:port | host:port | port>" >&2
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/." && pwd)"
cd "$DIR"
# shellcheck source=lib.sh
source "$DIR/lib.sh"

# --- prerequisites -----------------------------------------------------------
command -v cloudflared >/dev/null 2>&1 || {
  echo "ERROR: cloudflared not found. Install it:" >&2
  echo "  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared && chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/" >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "ERROR: node not found. The gate proxy needs Node.js (node:http only, zero deps)." >&2
  exit 1
}

# --- parse the target ---------------------------------------------------------
parse_target "$TARGET"
echo "target: ${PROTO}://${HOST}:${PORT}"

# --- preflight: is anything listening? -----------------------------------------
# Warn only on a real connection failure (000) — HTTP error codes (404/500) mean
# the server IS up, so -f would only produce a false warning here.
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://${HOST}:${PORT}/" 2>/dev/null || true)"
if [ "$code" = "000" ] || [ -z "$code" ]; then
  echo "WARNING: nothing answered on http://${HOST}:${PORT}/ — starting anyway; validate once it is up." >&2
fi

# --- 1. gate proxy with a fresh one-time password ------------------------------
if [ -f proxy.pid ] && kill -0 "$(cat proxy.pid)" 2>/dev/null; then
  echo "proxy already running — run scripts/expose-port/stop.sh first (or scripts/expose-port/new-link.sh to rotate the password)." >&2
  exit 1
fi
TOKEN="$(gen_token)"
UPSTREAM_HOST="$HOST" UPSTREAM_PORT="$PORT" UPSTREAM_PROTO="$PROTO" \
TOKEN_REUSE="${TOKEN_REUSE:-1}" TOKEN_TTL_MS="${TOKEN_TTL_MS:-0}" \
TOKEN="$TOKEN" nohup node "$DIR/proxy.mjs" > proxy.log 2>&1 &
echo $! > proxy.pid
echo "gate proxy started (pid $(cat proxy.pid)) on 127.0.0.1:3100 -> ${PROTO}://${HOST}:${PORT}"

HEALTHY=0
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:3100/__expose-port-health" 2>/dev/null; then
    echo "proxy health: ok"
    HEALTHY=1
    break
  fi
  sleep 0.5
done
if [ "$HEALTHY" != 1 ]; then
  echo "ERROR: gate proxy did not become healthy on 127.0.0.1:3100" >&2
  echo "       (port already in use, or the proxy crashed on start)." >&2
  echo "--- proxy.log (tail) ---" >&2
  tail -5 proxy.log 2>/dev/null | sed 's/^/  /' >&2 || true
  exit 1
fi

# --- 2. cloudflared quick tunnel ------------------------------------------------
if [ -f cloudflared.pid ] && kill -0 "$(cat cloudflared.pid)" 2>/dev/null; then
  echo "cloudflared already running — run scripts/expose-port/stop.sh first." >&2
  exit 1
fi
nohup cloudflared tunnel --url "http://127.0.0.1:3100" --no-autoupdate --loglevel info > tunnel.log 2>&1 &
echo $! > cloudflared.pid
echo "cloudflared started (pid $(cat cloudflared.pid))"

for _ in $(seq 1 60); do
  PUBLIC_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' tunnel.log | tail -1 || true)"
  if [ -n "$PUBLIC_URL" ]; then
    save_current_link
    print_access_link "${PUBLIC_URL}/?key=${TOKEN}"
    echo "TUNNEL READY: $PUBLIC_URL"
    echo "Validate now: scripts/expose-port/status.sh"
    exit 0
  fi
  sleep 1
done

echo "tunnel did not become ready within 60s — check $DIR/tunnel.log" >&2
exit 1
