# Образ сервиса API.
#
# ⚠️ Появился 18 сентября 2026: до этого Dockerfile-а не было ВООБЩЕ, и
# сервис нечем было упаковать. Переезд с Nuxt разделил код на два
# репозитория, но развёртывание осталось монолитным — прод-образ
# собирался из фронта и ждал `.output` от Nitro.
#
# ⚠️ Собирается НА МАШИНЕ РАЗРАБОТЧИКА и переносится через
# `docker save` (`deploy/push.sh` во фронте): проект приватный, реестра
# нет намеренно — это ещё одно место, где он был бы виден.

FROM node:22-alpine AS base
# libc6-compat нужен некоторым нативным модулям на alpine.
RUN apk add --no-cache libc6-compat
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
# npm ci — воспроизводимая установка строго по lock-файлу.
RUN npm ci

FROM base AS build
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# ⚠️ Сборка — это `tsc` + `tsc-alias`. Второй шаг обязателен: `tsc`
# не переписывает алиас `~` (508 импортов) и не дописывает `.js`,
# без которого ESM-загрузчик Node падает с ERR_MODULE_NOT_FOUND.
RUN npm run build

FROM base AS prod
ENV NODE_ENV=production
# Не root: у скомпрометированного процесса не будет прав в контейнере.
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 -G nodejs api

# ⚠️ Зависимости нужны В ПРОДЕ, в отличие от Nitro-сборки фронта:
# `tsc` не собирает бандл, а компилирует файл в файл — `fastify`, `pg`
# и `valibot` подтягиваются из node_modules при запуске.
# `npm ci --omit=dev` вместо копирования: dev-зависимости (vitest,
# eslint, drizzle-kit) в прод-образе не нужны и увеличивают его втрое.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=api:nodejs /app/dist ./dist
# ⚠️ Миграции нужны в образе: накатываются ОТДЕЛЬНЫМ шагом при деплое,
# до подъёма новой версии. `drizzle/manual/` — то, чего drizzle-kit не
# умеет выразить: EXCLUDE, RLS, роли.
COPY --from=build --chown=api:nodejs /app/drizzle ./drizzle

USER api
EXPOSE 3200

# ⚠️ Проверка живости — тем же путём, что и у Caddy: `/health`, а не
# `/api/health`. Второй вариант остался в Caddyfile от Nuxt и означал
# бы, что балансировщик считает сервис мёртвым всегда.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3200)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/main.js"]
