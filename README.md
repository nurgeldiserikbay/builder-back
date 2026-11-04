# BuildPath API

NestJS REST API for BuildPath. API prefix: `/api/v1`.

## Implemented

- Process health endpoint: `GET /api/v1/health`. This checks the HTTP process only; it does not assert database or provider readiness.
- Global DTO validation settings: reject unknown properties and transform validated inputs.

## Contract

The initial OpenAPI source of truth is [apps/api/openapi.yaml](apps/api/openapi.yaml). It defines health plus the first account and project operations. Only the health operation is implemented in this commit; other operations are explicitly marked planned.

Product requirements, architecture, and implementation order live in [builder-docs](https://github.com/nurgeldiserikbay/builder-docs).

## Local development

Requires Node.js 22.11+.

```sh
cp .env.example .env
npm install
npm run start:dev
```

The API listens on port 4000 by default. No credentials are needed for the health endpoint.
