#!/usr/bin/env bash
# Expose the local dev server so Twilio can reach the webhooks.
# Cloudflare quick tunnels need no account and no signup.
set -euo pipefail

PORT="${1:-3100}"
LOG="/tmp/leadgen-tunnel.log"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not installed. Run: brew install cloudflared"
  exit 1
fi

echo "Starting tunnel to localhost:$PORT …"
cloudflared tunnel --url "http://localhost:$PORT" > "$LOG" 2>&1 &
TUNNEL_PID=$!

URL=""
for _ in $(seq 1 40); do
  sleep 1
  URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  [ -n "$URL" ] && break
done

if [ -z "$URL" ]; then
  echo "Tunnel failed to start. Log:"; tail -20 "$LOG"; kill $TUNNEL_PID 2>/dev/null || true; exit 1
fi

cat <<EOF

  Tunnel live:  $URL
  (pid $TUNNEL_PID — kill it with: kill $TUNNEL_PID)

  Paste these into Twilio Console → Phone Numbers → your number:

    A CALL COMES IN   (Webhook, HTTP POST)
      $URL/api/webhooks/twilio/voice

    CALL STATUS CHANGES   (HTTP POST)
      $URL/api/webhooks/twilio/status

    A MESSAGE COMES IN   (Webhook, HTTP POST)
      $URL/api/webhooks/twilio/sms

  Then call your Twilio number and talk to it.

EOF

wait $TUNNEL_PID
