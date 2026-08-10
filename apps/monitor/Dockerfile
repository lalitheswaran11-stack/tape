# syntax=docker/dockerfile:1
# Build from the repo root:  docker build -f apps/monitor/Dockerfile .
#
#   --build-arg VITE_TAPE_URL=ws://feed-host:4400   (baked at build time;
#   vite inlines import.meta.env.VITE_TAPE_URL into the JS bundle)

########################################################################
# builder: pnpm workspace install (filtered) + vite build
########################################################################
FROM node:22-alpine AS builder

# Pin pnpm to the version in the root package.json `packageManager` field.
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /repo

# Workspace skeleton. `--frozen-lockfile` requires the on-disk workspace to
# match the lockfile's importer set exactly, so every workspace project's
# package.json must be present. Sources only for this image's build graph.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/entry/package.json apps/entry/
COPY examples/node-consumer/package.json examples/node-consumer/
COPY packages/tape-codemod/package.json packages/tape-codemod/
COPY services/feed/package.json services/feed/
COPY tools/perf/package.json tools/perf/

# Full sources: monitor + its workspace dependencies (tape-core, tape-react).
COPY packages/tape-core packages/tape-core
COPY packages/tape-react packages/tape-react
COPY apps/monitor apps/monitor

RUN pnpm install --frozen-lockfile --filter @tape/monitor...

# ARG after install so changing the URL never busts the install layer.
ARG VITE_TAPE_URL=ws://localhost:4400
ENV VITE_TAPE_URL=${VITE_TAPE_URL}

# Library builds first — vite resolves the workspace packages via their
# package.json `exports`, which point at dist/.
RUN pnpm --filter @lalitheswaran11-stack/tape-core build \
 && pnpm --filter @lalitheswaran11-stack/tape-react build \
 && pnpm --filter @tape/monitor build

########################################################################
# runtime: unprivileged nginx serving static files on 8080
########################################################################
FROM nginxinc/nginx-unprivileged:alpine

COPY --from=builder /repo/apps/monitor/dist /usr/share/nginx/html

EXPOSE 8080
