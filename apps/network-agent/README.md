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

Put the settings in `buildpath-agent.env` next to the program — one `KEY=value` per line, read literally (no shell), so a
deploy command keeps its spaces and quotes:

```sh
BUILDPATH_URL=https://api.example.com/api/v1
BUILDPATH_AGENT_TOKEN=bpa_...
APP_URL=http://app.corp.local:8080                     # optional: enables check
GIT_REMOTE=git@gitlab.corp.local:team/app.git          # optional: enables push
DEPLOY_COMMAND=ssh deploy@app.corp.local ./deploy.sh "$BUILDPATH_BRANCH"  # optional: enables deploy
```

Comments must be on their own lines. With Node.js 22 and git:

```sh
node buildpath-agent.mjs buildpath-agent.env
```

With Docker:

```sh
docker run -d --name buildpath-agent --restart on-failure \
  -v "$PWD:/agent:ro" -v "$HOME/.ssh:/root/.ssh:ro" \
  node:22-alpine sh -c 'apk add --no-cache git openssh-client >/dev/null && node /agent/buildpath-agent.mjs /agent/buildpath-agent.env'
```

The same settings can come from environment variables instead of the file.

Other settings: `DEPLOY_TIMEOUT_SECONDS` (default 600), `SHARE_DEPLOY_OUTPUT=1`, `WORK_DIR` (temporary clones).

Tests: `src/network-agent/network-agent.test.ts` runs the shipped file against a local bare git repository, a local health
endpoint and the platform's service.
