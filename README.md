# MoscowRoleplay Voice

Голосовая система для Roblox ER:LC проекта MoscowRoleplay: голос по близости, радиоканалы, вход через Discord и привязка Roblox-аккаунта.

Проект состоит из двух независимых частей:

- `app/` — Windows-приложение на Electron;
- `server/` — Node.js-сервер, PostgreSQL, mediasoup и Docker-развёртывание.

Общий протокол WebSocket хранится в `server/shared/protocol.js` и синхронизируется в `app/shared/protocol.js`.

> Исходный код готов к запуску, но реальные интеграции требуют собственных ключей Discord, Bloxlink и PRC, публичного IP и HTTPS. Проверки с настоящими внешними сервисами и двумя микрофонами в среде разработки не выполнялись — подробности в разделе 10.

## 1. Назначение папок

### `app/`

Только Windows-приложение:

- главный процесс Electron и безопасный preload;
- renderer, интерфейс, стили и клиентские модули;
- авторизация Discord на стороне клиента;
- mediasoup-client и WebRTC;
- Web Audio, микрофон, PTT;
- клиентская логика proximity и radio;
- настройки, иконки и ресурсы;
- конфигурация electron-builder;
- `package.json`, lock-файл и `node_modules` клиента;
- готовый установщик в `app/release/`;
- документация по клиенту в `app/docs/`.

В `app/` нет серверных зависимостей, PostgreSQL, миграций, Dockerfile сервера и серверных секретов.

### `server/`

Только серверная часть и её развёртывание:

- Node.js backend на ES Modules;
- HTTP, WebSocket и signaling;
- mediasoup v3;
- Discord OAuth2, Discord Bot, Bloxlink, Roblox Users API;
- радиороли нескольких Discord-серверов через `DISCORD_ROLE_GUILD_IDS`;
- PRC ER:LC API V2, Game State;
- серверные Proximity Engine и Radio Engine;
- PostgreSQL, миграции и init-скрипты;
- `server/config/radio-channels.json` и инструкция `server/config/README.md`;
- `Dockerfile`, `docker-compose.yml`, `docker-compose.dev.yml`, `.dockerignore`;
- `.env.example`;
- `package.json`, lock-файл и `node_modules` сервера;
- серверная документация в `server/docs/`.

В `server/` нет Electron main/preload, renderer, Windows installer и клиентских зависимостей.

### Shared

Общие контракты нужны обеим частям, поэтому протокол присутствует в двух местах:

- `server/shared/protocol.js` — **канонический источник**;
- `app/shared/protocol.js` — синхронизированная копия для клиента.

В shared находятся только типы сообщений, коды ошибок, перечисления и константы. Серверная бизнес-логика, доступ к PostgreSQL, секреты и клиентский интерфейс туда не попадают.

Синхронизация и проверка:

```powershell
cd server
npm run shared:sync
npm run shared:check
```

`server/npm run verify` и `app/npm run check` сравнивают SHA-256 копий. Если вторая папка отсутствует, проверка пропускается — части можно устанавливать независимо. Подробнее: `app/shared/README.md` и `server/shared/README.md`.

## 2. Структура проекта

```text
MoscowRoleplay Voice/
├── app/
│   ├── assets/                  # иконки приложения
│   ├── docs/                    # документация клиента
│   ├── electron/                # main, preload, auth, signaling, settings
│   ├── renderer/                # UI, audio, mediasoup-client, proximity, radio
│   │   ├── index.html
│   │   ├── styles.css
│   │   ├── src/
│   │   └── dist/                # сборка esbuild, не коммитится
│   ├── scripts/                 # проверка синтаксиса, иконка, shared:check
│   ├── shared/                  # копия общего протокола
│   ├── release/                 # установщик Windows, не коммитится
│   ├── client-config.example.json
│   ├── package.json
│   └── package-lock.json
├── server/
│   ├── config/                  # radio-channels.json
│   ├── database/                # init и migrations
│   ├── docs/                    # архитектура, развёртывание, разработка
│   ├── scripts/                 # check-syntax, healthcheck, sync-shared
│   ├── shared/                  # канонический protocol.js
│   ├── src/                     # HTTP, WebSocket, auth, game, voice, radio
│   ├── test/                    # unit-тесты Node.js
│   ├── .dockerignore
│   ├── .env.example
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── docker-compose.dev.yml
│   ├── package.json
│   └── package-lock.json
├── .gitignore
├── AGENTS.md
├── README.md
└── opencode.json
```

`opencode.json`, `.env` и `todo.txt` — локальные файлы и в Git не коммитятся.

## 3. Требования

### Windows

- Node.js 24 LTS для сервера; для клиента достаточно Node.js 22.12+.
- npm 11.x.
- Git.
- PowerShell 5.1 или новее.
- PostgreSQL 17 — локально или в Docker Desktop с Linux-контейнерами.
- Микрофон и наушники для реальной проверки голоса.

Если PowerShell блокирует `npm.ps1`, используйте `npm.cmd`.

### Ubuntu Server 24.04

- Docker Engine и Docker Compose plugin.
- Минимум 1 vCPU и 2 GB RAM.
- Публичный IPv4 для `MEDIASOUP_ANNOUNCED_IP`.
- Открытый TCP-порт приложения и UDP-диапазон mediasoup.
- HTTPS reverse proxy для production-входа через Discord.

## 4. Быстрый старт сервера

```powershell
cd server
Copy-Item .env.example .env
notepad .env
npm install
npm run migrate
npm run dev
```

Замените в `server/.env` пароли-заглушки. Для первого запуска без интеграций можно оставить пустыми `DISCORD_*` (включая `DISCORD_ROLE_GUILD_IDS`), `BLOXLINK_API_KEY` и `PRC_SERVER_KEY`: сервер запустится, но вход, привязка Roblox, proximity и закрытые радиоканалы будут недоступны.

Проверка:

```powershell
curl.exe http://127.0.0.1:3000/health/live
curl.exe http://127.0.0.1:3000/health/ready
```

Подробнее: [server/docs/DEVELOPMENT.md](server/docs/DEVELOPMENT.md).

## 5. Быстрый старт клиента

```powershell
cd app
npm install
npm run check
npm start
```

В репозитории уже есть `app/client-config.json` с адресом развёрнутого сервера. Этот файл попадает в установщик, поэтому релизный клиент не использует `http://localhost:3000`:

```json
{
  "serverUrl": "https://201-8-80-121.sslip.io",
  "wsPath": "/ws"
}
```

Для другого сервера измените `serverUrl` в `app/client-config.json` и пересоберите клиент. Пользовательскую конфигурацию можно переопределить файлом `%APPDATA%\MoscowRoleplay Voice\client-config.json`.

Подробнее: [app/docs/DEVELOPMENT.md](app/docs/DEVELOPMENT.md).

## 6. Сборка Windows-установщика

```powershell
cd app
npm install
npm run dist
```

Результат:

```text
app\release\MoscowRoleplay-Voice-Setup-0.5.1.exe
```

Установщик NSIS не требует прав администратора, позволяет выбрать папку установки и создаёт ярлыки. Пользовательские настройки при удалении не стираются.

## 7. Docker-развёртывание

Все команды выполняются из папки `server`, где находятся `docker-compose.yml`, `Dockerfile` и `.env`:

```bash
cd server
cp .env.example .env
chmod 600 .env
docker compose build
docker compose up -d
docker compose exec server node src/database/migrate-cli.js
```

Проверка:

```bash
curl -fsS http://127.0.0.1:3000/health/live
curl -fsS http://127.0.0.1:3000/health/ready
docker compose logs -f server
```

Для production обязательны:

- `NODE_ENV=production`;
- `SESSION_COOKIE_SECURE=true` и HTTPS;
- `MEDIASOUP_ANNOUNCED_IP` с публичным IPv4;
- открытый UDP-диапазон `40000-40049`;
- PostgreSQL без публикации наружу.

Подробная инструкция: [server/docs/DEPLOYMENT.md](server/docs/DEPLOYMENT.md).

## 8. Проверки

Сервер:

```powershell
cd server
npm run verify
```

Команда проверяет синтаксис, синхронизацию shared и запускает unit-тесты.

Клиент:

```powershell
cd app
npm run check
npm run build
```

`check` проверяет синхронизацию протокола и синтаксис клиентских файлов. `build` собирает иконку и renderer.

## 9. Документация

- [server/docs/ARCHITECTURE.md](server/docs/ARCHITECTURE.md) — архитектура сервера, протокол, потоки данных.
- [server/docs/DEPLOYMENT.md](server/docs/DEPLOYMENT.md) — Ubuntu, Docker, HTTPS, firewall, backup.
- [server/docs/DEVELOPMENT.md](server/docs/DEVELOPMENT.md) — серверная разработка, тесты, миграции.
- [server/config/README.md](server/config/README.md) — формат радиоканалов и групп доступа на нескольких Discord-серверах.
- [app/docs/DEVELOPMENT.md](app/docs/DEVELOPMENT.md) — клиент, настройки, сборка `.exe`.
- [AGENTS.md](AGENTS.md) — обязательные правила для агентов и разработчиков.

## 10. Ограничения и что не проверено

- **Discord OAuth2, Bloxlink и PRC** не проверялись с реальными ключами: тестами покрыты разбор ответов, ошибки и конфигурация, но не сетевые сценарии.
- **Голосовая передача** не проверялась двумя клиентами с микрофонами. Нужны два ПК, публичный IP и открытый UDP-диапазон.
- **Docker** в среде разработки отсутствовал: образ не собирался, контейнеры не запускались. Конфигурация Compose и Dockerfile проверены статически.
- **Ubuntu Server 24.04**, UFW, POSIX-сигналы и реальная доставка UDP требуют проверки на VPS.
- **HTTPS reverse proxy** в комплект не входит.
- **`MEDIASOUP_WORKER_COUNT`** зарезервирован: текущая реализация создаёт один Worker.
- **OAuth state** хранится в памяти процесса, поэтому сервер рассчитан на один экземпляр.
- **Один голосовой узел.** Кластер и отдельные voice node не реализованы.
- **Bloxlink** может требовать платного тарифа. Без ключа привязка Roblox недоступна.
- Нет записи голоса, модерации, админ-панели, автообновления клиента и мобильной версии.

Проект не имитирует работу внешних сервисов: если ключ не задан, функция явно отключается и пишет предупреждение в лог.

## 11. Статус и лицензия

Проект приватный, лицензия не определена. Не распространяйте исходный код и конфигурацию без разрешения владельца MoscowRoleplay.
