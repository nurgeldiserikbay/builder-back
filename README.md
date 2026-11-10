# BuildPath API

NestJS REST API for BuildPath. API prefix: `/api/v1`.

## Implemented

### Stage journey (builder flow)

- `GET /api/v1/journey/catalog` lists project types (`landing`, `company_site`) and their stage routes from the versioned catalog in `src/journey/catalog.ts` (explanations, fields, acceptance criteria, built-in AI playbooks).
- Creating a project with `projectType` (and optional `startStageKey`) creates the route: the first stage, or the chosen start stage with its earlier stages, opens; the rest stay closed until their inputs are accepted.
- Each stage keeps immutable versions with provenance (`owner_edit`, `ai_generated`, `template`, `imported`, `compiled`, `restored`). Manual edits lock the changed parts; AI regenerations keep locked parts unless a part is explicitly targeted. One-off instructions, stage rules and project rules are stored and sent to the AI as untrusted data below platform rules and accepted inputs.
- Owner/manager acceptance is deterministic: inputs must be accepted and the artifact complete. Reopening an accepted stage marks accepted later stages `stale` until they are confirmed or updated.
- Stages can start from pasted material (`import`); complete material whose inputs are accepted gets status `imported`.
- The build stage renders one self-contained, script-free HTML page from accepted versions with a restrictive CSP and runs deterministic checks (main action link, contacts, placeholders, headings, WCAG AA palette contrast, SEO lengths). Required failed checks block acceptance; a build made from older versions cannot be accepted.
- `GET /projects/:id/result` returns the result package at any stage: `project.md`, `project.json` and, after the build, `site.html`; unaccepted stages are listed as open items.
- AI is optional. Configure `BUILDER_AI_OPENAI_API_KEY` and `BUILDER_AI_OPENAI_MODEL`; without them, texts and style get deterministic template drafts and instructions return `AI_NOT_CONFIGURED`. Generations are limited per project per day (`BUILDER_AI_DAILY_RUNS_PER_PROJECT`, default 40). Specialists, AI budgets per assignment and Telegram are not implemented yet; see `STAGE_WORK_MODEL.md` in builder-docs.

### Specialists on a stage

- Owners and managers invite a specialist to one stage (`POST /projects/:id/stages/:key/assignments`) as **lead** (directs the stage AI, edits, submits for review) or **consultant** (reads and suggests AI instructions). Invitations last 7 days, are bound to the invited e-mail, and are e-mailed through Resend when configured; the link is always returned so the owner can send it in any messenger.
- Specialists are not project members, so all project-wide checks (other stages, result package, publication, leads, review tool, project list) keep excluding them. They see only the assigned stage and the accepted versions of its inputs; their AI runs see the same scope. A lead can add stage rules but not project rules; an optional `aiBudget` caps their generations.
- `submit` puts the stage in `in_review` (read-only) and notifies the owner in Telegram when linked; the owner accepts or uses `request-changes` with a note (the lead is notified). Accepting completes the assignment: writing stops immediately, reading continues for 7 days. Owners can revoke at any time; all of this is recorded in project events.
- **Terms, time and payment.** An invitation carries terms: no payment through the platform, a fixed price for the stage (optionally with included revision rounds), or an hourly rate with an hour limit (optional weekly limit and «pay only time with result»). Nothing is paid upfront. While a specialist with an active assignment has the stage page open and interacts with it, the page sends `POST …/activity`; the server joins activity less than 5 minutes apart into intervals and counts actions in each (drafts, AI requests, imports, submissions, suggestions — also from Telegram). Tracking stops at the limit; at 80% both sides get a Telegram warning. A specialist can add time worked elsewhere with a note. `GET …/timesheet` shows intervals by day and marks those without actions as «без результата»; the owner approves or disputes entries (a comment is required and the specialist can answer), and entries left undisputed for 3 days count as approved. When the owner accepts the stage, a payment is created: the fixed price, or approved minutes within the limit × rate. Until a payment provider is connected, the owner pays directly and marks it (`POST /projects/:id/payments/:id/mark-paid`). A specialist's import never accepts a stage by itself. The project budget shows planned, due and paid amounts to the owner and managers only.

### Production deployment

`deploy/` holds the single-server production stack: `compose.prod.yaml` (Caddy with automatic HTTPS, API, sites server, front, admin, PostgreSQL, ClamAV, daily backups; design-review worker and MinIO behind a profile), `Caddyfile`, `.env.production.example` and backup/restore scripts. The step-by-step guide in Russian is `deploy/README.md`.

- The app and the console call the API on their own origin (`/api/v1`), so production needs no CORS and cookies stay first-party.
- Published sites get TLS certificates on demand; Caddy asks `GET /__caddy/ask?domain=` on the sites server, which allows only live site hosts. `GET /__health` on the sites server checks the database.
- Optional error reporting: `SENTRY_DSN` (API, sites server, worker) and `NEXT_PUBLIC_SENTRY_DSN` (front/admin), Sentry or GlitchTip. Events are scrubbed of cookies, bodies, query strings and user data; expected 4xx errors are not reported.
- `TRUST_PROXY=true` makes the API use the client address from the proxy.

### Site photos

- `POST /projects/:id/images` (multipart `file`, optional `alt`) accepts JPEG, PNG or WebP up to 12 MB from members or the content-stage lead. The original is scanned with ClamAV first (fail-closed: 503 `IMAGE_SCAN_UNAVAILABLE` if clamd is unreachable), then decoded with sharp and re-encoded to WebP ≤ 1600 px, which strips EXIF/location and any non-pixel data. Up to 30 photos per project, stored in PostgreSQL (`project_images`).
- Content sections reference photos by `imageId` only; the renderer emits `<img src="/img/<id>.webp" alt width height>` with `img-src 'self' data:`. Only photos of the same project are rendered; a missing photo fails the build check, a missing description is a warning. AI rewrites keep chosen photos.
- Previews and the downloaded `site.html` inline the photos as data URIs, so they work offline. The sites server serves `/img/<id>.webp` only for photos that the published page shows.
- For local development without ClamAV set `UPLOAD_MALWARE_SCAN=disabled`; this is ignored when `NODE_ENV=production`.

### Legal documents, consent and account deletion

- The offer and privacy policy (version 1.0) live in `src/legal/documents.ts` and are served by `GET /api/v1/legal/{terms|privacy}` with company details from `LEGAL_*` variables and the current retention periods filled in. Unset details show as «[будет указано]».
- Registration requires `acceptLegal: true`; the accepted versions and time are stored in `user_consents`. When a version is bumped, `/me` reports `consentRequired` and other signed-in routes answer `403 CONSENT_REQUIRED` until `POST /me/consent`; the Telegram bot asks the user to accept in the app.
- `POST /me/deletion` (password + confirmation) immediately signs the user out everywhere, unpublishes their sites, revokes everyone's access to their projects and their own stage assignments, and unlinks Telegram. The rest is kept for the retention period (admin console, 1–90 days, default 30), then purged by the API process hourly (`ACCOUNT_PURGE_DISABLED=true` turns it off). Staff can restore an account during that period (`POST /admin/accounts/restore`, audited).

### Choice cards and code hosting

Decisions with consequences are choice cards (`src/choices/cards.ts`): options with pros, limits, cost, upkeep and how easy it is to leave, a deterministic recommendation with a reason, and step-by-step instructions the owner ticks off. The first card is «Где хранить код»: download the archive, GitHub or GitLab (gitlab.com or an own server with a public address). Connecting checks the repository address and a repository-scoped access token against the provider and keeps the connection only when writing is allowed; the token is encrypted with `CODE_HOSTING_TOKEN_ENCRYPTION_KEY` and never returned. «Отправить в репозиторий» shows exactly which files go to which branch and sends accepted results as one commit only after confirmation. API: `/projects/{id}/choices/{card}`, `/projects/{id}/repository`, `/projects/{id}/repository/push`. **«Войти через GitHub»**: with `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` and `PUBLIC_API_URL` set, the GitHub option shows two steps instead of the manual token steps: sign in (`POST /projects/{id}/repository/github/start` returns GitHub's consent page with a single-use state, stored only as a hash and bound to the person and project for 10 minutes; GitHub redirects to `GET /oauth/github/callback`, which exchanges the code, stores the person's token encrypted in `git_accounts` and sends the browser back to the card), then pick a writable repository or create a new empty one in the person's account after explicit confirmation (`GET …/repository/github/repos`, `POST …/repository/github/connect`). The scope is `repo` (the narrowest GitHub OAuth scope for private repositories); BuildPath writes only to the repository the owner connected and only on «Отправить». `DELETE /me/git-accounts/github` forgets the account (revoke it on GitHub under Settings → Applications). The pasted-key path stays as a fallback. For local testing, `CODE_HOSTING_ALLOW_LOCAL=true` accepts `http://localhost` repository addresses (a local mock of the GitHub API under `/api/v3`).

The second card is «Где будет работать сайт»: on BuildPath (recommended), GitHub Pages (needs GitHub chosen and connected in «Где хранить код») or an own server. For an own server BuildPath gives a package (`GET /projects/{id}/deployment/package`: the accepted page, a Caddy config with automatic HTTPS, `compose.yaml` and instructions; the app saves it as one zip). `POST /projects/{id}/deployment/verify` opens the address (public addresses only, redirects re-checked, 3 MB limit) and compares it with the accepted version: matches, outdated (same site, older version), different, unreachable; for BuildPath it checks that the publication is live and current.

### Contracts and parallel stages

A stage definition can be a contract (`contract` in the catalog; today «Цель сайта»). The owner approves it («Утвердить»), and every stage whose inputs are then satisfied opens at once: the style («Внешний вид») now depends only on the goal, so it runs alongside services and texts. A stage that brings branches together (two or more inputs, e.g. «Сборка») cannot be built or accepted while any stage it is built on has an undecided change (409 `BRANCHES_NOT_ALIGNED`), so all branches use the same contract version. Stage detail reports `contract`, `impact` (stages that open, stages that will be notified) and `waitingBranches`.

### Changes between stages

Reopening an accepted stage changes only that stage: stages built on it keep using its last accepted version. When a new version is accepted, every stage built directly on it that already has work gets a change notice (`change_notices`) with a plain-language list of changes; that stage stays pinned to the version it was built on and cannot be accepted or submitted until its lead (or the owner) decides: accept and update, accept without changes, or ask a question. The author of the changed stage answers (keep, will revise, ask the owner). A newer accepted version supersedes the notice and keeps the original pin; reverting to the pinned version closes it. Participants get Telegram notices. API: `GET /projects/{id}/stages/{key}/changes`, `POST /projects/{id}/changes/{noticeId}`.

### AI money: prices, cost of each request, project estimate

Super admins set customer prices per million input and output tokens in the admin console (`/admin/ai-pricing`, audited). Every AI request stores its own cost in tiyn (`generation_runs.cost_tiyn`) at the prices of that moment, failed requests included. `GET /projects/{id}/budget` (project members) returns the estimate for the route — expected requests per stage × typical tokens (average of recent requests, defaults until there are 20) × price, as a range — and what was spent by stage and participant; stage pages show the approximate price of one request. Requests made before prices were set are reported as unpriced.

### AI request history

Every AI request and template draft is stored as a `generation_runs` row with who asked, stage and block, source (`app` or `telegram`), model, provider-reported tokens (`input_tokens`, `output_tokens`, also on failed runs) and the resulting version. `GET /api/v1/projects/{id}/ai-history` lists them with filters by stage, participant, text and period, shows what happened to each result (accepted, current draft, replaced, failed) and totals by participant and stage. Owners and managers see the whole project; a specialist sees only their stages.

### Plans and limits

- Three plans in `src/billing/plans.ts` (catalog 1.0.0): **Бесплатный** (2 projects, 30 AI requests a month, 1 live site, no specialists), **Старт** (5 / 300 / 3, specialists) and **Бизнес** (25 / 1500 / 15, specialists). Limits belong to the account that owns the projects; AI requests of invited specialists count for the owner. Template drafts are free.
- Enforced on the server: creating or restoring a project (`PLAN_LIMIT_PROJECTS`), AI generation (`PLAN_LIMIT_AI`), publishing a new site (`PLAN_LIMIT_SITES`; updating a live site is always allowed), inviting specialists (`PLAN_NO_SPECIALISTS`). Existing projects and live sites keep working when an account is over its limits.
- `GET /me/plan` shows the plan, usage and catalog; prices (`plan_prices`, tenge per month; starting values 4 990 ₸ «Старт» and 14 990 ₸ «Бизнес») and the upgrade contact (`billing_settings`, falls back to `SALES_CONTACT_URL`) are managed by staff at `GET/POST /admin/plan-settings` (change: `super_admin`, every change is audited).
- There is no online payment yet. Staff assign a plan after a confirmed payment with `POST /admin/accounts/plan` (super_admin, audited as `account.plan_assigned`) or the «Customer plans» section of builder-admin; an optional end date returns the account to the free limits.
- Owners can archive projects (`POST /projects/:id/archive`, not while published; revokes specialist access) and restore them if the plan allows.

### Stage work in Telegram

- After linking (`/start <code>`), the bot works with projects: `/projects` lists projects (and stages where the account is a specialist), inline buttons open a project and a stage card with status, the current version summary and what is missing. From the card: ask the AI (the next text message is the instruction), build the site, accept with a confirmation step, send for acceptance, return with a comment, or suggest a change as a consultant. `/cancel` drops an awaited reply; voice messages are answered with a text-only notice.
- The bot calls `JourneyService` as the linked account, so it can do exactly what that account can do in the web app. Chat context (`telegram_chat_states`) keeps only the selected project/stage and an awaited reply for 15 minutes; it is deleted on `/stop` or unlinking.
- «Открыть в приложении» is a Telegram Mini App button when `PUBLIC_APP_URL` is HTTPS (a plain link otherwise). The web app recognises `?tg=1`, loads Telegram's WebApp script and calls `POST /auth/telegram-webapp` with the signed initData; linked accounts are signed in and returned to the opened page.
- Verified locally against a mock Bot API and simulated Mini App initData; a real bot and Telegram clients were not tested.

### Publication and lead forms

- `POST /projects/:id/publication` publishes the accepted build at `<slug>.<SITES_BASE_DOMAIN>` after explicit confirmation (owner/manager); `GET` shows state, a suggested latin address from the business name, whether a newer accepted build is not yet published, and notification channels; `unpublish` takes the site offline. The project status becomes `live` while published.
- Published sites are served by a separate process, `npm run start:sites` (port `SITES_PORT`, default 4100), on a different origin from the app and API. It serves only the accepted build HTML with a restrictive CSP (`frame-ancestors 'none'`, no scripts), plus `/privacy`, `/thanks`, `robots.txt` and `sitemap.xml`. Locally, open `http://<slug>.localhost:4100`.
- If the owner chooses «Оставить заявку на сайте» as the main action, the page gets a script-free lead form with a required consent checkbox and a link to an auto-generated data notice. Submissions go to `POST /__forms/lead` on the sites server: honeypot spam is dropped, cross-origin posts are rejected, and there are limits of 5 leads per visitor per hour and 200 per site per day (visitor IPs are stored only as salted hashes). Leads are deleted after `LEAD_RETENTION_DAYS` (365).
- Leads notify the project owner by Telegram (bot linked through a one-time deep link from `POST /me/telegram/link`, `/start <code>` in the bot, `/stop` to unlink) and/or email via Resend. Delivery status per lead is stored; leads are listed and deletable at `GET/DELETE /projects/:id/leads`.
- Production needs wildcard DNS and TLS for `*.SITES_BASE_DOMAIN`, a reverse proxy to the sites server, a Telegram bot with its webhook registered (see `.env.example`), and `SITES_IP_HASH_SALT`. These were verified locally only (Telegram through a mock Bot API); no live domain or bot was tested.

Run unit tests with `npm test`.


### Online booking route («Онлайн-запись к мастеру»)

- Project type `booking`: goal → services and prices → **«Расписание и запись»** → texts → design → build. The schedule stage has no AI: it starts from the accepted services with 60 minutes each and one master working Mon–Sat 10:00–19:00, and the owner sets real durations, masters (which services, hours per weekday), the step between start times (15/30/60 min), minimum notice, how many days ahead and the client cancellation deadline, in a fixed list of time zones. Validation is in `src/journey/schedule.ts`; acceptance is blocked while a service has no master or a master has no working days.
- The build embeds the accepted schedule and prices into the site (`meta.booking`), adds an «Онлайн-запись» section and points buttons to `/book`. Build checks: every bookable service has a master (required), all offered services are bookable (warning), an owner contact exists for the data notice (required).
- On the sites server the booking steps are script-free pages: service → master or «любой свободный» → day and time → name, phone, comment and consent (`POST /__forms/booking`). Free time is computed from the schedule and active bookings; the write takes a transaction-scoped advisory lock per site and recomputes the free time inside it, so the same master is never booked twice for overlapping time (verified with 8 parallel requests: one booking, seven «время уже заняли»). «Любой свободный» picks the master with fewer bookings that day. Same limits and honeypot as lead forms. The client gets a private link `/book/b/<token>` (only its hash is stored) to see or cancel the booking until the cancellation deadline (`POST /__forms/booking-cancel`).
- The owner is notified in Telegram/email about new and cancelled bookings (site notification settings), sees bookings at `GET /projects/:id/bookings?scope=upcoming|past` and can cancel or mark «пришёл» / «не пришёл» (`POST /projects/:id/bookings/:id/status`). Bookings are deleted `LEAD_RETENTION_DAYS` after the visit.
- **«Технический план»** (contract stage after the schedule, no AI): the platform derives the plan from the accepted goal and schedule — features, roles, data, pages, notifications, hosting options, limits — each in plain words with a technical note, plus the OpenAPI 3.1 contract of the booking pages and forms (`src/journey/techplan.ts`, version 1.0.0). The client sends only `ownerNotes`; the rest is recomputed on the server on every save. If the accepted inputs change, the stage gets a change notice, shows «Обновить план», and cannot be accepted while outdated (`TECHPLAN_OUTDATED`). The build has a required check that the plan version matches the implemented one; the result package adds `techplan.md` and `booking-api.yaml`.
- **Own server.** For a booking site, the «Свой сервер» package (`GET /projects/:id/deployment/package`, `kind: booking_app`) contains `app/server.mjs` — the booking program bundled by `scripts/build-export.mjs` (esbuild, part of `npm run build`) from the same `schedule.ts` and `booking-pages.ts` modules, with no dependencies beyond Node.js 22 — plus `app/config.json` (accepted schedule, prices, site style), `app/index.html`, a Caddy reverse proxy, `compose.yaml`, `.env.example` (`ADMIN_PASSWORD`, optional `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`) and a README in Russian. Bookings are stored in `data/bookings.json` (atomic writes through one in-process queue, so one instance never double-books; run one instance only); the owner sees and manages them at `/admin` behind HTTP Basic auth. Verified by `src/export/booking-server.test.ts` and by downloading the package from the API and running `node server.mjs`; the Docker Compose files themselves were not run here.
- Not yet: masters' own accounts, client reminders (SMS/WhatsApp), breaks and days off by date, prepayment, booking on GitHub Pages (static hosting cannot take bookings; the deployment card says so).

### Review tool

- Public `GET /api/v1/capabilities` returns the deterministic, versioned platform support manifest. Staff-only `GET /api/v1/admin/capabilities` exposes the same catalog after staff authentication and role authorization.
- Separate staff login, 12-hour hashed-token sessions, account status checks, five-attempt/15-minute identifier rate limiting, and audit events for login/logout/denied access. Provision the first account explicitly with `STAFF_INITIAL_EMAIL`, `STAFF_INITIAL_PASSWORD`, `STAFF_INITIAL_DISPLAY_NAME`, `STAFF_INITIAL_ROLE` and `npm run staff:create`; no default credentials are created.
- Staff-only quality profile API supports policy drafts, immutable activated snapshots, restoring a retired version, role-based write access, and audit events containing before/after draft policy values. The first activated profile becomes the global default; administrators can change it explicitly. New review runs snapshot that version and reports evaluate requirement coverage, failed user-run API probes, available accessibility/SEO heuristics, and open findings. Security and performance scans remain unsupported; required categories without evidence block the report gate. The report result does not authorize publishing.

- `GET /api/v1/health` checks that the HTTP process is responding.
- `GET /api/v1/health/ready` checks PostgreSQL readiness without returning connection details.
- Shared Prisma 7 PostgreSQL client, graceful shutdown, schema validation, and deployable migrations.
- Account registration with scrypt password hashing, email verification through Resend, HTTP-only cookie sessions, and logout revocation.
- Private workspace/project listing and project creation with active membership/role checks.
- Create and read project-bound review runs with idempotent request replay and membership authorization.
- Validate public review URLs, enqueue same-origin discovery jobs, and list discovered pages. Run the separate crawler process with `npm run start:worker`; the API does not fetch customer sites.
- Global validation settings plus explicit request field and enum checks on implemented endpoints.
- Same-origin discovery runs in the standalone worker with page/depth caps, response-size limits, timeouts, redirect checks, and pinned public-address requests.
- Private PNG/JPEG design uploads use short-lived S3-compatible POST forms, project authorization, checksum and magic-byte checks, ClamAV scanning, and verified page-to-design mappings. Verified assets can be opened through short-lived authorized download URLs.
- Users can connect a Figma account with OAuth 2.0 and PKCE, import a frame by Figma URL, scan its rendered PNG with ClamAV, and map it to a review page. OAuth tokens are encrypted at rest.
- Mapped pages can queue disposable Chromium captures at the saved viewport. HTTP resources are limited to pinned, public, same-origin GET requests; service workers, WebSockets, downloads, and browser credentials are disabled. Captures are stored privately with a checksum and short-lived preview URLs.
- Captures are compared with their mapped PNG/JPEG using a bounded deterministic pixel threshold. A private red overlay, changed-pixel percentage, and highest-change regions are saved per capture. This is a visual signal only; it does not determine whether requirements, backend behavior, or the design specification pass.
- Capture jobs record a bounded DOM quality audit: page title/language, primary heading count, image alt coverage, accessible names for links/buttons, and form labels. The audit stores counts and booleans, not page text, and is a heuristic rather than a complete accessibility assessment.
- Reviewers can record page findings against a successful capture, with category, severity, note, and optional normalized coordinates; page-scoped finding lists are access-controlled and capped.
- Each page can keep a manual requirements checklist. Verification status and optional evidence capture are stored together; marking a requirement satisfied requires a successful capture. This does not infer compliance automatically.
- Authorized users can download a current JSON review report with page coverage, latest capture status, pixel-difference percentages, requirement statuses, findings, explicit rule-based signals, and limitations. It is a live summary, not an AI assessment or proof of backend correctness.

## Contract and limits

The OpenAPI source of truth is [apps/api/openapi.yaml](apps/api/openapi.yaml). The API supports account/project management, review-run creation, URL validation and queueing, page discovery/listing, private design uploads, Figma frame import, page mappings, authorized temporary asset reads, captures, deterministic pixel diffs, manual requirements/findings, and JSON reports.

On-demand AI visual analysis is available for a captured page with a verified mapped design when `AI_REVIEW_OPENAI_API_KEY` and `AI_REVIEW_OPENAI_MODEL` are configured. It sends both images to OpenAI only after a reviewer presses Analyze, stores suggestions on the immutable capture, and does not mark requirements as passed or create findings automatically. API probes run in the browser and are user-configured; their sanitized results are evidence, not a backend correctness guarantee. DOM audit and report signals use explicit rules and cannot replace human review or a full WCAG assessment.

The design review behavior and security requirements are in [DESIGN_CONFORMANCE.md](https://github.com/nurgeldiserikbay/builder-docs/blob/main/docs/DESIGN_CONFORMANCE.md). Product requirements, architecture, and implementation order live in [builder-docs](https://github.com/nurgeldiserikbay/builder-docs).

## Figma OAuth setup

Create a Figma OAuth app with the `file_content:read` scope and register the exact frontend callback URL, for example `http://localhost:3000/integrations/figma/callback`. Set `FIGMA_CLIENT_ID`, `FIGMA_CLIENT_SECRET`, and `FIGMA_REDIRECT_URI` on the API. Generate a dedicated 32-byte encryption key with `openssl rand -base64 32` and store it as `FIGMA_TOKEN_ENCRYPTION_KEY`. Keep the OAuth secret and encryption key in the deployment secret manager; do not commit them. Apply the `20261106020000_figma_oauth` migration before enabling the integration. The API refreshes expired access tokens automatically during imports and stores replacement tokens encrypted; if Figma revokes the grant, the user must reconnect.

## Persistence foundation

The Prisma schema and PostgreSQL migrations define users, hashed sessions and email-verification tokens, encrypted per-user Figma OAuth connections and short-lived OAuth states, workspaces, memberships, projects, review runs, pages, design sources, captures, jobs, findings, and report versions. Review records have foreign keys to projects and users. Registration requires `RESEND_API_KEY`, `EMAIL_FROM`, and `PUBLIC_APP_URL`.

The local Compose services use development-only credentials. ClamAV downloads its signature database on first startup, so scanning can take a little while to become ready.

Validate the Prisma schema with:

```sh
npm run db:validate
```

Apply the committed PostgreSQL migrations with:

```sh
npm run db:migrate:deploy
```

## Local development

Requires Node.js 22.12+.

```sh
cp .env.example .env
docker compose up -d
npm install
npm run db:migrate:deploy
npm run start:dev
```

The API listens on port 4000 by default. `/health` reports process status; `/health/ready` reports whether PostgreSQL is reachable. The Compose stack starts PostgreSQL, a private MinIO bucket, and ClamAV for local design uploads. `minio-init` creates the bucket and applies local frontend CORS rules. To run capture jobs, install Chromium, set `CAPTURE_CHROMIUM_EXECUTABLE_PATH` to its executable, and run the worker as a non-root account with restricted network egress. The worker blocks non-same-origin web resources, so pages that depend on third-party assets may look incomplete. Copy `.env.example` to `.env` to use the local endpoints. For a deployed API, configure a private S3-compatible bucket and reachable ClamAV daemon with `DESIGN_ASSETS_*` and `CLAMAV_*`; allow POST and GET from the frontend origin. The example MinIO credentials are development-only. AI review is optional and can incur provider usage charges for each newly analyzed capture; the saved result is reused on subsequent requests.

### Project balance and payments

- Staff choose the billing mode (`/admin/billing-mode`, super_admin): **off** (default — AI requests are counted in the project estimate) or **prepaid** (switch-on time is stored as `prepaidSince`). In prepaid mode an AI request needs a project balance of at least one typical request; otherwise it is refused with `402 PROJECT_BALANCE_LOW`. Balance = paid top-ups − recorded cost of AI requests since `prepaidSince` (`src/payments/wallet.ts`).
- The owner tops up from the project (`GET /projects/:id/wallet`, `POST /projects/:id/wallet/top-ups` with whole tenge between the minimum and 500 000 ₸) and is sent to the provider's payment page. A top-up becomes **paid only after a signed provider callback**, once (repeated callbacks do not credit twice), and only when amount and currency match.
- Provider: **Freedom Pay** (`FREEDOMPAY_*`), implemented from its Merchant API documentation — `init_payment.php`, `result_url` (`POST /api/v1/payments/freedompay/result`, signed XML reply), MD5 signature over «script;values sorted by key;secret». Verified with unit tests and a local stand-in server; **not yet verified against a live Freedom Pay merchant account**. `PAYMENTS_PROVIDER=mock` gives a local test payment page and is refused in production.
- Not yet: refunds, receipts (fiscal), paying specialists through the platform, Kaspi Pay.
