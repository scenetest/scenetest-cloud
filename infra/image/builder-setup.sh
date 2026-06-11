#!/bin/bash
# Cloud-init for the image builder droplet. Installs the runner toolchain,
# bakes in the box agent + its systemd unit (installed but DISABLED — the
# provision-time user_data written by src/worker/runner/digitalocean.ts
# creates /etc/scenetest/run.env and starts the unit), cleans up, and powers
# off — which build-image.sh treats as the "ready to snapshot" signal.
#
# __AGENT_B64__ and __SUPABASE_CLI_VERSION__ are substituted by
# build-image.sh; do not run this file directly.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# --- base toolchain ----------------------------------------------------------
apt-get update
apt-get install -y git curl ca-certificates docker.io docker-compose-v2

# node 22 + pnpm via corepack
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
corepack enable

# supabase CLI (drives the local stack via docker)
curl -fsSL -o /tmp/supabase.deb \
  "https://github.com/supabase/cli/releases/download/v__SUPABASE_CLI_VERSION__/supabase___SUPABASE_CLI_VERSION___linux_amd64.deb"
apt-get install -y /tmp/supabase.deb && rm /tmp/supabase.deb

# Playwright SYSTEM deps only (libs are version-stable; the browsers
# themselves are version-coupled to the project's playwright, so the
# project's own install fetches them at box-setup time).
npx -y playwright@latest install-deps chromium

# --- the box agent -----------------------------------------------------------
mkdir -p /opt/scenetest
echo '__AGENT_B64__' | base64 -d > /opt/scenetest/agent.mjs
chmod 755 /opt/scenetest/agent.mjs

cat > /etc/systemd/system/scenetest-runner.service <<'UNIT'
[Unit]
Description=scenetest box agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/scenetest/run.env
ExecStart=/usr/bin/node /opt/scenetest/agent.mjs
Restart=on-failure
RestartSec=5
WorkingDirectory=/opt/scenetest

[Install]
WantedBy=multi-user.target
UNIT
# Deliberately not enabled: run.env doesn't exist in the image, so an
# enabled unit would crash-loop at first boot before user_data runs.
systemctl daemon-reload

# --- shrink + neutralize the snapshot -----------------------------------------
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*
# Each droplet from this snapshot must regenerate its own host keys/ids.
rm -f /etc/ssh/ssh_host_*
truncate -s 0 /etc/machine-id
cloud-init clean --logs || true

poweroff
