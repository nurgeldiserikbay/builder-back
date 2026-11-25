# BuildPath agent for a closed network

«Агент в вашей сети» ([PRODUCT_LIFECYCLE §7](https://github.com/nurgeldiserikbay/builder-docs)) — one file, `buildpath-agent.mjs`,
that the owner of a web application runs inside their own network when the repository or the servers are not reachable
from the internet (corporate GitLab, a server behind VPN).

- **Outbound only.** The agent calls BuildPath over HTTPS (`POST /network-agent/hello`, then `POST /network-agent/jobs/next`,
  which waits up to 25 s). No inbound port, no VPN for BuildPath.
- **Three jobs, targets on the owner's side.** `check` asks `APP_URL/api/health`; `push` sends the code of an AI-agent task
  to `GIT_REMOTE` on branch `buildpath/agent-…`; `deploy` runs `DEPLOY_COMMAND`. BuildPath never sends a command, an address
  or a remote. A job the agent was not set up for is refused on the platform.
- **Credentials stay here.** Git credentials (an SSH key or a token in `GIT_REMOTE`) and whatever the deploy command uses
  never leave the machine. The deploy output is sent only with `SHARE_DEPLOY_OUTPUT=1`, with the key and the remote masked;
  git's own output is never sent.
- **One key per project.** Shown once on the project page, stored by BuildPath as a SHA-256 hash, 180 days, revocable.
  A revoked or expired key stops the agent.

## Run

With Node.js 22 and git:

```sh
export BUILDPATH_URL=https://api.example.com/api/v1
export BUILDPATH_AGENT_TOKEN=bpa_...
export APP_URL=http://app.corp.local:8080           # optional: enables check
export GIT_REMOTE=git@gitlab.corp.local:team/app.git  # optional: enables push
export DEPLOY_COMMAND='ssh deploy@app.corp.local ./deploy.sh "$BUILDPATH_BRANCH"'  # optional: enables deploy
node buildpath-agent.mjs
```

With Docker (the program file next to you):

```sh
docker run -d --name buildpath-agent --restart on-failure \
  -e BUILDPATH_URL -e BUILDPATH_AGENT_TOKEN -e APP_URL -e GIT_REMOTE -e DEPLOY_COMMAND \
  -v "$PWD/buildpath-agent.mjs:/agent.mjs:ro" -v "$HOME/.ssh:/root/.ssh:ro" \
  node:22-alpine sh -c 'apk add --no-cache git openssh-client >/dev/null && node /agent.mjs'
```

Other settings: `DEPLOY_TIMEOUT_SECONDS` (default 600), `SHARE_DEPLOY_OUTPUT=1`, `WORK_DIR` (temporary clones).

Tests: `src/network-agent/network-agent.test.ts` runs the shipped file against a local bare git repository, a local health
endpoint and the platform's service.
