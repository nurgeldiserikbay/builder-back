# BuildPath API

NestJS REST API for BuildPath. API prefix: `/api/v1`.

## Implemented

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
- Mapped pages can queue disposable Chromium captures at the saved viewport. HTTP resources are limited to pinned, public, same-origin GET requests; service workers, WebSockets, downloads, and browser credentials are disabled. Captures are stored privately with a checksum and short-lived preview URLs.
- Captures are compared with their mapped PNG/JPEG using a bounded deterministic pixel threshold. A private red overlay, changed-pixel percentage, and highest-change regions are saved per capture. This is a visual signal only; it does not determine whether requirements, backend behavior, or the design specification pass.
- Reviewers can record page findings against a successful capture, with category, severity, note, and optional normalized coordinates; page-scoped finding lists are access-controlled and capped.
- Each page can keep a manual requirements checklist. Verification status and optional evidence capture are stored together; marking a requirement satisfied requires a successful capture. This does not infer compliance automatically.
- Authorized users can download a current JSON review report with page coverage, latest capture status, requirement statuses, findings, and explicit limits. The report is a live summary and does not claim AI or backend verification.

## Contract

The OpenAPI source of truth is [apps/api/openapi.yaml](apps/api/openapi.yaml). Account/project management, review-run creation, URL validation and queueing, page discovery/listing, private PNG/JPEG design uploads, page mappings, temporary asset reads, and deterministic capture-to-design pixel diffs are implemented. Figma import, AI interpretation, requirement evaluation, and report generation remain planned.

The design review behavior and security requirements are in [DESIGN_CONFORMANCE.md](https://github.com/nurgeldiserikbay/builder-docs/blob/main/docs/DESIGN_CONFORMANCE.md). Product requirements, architecture, and implementation order live in [builder-docs](https://github.com/nurgeldiserikbay/builder-docs).

## Persistence foundation

The Prisma schema and PostgreSQL migrations define users, hashed sessions and email-verification tokens, workspaces, memberships, projects, and review runs, pages, design sources, captures, jobs, findings, and immutable report versions. Review records have foreign keys to projects and users. Registration requires `RESEND_API_KEY`, `EMAIL_FROM`, and `PUBLIC_APP_URL`.

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

The API listens on port 4000 by default. `/health` reports process status; `/health/ready` reports whether PostgreSQL is reachable. The Compose stack starts PostgreSQL, a private MinIO bucket, and ClamAV for local design uploads. `minio-init` creates the bucket and applies local frontend CORS rules. To run capture jobs, install Chromium, set `CAPTURE_CHROMIUM_EXECUTABLE_PATH` to its executable, and run the worker as a non-root account with restricted network egress. The worker blocks non-same-origin web resources, so pages that depend on third-party assets may look incomplete. Copy `.env.example` to `.env` to use the local endpoints. For a deployed API, configure a private S3-compatible bucket and reachable ClamAV daemon with `DESIGN_ASSETS_*` and `CLAMAV_*`; allow POST and GET from the frontend origin. The example MinIO credentials are development-only.
