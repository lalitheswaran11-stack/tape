# syntax=docker/dockerfile:1
# Build from the repo root:  docker build -f services/feed/Dockerfile .

########################################################################
# builder: pnpm workspace install (filtered) + tsup bundle
########################################################################
FROM node:22-alpine AS builder

# Pin pnpm to the version in the root package.json `packageManager` field.
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /repo

# Workspace skeleton. `--frozen-lockfile` requires the on-disk workspace to
# match the lockfile's importer set exactly, so every workspace project's
# package.json must be present — even for projects we neither install nor
# build. Sources are copied only for the projects this image builds.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/entry/package.json apps/entry/
COPY apps/monitor/package.json apps/monitor/
COPY examples/node-consumer/package.json examples/node-consumer/
COPY packages/tape-codemod/package.json packages/tape-codemod/
COPY packages/tape-react/package.json packages/tape-react/
COPY tools/perf/package.json tools/perf/

# Full sources for the build graph of this image: feed + its one workspace
# dependency (tape-core, used as type-only imports).
COPY packages/tape-core packages/tape-core
COPY services/feed services/feed

# `--filter @tape/feed...` = @tape/feed plus its workspace dependencies.
# Only those projects get node_modules; the stub manifests above merely keep
# the workspace congruent with pnpm-lock.yaml.
RUN pnpm install --frozen-lockfile --filter @tape/feed...

# tape-core first (feed imports its protocol types), then the feed bundle.
# tsup emits a single self-contained dist/main.js (ws inlined, node builtins
# only) — see services/feed/tsup.config.ts.
RUN pnpm --filter @lalitheswaran11-stack/tape-core build \
 && pnpm --filter @tape/feed build

########################################################################
# runtime: node + one file
########################################################################
FROM node:22-alpine

# Config passthrough (flag > env > default, see services/feed/README.md):
#   TAPE_PORT         listen port            (default 4400)
#   TAPE_SEED         PRNG seed              (default 42)
#   TAPE_RATE         update messages/sec    (default 5000)
#   TAPE_INSTRUMENTS  universe size          (default 10000)
ENV NODE_ENV=production \
    TAPE_PORT=4400

WORKDIR /app

# The bundle is ESM in a bare directory; this one-liner manifest tells node
# to parse .js as ESM without a rename or a loader flag.
RUN echo '{"type":"module"}' > package.json \
 && chown node:node package.json

COPY --from=builder --chown=node:node /repo/services/feed/dist/main.js ./main.js

USER node
EXPOSE 4400

# alpine has no curl; node 22 has global fetch.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TAPE_PORT||4400)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# exec form: node is PID 1 and receives SIGTERM; main.ts installs handlers.
CMD ["node", "main.js"]
