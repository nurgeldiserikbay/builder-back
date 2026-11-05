# BuildPath API

NestJS REST API for BuildPath. API prefix: `/api/v1`.

## Implemented

- Process health endpoint: `GET /api/v1/health`. This checks the HTTP process only; it does not assert database or provider readiness.
- Global DTO validation settings: reject unknown properties and transform validated inputs.
- Review target URL policy helper: accepts HTTP(S) URLs only, resolves all addresses, and rejects non-public address ranges.
- Bounded same-origin discovery core for a future isolated worker: checks the root URL, reads `/sitemap.xml`, follows same-origin HTML links, pins requests to validated DNS addresses, revalidates redirects, and caps pages, depth, response bytes, and request time. It is not yet exposed as an API job or connected to a queue.

## Contract

The initial OpenAPI source of truth is [apps/api/openapi.yaml](apps/api/openapi.yaml). It defines health, account/project operations, and the planned read-only design review workflow (site sources, page discovery, design upload, page mapping, captures, findings, and report export). Only the health operation is implemented; all other operations are explicitly marked planned.

The design review behavior and security requirements are in [DESIGN_CONFORMANCE.md](https://github.com/nurgeldiserikbay/builder-docs/blob/main/docs/DESIGN_CONFORMANCE.md). Product requirements, architecture, and implementation order live in [builder-docs](https://github.com/nurgeldiserikbay/builder-docs).

## Review persistence foundation

The Prisma schema and first PostgreSQL migration define review runs, discovered pages, design sources, page mappings, captures, jobs, findings, and immutable report versions. This is a data-model foundation only: review endpoints and workers are not connected yet. Project and user IDs remain scalar references until the account/project schema and its authorization rules are added; do not expose these tables through API handlers before that work.

Start the local PostgreSQL container with `docker compose up -d postgres`. The development credentials in `.env.example` are for local use only.

Validate the Prisma schema with:

```sh
npm run db:validate
```

## Local development

Requires Node.js 22.12+.

```sh
cp .env.example .env
npm install
npm run start:dev
```

The API listens on port 4000 by default. No credentials are needed for the health endpoint.
