# syntax=docker/dockerfile:1
# Natija application image: API + built web app, served together on port 4000.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/agent/package.json apps/agent/
COPY apps/simulator/package.json apps/simulator/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/protocols/package.json packages/protocols/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @natija/web run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000 TRUST_PROXY=true STORAGE_DIR=/data/storage
WORKDIR /app
RUN corepack enable && useradd --system --uid 10001 natija && mkdir -p /data/storage && chown natija /data/storage
COPY --from=build --chown=natija /app /app
USER natija
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Apply migrations, then start the API (which also serves the web app).
CMD ["sh", "-c", "pnpm --filter @natija/db run migrate && exec pnpm --filter @natija/api run start"]
