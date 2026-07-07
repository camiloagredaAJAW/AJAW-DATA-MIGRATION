# node:20-slim (Debian, glibc) — better-sqlite3 has prebuilt binaries for glibc
# targets; alpine (musl) would fall back to a slower node-gyp source compile.
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
# Full install, not --omit=dev: this project runs TypeScript directly via
# `tsx` (see package.json's `dev:api`/`migrate`/`seed` scripts) with no
# separate compile step, so tsx/typescript must be present at container
# runtime, not just at build/dev time.
RUN npm ci

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# Applies pending SQLite migrations and (re)loads the committed field-mappings
# seed before every start — both are documented as idempotent/safe to rerun,
# so this keeps a fresh deploy self-contained without a separate release step.
# `data/` (SQLITE_PATH's default parent dir) must be a persistent volume in
# EasyPanel, or every redeploy starts from an empty database.
CMD ["sh", "-c", "npm run migrate && npm run seed && npm run dev:api"]
