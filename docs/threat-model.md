# Threat model: repo code on boxes

A box runs code from the PR's head commit: the pipeline file, every stage's
`run` line, the `scenes` command, the legacy hooks, and the app and tests
they start. This page states what the author of that commit can and cannot
do. It covers the box and the box-facing worker routes. Dashboard sign-in is
covered in [architecture.md](./architecture.md) ("Auth").

## Who gets a box

A watched repo's `pull_request` webhook creates a run for `opened`,
`synchronize` and `reopened`. The worker ignores these events when the PR's
head commit lives in a different repo than its base (a fork PR). The
delivery is recorded as `ignored:fork-pr` in `webhook_deliveries`, and the
worker logs the head repo. If the head repo is missing from the payload, for
example because the fork was deleted, the PR counts as a fork.

The guard matters because GitHub sends fork PR events to the base repo's
webhook, and the base repo serves the fork's head commit under
`refs/pull/<n>/head`. Before the guard, the agent's fetch by sha from the
base repo URL succeeded for fork PRs, so anyone could run code on a box by
opening a PR.

So the people who can run code on a box are the people who can push a
branch to a watched repo.

## How the box is split

The `scenetest-runner` unit runs the agent as root. The agent holds the
box's bearer token, which comes from `/etc/scenetest/run.env` (mode 0600).
Every command that comes from the repo runs as the `scenetest-run` user:

- git operations on the checkout
- pipeline stages
- the `scenes` command

These commands get a fixed environment:

- `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TZ`, `TERM` and
  `DOCKER_HOST`
- `SCENETEST_BOX_ID`, `SCENETEST_REPO`, `SCENETEST_HEAD_SHA` (the sha the
  checkout is at), `SCENETEST_BASE_SHA` and `SCENETEST_BASE_REF`
- for a scene batch, `SCENETEST_RUN_ID`, `SCENETEST_SUBSET`,
  `SCENETEST_LOCAL_INGEST` and `SCENETEST_REPORT_URL`

The bearer token and the ingest URL are not among them.

Docker for repo commands is `scenetest-run`'s own rootless daemon (the
`scenetest-docker` unit). Root inside a container maps to `scenetest-run`
on the host, and other container uids map to its subordinate range
(100000–165535). A container started with `--privileged` and the host's `/`
mounted still reads host files with `scenetest-run`'s permissions, so
`run.env` stays unreadable. The rootful daemon is disabled.

The agent installs an iptables rule that rejects `scenetest-run`'s traffic
to `169.254.0.0/16`. Container traffic counts as `scenetest-run`'s, because
the rootless network driver (slirp4netns) opens host connections as that
user. That range holds the DigitalOcean metadata endpoint,
which serves the droplet's `user_data`, and `user_data` contains the bearer
token in plaintext. If the rule can't be installed, the agent exits without
running anything.

The box accepts no inbound connections. The image has no sshd, and ufw
drops every unsolicited inbound packet, including ping. A port that a stage
or container publishes is reachable from the box itself and from nowhere
else. Everything the box does starts from the box: the channel to the PR
coordinator, git fetches, package and image downloads.

## What a PR author can do

- Run any code as `scenetest-run` on their own PR's box, for up to the box's
  age cap (`RUNNER_MAX_AGE_MINUTES`, default 30).
- Reach any host on the internet from the box, from the host or from a
  container. Outbound traffic is not filtered beyond link-local.
- Run containers with the run user's rootless Docker, including
  `--privileged` ones, which are privileged only inside the run user's
  namespace.
- Decide their own runs' verdicts. The scenes command reports events to the
  agent's local ingest on `127.0.0.1:4999`, and a `run:end` event settles the
  run. This is inherent: the author writes the tests. The `scenetest` commit
  status on their head commit shows whatever their code reports.
- Write any events into their own runs' logs, and so into the dashboard for
  their PR.
- Read what the agent writes to its work directory: run logs and the
  commands that signed-in users send to the box.
- Leave background processes running until the box is retired.

## What a PR author cannot do

- Read the bearer token. `run.env` is root-only, the agent's environment is
  not passed down, another user can't read `/proc/<agent>/environ`, and the
  metadata endpoint is blocked.
- Without the token, a PR author can't:
  - connect the box channel
  - call `/api/boxes/:id/ready`, `/api/events/:runId` or `/api/runs/:runId/complete`
- Settle or write events into another box's runs. The PR coordinator accepts
  events only from the box socket, and only for runs that were dispatched to
  that box.
- Accept connections from the internet. Published ports and listening
  services are dropped at the box's firewall, which only root can change.
- Write files outside the work directory through the agent. Run ids are
  validated before they name a file.
- Reach the operator's credentials. `GITHUB_API_TOKEN`,
  `GITHUB_WEBHOOK_SECRET`, `DO_API_TOKEN` and `SESSION_SECRET` exist only in
  the worker. A box receives the following, and none of it carries a
  credential beyond its own bearer token:
  - its `user_data`: box id, repo, shas, base ref, ingest URL and bearer token
  - pipeline updates: sha, stage vector, stage commands and the scenes command
  - run dispatches
  - dashboard commands
- Become root through the agent or through Docker. The agent never runs
  repo-supplied input as root. Repo commands get no supplementary groups,
  so the rootful docker socket and sudo are out of reach, and the rootless
  daemon has no more rights than `scenetest-run`.
- Reach the agent's local ingest from inside a container. Rootless Docker
  blocks the host's loopback for containers. Repo commands on the host can
  reach it, as they must.

## What the bearer token is worth

If the token leaks (a root compromise of the box), its holder can act as
that one box until it is retired:

- report a stage vector through `/ready`, so later pushes to the PR skip
  stages that should have re-run
- settle the box's runs, which also sets the PR's commit status
- receive the box's dispatches and commands

The token is scoped to one box of one PR. Other PRs and the worker's secrets
stay out of reach.

## What this does not defend against

- **Local privilege escalation.** A kernel bug or a setuid binary on the box
  turns `scenetest-run` into root. With root, the token is readable. A
  separate user is not a sandbox. Rootless Docker widens the kernel surface
  the run user can touch: Ubuntu restricts unprivileged user namespaces,
  but its AppArmor profile for `rootlesskit` lifts that restriction, and
  any repo command can run `rootlesskit`.
- **Abuse of the droplet's network.** Mining, scanning and spam all run from
  the deployment's DigitalOcean account until the age cap. An outbound tunnel
  (ngrok and the like) can also carry traffic back in, since outbound
  traffic is not filtered.
- **The shared webhook secret.** Every watched repo's webhook uses
  `GITHUB_WEBHOOK_SECRET`, so each repo admin who configured one holds it. A
  holder can forge a signed delivery for any watched repo, including a
  `head.repo` that passes the fork guard, and with a head sha of their
  choosing. That starts a box for the other repo's PR number, and the worker
  posts commit statuses to that repo with the operator's token. Whether
  GitHub serves an arbitrary fork-network sha through the other repo's URL
  without an open PR is not verified.
- **Signed-in dashboard users.** They are trusted operators. Commands they
  send reach the box unchanged.

## Known gaps

- Repo commands can't install system packages. There is no `sudo`, so
  `apt-get install` in a `run` line and `playwright install --with-deps`
  fail. The image preinstalls Playwright's system libraries.
- Container resource limits (`--memory`, `--cpus`) are untested on boxes.
  Docker supports them in rootless mode only with cgroup v2 and a systemd
  user session, and the box's daemon runs from a system unit instead.
