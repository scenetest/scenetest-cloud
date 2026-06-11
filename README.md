# scenetest-cloud

The cloud service around [scenetest](https://github.com/scenetest/scenetest-js):
watches your repos' pull requests, runs scenes for each push on an ephemeral
VM, and serves live run dashboards plus a cross-project home view.

A Cloudflare Worker with D1, deployed via wrangler; runs execute on per-run
DigitalOcean droplets.

- [docs/architecture.md](docs/architecture.md) — how the pieces fit, and how
  this repo relates to the scenetest-js monorepo
- [docs/setup.md](docs/setup.md) — zero to deployed
- [docs/runner-provisioning.md](docs/runner-provisioning.md) — the ephemeral
  runner lifecycle, image contract, and secrets
