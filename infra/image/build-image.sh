#!/usr/bin/env bash
# Build the scenetest runner image: boot a builder droplet whose cloud-init
# installs everything (node, pnpm, git, docker, supabase CLI, Playwright
# system deps) plus the box agent and its systemd unit, then powers off.
# Power-off is the "done" signal — we never SSH in. Then snapshot, destroy
# the builder, and print the snapshot id to put in wrangler.toml as
# RUNNER_IMAGE.
#
# Usage:
#   DO_API_TOKEN=... ./infra/image/build-image.sh
# Optional env: BUILD_REGION (default nyc3), BUILD_SIZE (s-2vcpu-4gb),
#   BASE_IMAGE (ubuntu-24-04-x64), SUPABASE_CLI_VERSION (2.30.4)
#
# Takes ~10-15 minutes. Cost: a few cents of droplet time + snapshot storage
# (~$0.06/GB/month).
set -euo pipefail

: "${DO_API_TOKEN:?set DO_API_TOKEN (never commit it)}"
BUILD_REGION="${BUILD_REGION:-nyc3}"
BUILD_SIZE="${BUILD_SIZE:-s-2vcpu-4gb}"
BASE_IMAGE="${BASE_IMAGE:-ubuntu-24-04-x64}"
SUPABASE_CLI_VERSION="${SUPABASE_CLI_VERSION:-2.30.4}"
SNAPSHOT_NAME="scenetest-runner-$(date +%Y%m%d-%H%M)"

API='https://api.digitalocean.com/v2'
HERE="$(cd "$(dirname "$0")" && pwd)"

req() { # method path [json-body]
  local method="$1" path="$2" body="${3:-}"
  curl -fsS -X "$method" "$API$path" \
    -H "Authorization: Bearer $DO_API_TOKEN" \
    -H 'Content-Type: application/json' \
    ${body:+-d "$body"}
}

# The agent rides into the image inside the cloud-init script, base64-encoded
# so quoting can't bite us.
AGENT_B64=$(base64 -w0 "$HERE/../box/agent.mjs")
USER_DATA=$(sed -e "s|__AGENT_B64__|$AGENT_B64|" \
                -e "s|__SUPABASE_CLI_VERSION__|$SUPABASE_CLI_VERSION|" \
                "$HERE/builder-setup.sh")

echo "· creating builder droplet ($BUILD_SIZE in $BUILD_REGION)"
BODY=$(USER_DATA="$USER_DATA" python3 -c "
import json, os, sys
print(json.dumps({
  'name': 'scenetest-image-builder',
  'region': sys.argv[1], 'size': sys.argv[2], 'image': sys.argv[3],
  'user_data': os.environ['USER_DATA'],
  'tags': ['scenetest-image-builder'],
}))" "$BUILD_REGION" "$BUILD_SIZE" "$BASE_IMAGE")
DROPLET=$(req POST /droplets "$BODY")
ID=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['droplet']['id'])" "$DROPLET")
echo "  builder droplet: $ID"

cleanup() {
  echo "· destroying builder droplet $ID"
  req DELETE "/droplets/$ID" >/dev/null || echo "  (destroy failed — remove it in the DO console)"
}
trap cleanup EXIT

echo "· waiting for cloud-init to finish (poweroff is the done signal)"
for i in $(seq 1 120); do
  sleep 15
  STATUS=$(req GET "/droplets/$ID" | python3 -c "import json,sys;print(json.load(sys.stdin)['droplet']['status'])")
  echo "  [$((i*15))s] $STATUS"
  [ "$STATUS" = "off" ] && break
  [ "$i" = "120" ] && { echo "builder never powered off — check its console"; exit 1; }
done

echo "· snapshotting as $SNAPSHOT_NAME"
ACTION=$(req POST "/droplets/$ID/actions" "{\"type\":\"snapshot\",\"name\":\"$SNAPSHOT_NAME\"}")
ACTION_ID=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['action']['id'])" "$ACTION")
for i in $(seq 1 120); do
  sleep 15
  ASTAT=$(req GET "/actions/$ACTION_ID" | python3 -c "import json,sys;print(json.load(sys.stdin)['action']['status'])")
  echo "  [$((i*15))s] snapshot: $ASTAT"
  [ "$ASTAT" = "completed" ] && break
  [ "$ASTAT" = "errored" ] && { echo "snapshot failed"; exit 1; }
done

SNAPSHOT_ID=$(req GET "/droplets/$ID/snapshots" | python3 -c "
import json,sys
snaps = json.load(sys.stdin)['snapshots']
print(sorted(snaps, key=lambda s: s['created_at'])[-1]['id'])")

echo
echo "Done. Set in wrangler.toml [vars]:"
echo "  RUNNER_PROVIDER = \"digitalocean\""
echo "  RUNNER_REGION   = \"$BUILD_REGION\""
echo "  RUNNER_SIZE     = \"$BUILD_SIZE\""
echo "  RUNNER_IMAGE    = \"$SNAPSHOT_ID\""
echo "  PUBLIC_BASE_URL = \"https://<your-deployment>\""
echo "and: wrangler secret put DO_API_TOKEN"
