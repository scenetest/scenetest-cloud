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

These commands get a fixed environment: `PATH`, `HOME`, `USER`, `LOGNAME`,
`LANG`, `LC_ALL`, `TZ`, `TERM`, plus the `SCENETEST_RUN_ID`,
`SCENETEST_SUBSET`, `SCENETEST_LOCAL_INGEST` and `SCENETEST_REPORT_URL`
variables for a scene batch. Nothing from `run.env` reaches them.

The agent installs an iptables rule that rejects `scenetest-run`'s traffic
to `169.254.0.0/16`. That range holds the DigitalOcean metadata endpoint,
which serves the droplet's `user_data`, and `user_data` contains the bearer
token in plaintext. If the rule can't be installed, the agent exits without
running anything.

## What a PR author can do

- Run any code as `scenetest-run` on their own PR's box, for up to the box's
  age cap (`RUNNER_MAX_AGE_MINUTES`, default 30).
- Reach any host on the internet from the box. Outbound traffic is not
  filtered beyond link-local.
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
  events only from the box socket, and only for runs on that box.
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
- Become root through the agent. The agent never runs repo-supplied input as
  root. Repo commands get no supplementary groups, so docker and sudo are
  out of reach.

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
  separate user is not a sandbox.
- **Abuse of the droplet's network.** Mining, scanning and spam all run from
  the deployment's DigitalOcean account until the age cap.
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

- Repo commands can't use Docker. The docker socket is root-only, so a stage
  that runs `supabase start` or `docker compose` fails. Rootless Docker for
  `scenetest-run` is the planned fix.
- Repo commands can't install system packages. There is no `sudo`, so
  `apt-get install` in a `run` line and `playwright install --with-deps`
  fail. The image preinstalls Playwright's system libraries.
