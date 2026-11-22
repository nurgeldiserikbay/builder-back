# Browser end-to-end run

`e2e/flow.mts` walks the whole owner path in a real browser (a phone-sized Chrome window), with a stand-in for the AI so it
needs no keys and no quota:

1. sign-up and the confirmation e-mail;
2. a new «Веб-приложение» project through the wizard;
3. the goal by «Разговор» (the main action must come out as «Оставить заявку в приложении»);
4. the process by «Разговор», with one answer by voice, the situations and acceptance;
5. the ТЗ by AI, with the provider overloaded twice first (the owner must see a plain message and be able to retry);
6. the screens by AI, the architecture and the development package;
7. the AI agent writes the application, and all seven platform checks pass; the preview opens;
8. an owner's change through the agent, visible in the preview;
9. with `E2E_SSH_REPO`: an own git server by SSH, the push of the agent's branch, a change «from the repository» while the
   main branch is still empty (a plain message is expected), and «Запуск у вас» against the application built from the
   pushed branch.

It also fails when an application is described in a site's words (`Цель сайта`, `делает сайт`, an archive recommended as
for a site): the wording comes from `stageFor`, `guideFor` and `codeHostingCard`.

Each step prints one line. A failed step stops the run and saves a screenshot and the page text in `e2e/out/`, with
`results.json` for the whole run.

## What stands in for what

| Real service | In the run |
|---|---|
| AI provider (Gemini, Chat Completions) | `e2e/mock-ai.mts` on `127.0.0.1:4561`: stage drafts are the platform's own templates for the confirmed inputs; «Разговор» asks two questions; the agent writes a small complete application in two turns; voice returns a fixed sentence. `POST /__fail?count=2&status=503` makes the next stage answers fail. |
| E-mail (Resend) | the same process on `127.0.0.1:4555`; `GET /last?to=…` returns the last letter |
| E2B sandbox | `e2e/local-sandbox.mts` on `127.0.0.1:4570`: the agent's commands run in a throwaway folder of that separate process, never in the API. It is not an isolated machine — only on your own computer, only with the scripted agent; the API refuses it in production. |
| The owner's git server | a bare repository behind a local `sshd` |
| The owner's Render | the application cloned from the pushed branch, built and started on `127.0.0.1:4777` |

## Running it

Needs PostgreSQL with the migrations applied, Google Chrome (`E2E_CHROME`, default `/usr/bin/google-chrome`), and for the
repository part `sshd`, `git` and `ssh`.

```sh
# 1. The stand-ins (keep running)
npm run e2e:services

# 2. The API with them (built: npm run build)
BUILDER_AI_OPENAI_API_KEY=mock BUILDER_AI_OPENAI_MODEL=mock-stage \
BUILDER_AI_OPENAI_BASE_URL=http://127.0.0.1:4561/v1 BUILDER_AI_OPENAI_API_STYLE=chat \
BUILDER_AGENT_MODEL=mock-agent BUILDER_AI_TRANSCRIBE_MODEL=mock-whisper \
SANDBOX_PROVIDER=local-http SANDBOX_HTTP_URL=http://127.0.0.1:4570 \
RESEND_API_KEY=mock RESEND_API_URL=http://127.0.0.1:4555 PUBLIC_APP_URL=http://localhost:3000 \
CODE_HOSTING_ALLOW_LOCAL=true CODE_HOSTING_TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32) \
BUILDER_AI_DAILY_RUNS_PER_PROJECT=200 node dist/main.js

# 3. builder-front through its proxy, as on Render
NEXT_PUBLIC_API_BASE_URL=/api/v1 npx next build && API_INTERNAL_URL=http://localhost:4000 PORT=3000 npx next start

# 4. Optional: the owner's git server (the run adds the platform's deploy key to E2E_AUTHORIZED_KEYS itself)
mkdir -p /run/sshd && ssh-keygen -q -t ed25519 -N '' -f /tmp/e2e-hostkey
/usr/sbin/sshd -p 2222 -h /tmp/e2e-hostkey -o PermitRootLogin=prohibit-password
git init --bare /tmp/e2e/flow.git

# 5. The run
E2E_SSH_REPO=ssh://root@localhost:2222/tmp/e2e/flow.git npm run e2e
```

Sign-up is limited to 10 an hour from one address: restart the API between many runs. Each run creates a new owner
(`owner-<time>@e2e.test`) and project; nothing else is changed.

Settings: `E2E_SITE_URL` (default `http://localhost:3000`), `E2E_MAIL_URL`, `E2E_AI_URL`, `E2E_CHROME`, `E2E_SSH_REPO`,
`E2E_SSH_REPO_DIR` (default `/tmp/e2e/flow.git`), `E2E_AUTHORIZED_KEYS` (default `/root/.ssh/authorized_keys`),
`E2E_APP_PORT` (default `4777`).
