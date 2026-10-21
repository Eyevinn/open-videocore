FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# Build identity, part 1: the identifier that needs no build arguments
# (issue #827).
#
# A running container has no `.git`, so it cannot work out what it is at
# runtime — the answer has to be baked in here. Nor can it be assumed that
# whoever builds this image passes build arguments: the published image is
# built from the repository fork by the platform, not by this repo's CI. So the
# digest below is computed from the files that go into the image, using only
# Node. It is reproducible from a checkout (scripts/find-build-commit.sh maps it
# back to a commit) and it differs between any two builds of different source —
# which is the whole point: a released build and a rolling build sharing a
# package.json version must not report the same thing.
#
# public/ is copied into this stage only so it can be hashed; the runtime stage
# copies it from the build context as before.
COPY public ./public
COPY scripts/source-digest.mjs ./scripts/source-digest.mjs
RUN printf 'BUILD_SOURCE_DIGEST=%s\nBUILT_AT=%s\n' \
      "$(node scripts/source-digest.mjs)" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      > build.env

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY --from=build /app/build.env ./build.env
COPY public ./public

# Build identity, part 2: the git-derived identifiers, when the builder has
# them (issue #827). Empty by default, so an image built without them reports
# "unknown" rather than something plausible and wrong. Build with:
#
#   docker build \
#     --build-arg BUILD_VERSION="$(git describe --tags --always --dirty)" \
#     --build-arg BUILD_COMMIT="$(git rev-parse HEAD)" .
#
# Both are plain environment variables, so a deployment can also inject them
# without rebuilding.
ARG BUILD_VERSION=""
ARG BUILD_COMMIT=""
ENV BUILD_VERSION=${BUILD_VERSION} \
    BUILD_COMMIT=${BUILD_COMMIT}

EXPOSE 3000

# build.env carries the two values that describe THIS image and that no caller
# should be able to misreport (the source digest and the build timestamp), so it
# is loaded at start-up and wins over the environment. `exec` keeps node as
# PID 1 so it still receives stop signals directly.
CMD ["sh", "-c", "set -a; . ./build.env; set +a; exec node dist/main.js"]
