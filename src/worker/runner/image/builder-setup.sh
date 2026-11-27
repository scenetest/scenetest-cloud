#!/bin/bash
# Cloud-init for an image-builder droplet. The worker's image stage
# (src/worker/runner/image.ts) substitutes __AGENT_B64__, __NODE_MAJOR__,
# and __SUPABASE_CLI_VERSION__, boots a stock Ubuntu droplet with this as
# user_data, and treats poweroff as the "ready to snapshot" signal. This
# file's content is part of the image stage's input hash — editing it
# builds a new image.
#
# Installs the runner toolchain, bakes in the box agent + its systemd unit
# (installed but DISABLED — provision-time user_data written by
# src/worker/runner/digitalocean.ts creates /etc/scenetest/run.env and
# starts the unit), cleans up, and powers off.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# --- base toolchain ----------------------------------------------------------
apt-get update
apt-get install -y git curl ca-certificates iproute2

# Docker from Docker's apt repo, not Ubuntu's docker.io: only Docker's
# packages ship dockerd-rootless.sh, which the run user's daemon needs.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin \
  docker-ce-rootless-extras uidmap slirp4netns
# The rootful daemon's socket is root's alone; nothing on the box uses it.
systemctl disable --now docker.service docker.socket
rm -f /var/run/docker.sock

# node + pnpm via corepack
curl -fsSL https://deb.nodesource.com/setup___NODE_MAJOR__.x | bash -
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

# --- the run user and its rootless Docker -------------------------------------
# Repo commands run as this user; the agent itself stays root
# (docs/threat-model.md). Not in the docker group: membership would be root
# in all but name, and the agent drops supplementary groups anyway. Docker
# reaches repo commands as this user's own rootless daemon instead.
useradd --system --create-home --home-dir /home/scenetest-run --shell /bin/bash scenetest-run
# --system allocates no subordinate ids, and rootless Docker maps container
# uids into them.
usermod --add-subuids 100000-165535 --add-subgids 100000-165535 scenetest-run

# A system unit rather than the per-user unit dockerd-rootless-setuptool.sh
# writes, so scenetest-runner can order itself after it. The [Service]
# settings follow the setuptool's unit, except TimeoutStartSec: its
# TimeoutSec=0 would let a daemon that never reports ready hold the runner
# back forever. Started by scenetest-runner's Wants=.
cat > /etc/systemd/system/scenetest-docker.service <<'UNIT'
[Unit]
Description=rootless Docker for scenetest-run
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
User=scenetest-run
RuntimeDirectory=scenetest-docker
RuntimeDirectoryMode=0700
Environment=XDG_RUNTIME_DIR=/run/scenetest-docker
Environment=PATH=/usr/bin:/sbin:/usr/sbin:/bin
ExecStart=/usr/bin/dockerd-rootless.sh
ExecReload=/bin/kill -s HUP $MAINPID
TimeoutStartSec=180
Restart=always
RestartSec=2
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
TasksMax=infinity
Delegate=yes
KillMode=mixed
UNIT

# --- the box agent -----------------------------------------------------------

mkdir -p /opt/scenetest
echo '__AGENT_B64__' | base64 -d > /opt/scenetest/agent.mjs
chmod 755 /opt/scenetest/agent.mjs

cat > /etc/systemd/system/scenetest-runner.service <<'UNIT'
[Unit]
Description=scenetest box agent
After=network-online.target scenetest-docker.service
Wants=network-online.target scenetest-docker.service

[Service]
Type=simple
EnvironmentFile=/etc/scenetest/run.env
Environment=SCENETEST_RUN_AS=scenetest-run
Environment=SCENETEST_BLOCK_METADATA=1
Environment=DOCKER_HOST=unix:///run/scenetest-docker/docker.sock
ExecStart=/usr/bin/node /opt/scenetest/agent.mjs
Restart=on-failure
RestartSec=5
WorkingDirectory=/opt/scenetest

[Install]
WantedBy=multi-user.target
UNIT
# Deliberately not enabled: run.env doesn't exist in the image, so an
# enabled unit would crash-loop at first boot before user_data runs.
# scenetest-docker isn't enabled either; starting the runner pulls it in.
systemctl daemon-reload

# --- shrink + neutralize the snapshot -----------------------------------------
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*
# Each droplet from this snapshot must regenerate its own host keys/ids.
rm -f /etc/ssh/ssh_host_*
truncate -s 0 /etc/machine-id
cloud-init clean --logs || true

poweroff
