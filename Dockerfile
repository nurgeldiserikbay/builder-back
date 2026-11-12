# syntax=docker/dockerfile:1
# One image for the API, the sites server and one-off tasks (migrations, staff accounts):
#   docker compose run --rm api npm run db:migrate:deploy
# The "worker" target adds Chromium for design review captures. The last stage is the API image, so hosts that build the
# final stage without a --target (Render) get the API, not the heavier worker.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY . .
# prisma.config.ts requires DATABASE_URL, but generate and the tests never connect: a placeholder is enough to build.
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN npm run build && npm test

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The Prisma CLI and tsx stay in the image so migrations and the staff-account script can run inside it.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src ./src
COPY --chown=node:node package.json prisma.config.ts tsconfig.json ./
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node apps/api/openapi.yaml ./apps/api/openapi.yaml
USER node
EXPOSE 4000 4100
CMD ["node", "dist/main.js"]

FROM runtime AS worker
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-dejavu-core fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*
ENV CAPTURE_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
USER node
CMD ["node", "dist/worker.js"]

FROM runtime AS app
CMD ["node", "dist/main.js"]
