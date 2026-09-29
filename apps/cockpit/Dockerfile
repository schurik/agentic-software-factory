# The cockpit app: the Next.js front end, plus the Convex functions it deploys
# to the backend when it starts (docker/start.sh). The backend and dashboard
# are Convex's own images; see docker-compose.yml.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/package.json /app/next.config.ts /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/convex ./convex
COPY --from=build /app/docker/start.sh ./start.sh
EXPOSE 3000
CMD ["./start.sh"]
