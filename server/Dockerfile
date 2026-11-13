# syntax=docker/dockerfile:1

# Контекст сборки — папка server/. Клиентские файлы и зависимости
# Electron в серверный образ не попадают.
#
# mediasoup устанавливает заранее собранный worker для поддерживаемой платформы.
# Если готового бинарника нет, потребуется локальная сборка C++; Python в проект
# не добавляется по требованиям задания.
FROM node:24-bookworm-slim AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Runtime-образ.
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# tini корректно передаёт сигналы и переиспользует дочерние процессы.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./package.json
COPY src ./src
COPY scripts ./scripts
COPY shared ./shared
COPY database/migrations ./database/migrations
# Список радиоканалов читается из config/radio-channels.json.
COPY config ./config

USER node

EXPOSE 3000

# UDP-диапазон mediasoup публикуется через docker-compose.yml.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "scripts/healthcheck.js"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
