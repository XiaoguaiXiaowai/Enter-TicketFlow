FROM node:22-alpine AS build

RUN apk add --no-cache openssl && corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/prisma apps/api/prisma

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @ticket/shared build \
  && pnpm --filter @ticket/api exec prisma generate \
  && pnpm --filter @ticket/api build \
  && pnpm --filter @ticket/api --prod deploy --legacy /out \
  && rm -rf /out/node_modules/@ticket/shared \
  && mkdir -p /out/node_modules/@ticket/shared \
  && cp -r packages/shared/dist packages/shared/package.json /out/node_modules/@ticket/shared/ \
  && cd /out && node node_modules/prisma/build/index.js generate

FROM node:22-alpine AS runtime

RUN apk add --no-cache openssl
ENV NODE_ENV=production

WORKDIR /app
COPY --from=build /out ./

EXPOSE 3000
CMD ["node", "dist/main.js"]
