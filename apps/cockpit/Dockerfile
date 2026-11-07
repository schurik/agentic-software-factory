# The cockpit app: the Next.js front end, plus the Convex functions it deploys
# to the backend when it starts (docker/start.sh). The backend and dashboard
# are Convex's own images; see docker-compose.yml. Bun only, no Node: `bun run`
# and `bun x` stand in for `node` when a package's bin asks for it.
FROM oven/bun:1.4-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build && rm -rf node_modules && bun install --frozen-lockfile --production

FROM oven/bun:1.4-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/package.json /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/convex ./convex
COPY --from=build /app/docker/start.sh /app/docker/convex.sh ./
# Which build this is, as CI passes it (deploy-cockpit.yml, release.yml): the
# footer shows it, and start.sh records each new one as a deploy. Last, so a
# new commit rebuilds nothing above it. A build without them is a local one.
ARG BUILD_REF="" BUILD_VERSION="" BUILD_COMMIT="" BUILD_TIME="" BUILD_NUMBER="" BUILD_RUN_URL="" BUILD_SOURCE=""
ENV COCKPIT_BUILD_REF=$BUILD_REF COCKPIT_BUILD_VERSION=$BUILD_VERSION COCKPIT_BUILD_COMMIT=$BUILD_COMMIT \
    COCKPIT_BUILD_TIME=$BUILD_TIME COCKPIT_BUILD_NUMBER=$BUILD_NUMBER COCKPIT_BUILD_RUN_URL=$BUILD_RUN_URL \
    COCKPIT_BUILD_SOURCE=$BUILD_SOURCE
EXPOSE 3000
CMD ["./start.sh"]
