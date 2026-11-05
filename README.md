# BuildPath API

NestJS REST API for BuildPath. API prefix: `/api/v1`.

## Implemented

- `GET /api/v1/health` checks that the HTTP process is responding.
- `GET /api/v1/health/ready` checks PostgreSQL readiness without returning connection details.
- Shared Prisma 7 PostgreSQL client, graceful shutdown, schema validation, and deployable migrations.
- Account registration with scrypt password hashing, email verification through Resend, HTTP-only cookie sessions, and logout revocation.\n- Private workspace/project listing and project creation with active membership/role checks.\n- Global validation settings plus explicit request field and enum checks on implemented endpoints.
- Review target URL policy helper and bounded same-origin discovery core for a future isolated worker. The crawler is not exposed as an API job or connected to a queue.

## Contract

The OpenAPI source of truth is [apps/api/openapi.yaml](apps/api/openapi.yaml). Health and database readiness are implemented. Design review creation, private upload lifecycle, page discovery jobs, visual comparison, AI findings, and report operations are still planned.

The design review behavior and security requirements are in [DESIGN_CONFORMANCE.md](https://github.com/nurgeldiserikbay/builder-docs/blob/main/docs/DESIGN_CONFORMANCE.md). Product requirements, architecture, and implementation order live in [builder-docs](https://github.com/nurgeldiserikbay/builder-docs).

## Persistence foundation

The Prisma schema and PostgreSQL migrations define users, hashed sessions and email-verification tokens, workspaces, memberships, projects, and review runs, pages, design sources, captures, jobs, findings, and immutable report versions. Review records have foreign keys to projects and users. Review API handlers are not connected yet. Registration requires `RESEND_API_KEY`, `EMAIL_FROM`, and `PUBLIC_APP_URL`.

The local Compose service uses development-only credentials. Start it with `docker compose up -d postgres`.

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
docker compose up -d postgres
npm install
npm run db:migrate:deploy
npm run start:dev
```

The API listens on port 4000 by default. `/health` reports process status; `/health/ready` reports whether PostgreSQL is reachable.
