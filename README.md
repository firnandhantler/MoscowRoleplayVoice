# MoscowRoleplay Voice

Голосовая система для Roblox ER:LC проекта MoscowRoleplay: голос по близости, радиоканалы, вход через Discord и привязка Roblox-аккаунта.

Текущий статус: **этап 5/5 — интеграция сервера и клиента завершена**. Реализованы серверный SFU на mediasoup, Proximity Engine, Radio Engine, Discord OAuth2, серверные сессии, Bloxlink, PRC API V2, Electron-клиент с интерфейсом и сборка Windows `.exe`.

> Важно: исходный код готов к запуску, но реальные интеграции требуют собственных ключей Discord, Bloxlink и PRC, публичного IP и HTTPS. Проверки с настоящими внешними сервисами и двумя микрофонами в этой среде не выполнялись — подробности в разделе 13.

## 1. Что умеет система

### Голос

- **Proximity Voice.** Сервер получает координаты игроков из PRC ER:LC API V2 и сам решает, кто кого слышит. Клиент не передаёт и не может подделать своё местоположение.
- **Радиоканалы.** Режим `both-dual`: радиосвязь работает независимо от голоса по близости. В канале одновременно передаёт только один участник.
- **Открытые и закрытые каналы.** Пустой `roleIds` — канал доступен любому авторизованному пользователю. Список Discord-ролей — канал только для сотрудников соответствующих структур.
- **Один захват микрофона.** Web Audio API делит сигнал на два независимых потока: proximity и radio. Отдельные PTT-клавиши, отдельная регулировка, опциональное приглушение окружения во время радиопередачи.
- **mediasoup SFU.** Один Worker и один Router на процесс, Opus 48 кГц, отправляющие и принимающие WebRTC-транспорты, дифференциальное создание Consumers.

### Авторизация и интеграции

- **Discord OAuth2** (Authorization Code + PKCE, scope `identify`). Токены Discord не сохраняются и отзываются сразу после получения профиля.
- **Серверные сессии.** Токен сессии передаётся клиенту в HttpOnly-cookie, в PostgreSQL хранится только его SHA-256-хеш.
- **Bloxlink.** Сервер получает Roblox ID по Discord ID. Клиент не может подставить чужой Roblox-аккаунт.
- **Roblox Users API.** По Roblox ID определяется актуальное имя игрока.
- **PRC API V2.** Один опросчик на сервер с интервалом 500 мс, соблюдением `Retry-After` и заголовков лимитов, экспоненциальным backoff и защитой ключа от блокировки.
- **Discord Bot API.** Проверка ролей для закрытых радиоканалов. OAuth2 `identify` роли не отдаёт, поэтому используется бот.

### Клиент

- Вход через Discord в отдельном окне.
- Статусы подключения, восстановление WebSocket-соединения с экспоненциальной задержкой.
- Выбор устройств ввода и вывода, громкость, усиление микрофона, эхоподавление, шумоподавление, автогромкость.
- Режимы микрофона: открытый и Push-to-Talk.
- Глобальная клавиша радио и удержание клавиши proximity.
- Индикатор уровня микрофона, список радиоканалов, отображение говорящего, количество слышимых игроков.
- Автоматическое восстановление голосового транспорта после сетевого сбоя (до 3 попыток за 60 секунд).
- Сборка установщика Windows через `electron-builder`.

### Безопасность

- Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: false`.
- Renderer не получает `require`, `ipcRenderer`, файловую систему и токен сессии.
- Preload экспортирует только whitelist IPC-действий; главный процесс проверяет источник каждого вызова.
- Внешние переходы, новые окна и лишние разрешения браузера запрещены. Микрофон разрешён только собственному renderer-файлу.
- CSP без внешних источников, `connect-src 'none'`: renderer общается с сервером только через главный процесс.
- Сервер валидирует все WebSocket-сообщения, ограничивает размер и частоту, проверяет права и занятость каналов.
- Секреты не попадают в логи; сообщения об ошибках конфигурации содержат только имена переменных.

## 2. Архитектура

```text
┌──────────────────────────── Electron-клиент ────────────────────────────┐
│ Главный процесс (CommonJS)          Renderer (ES Modules, без Node.js)  │
│  • окно и безопасность              • интерфейс и настройки             │
│  • Discord-вход, cookie сессии      • mediasoup-client                  │
│  • WebSocket и переподключение      • Web Audio: один захват, два потока│
│  • настройки, глобальные клавиши    • PTT, индикаторы, каналы           │
└───────────────┬─────────────────────────────────────────────────────────┘
                │ HTTPS (вход, сессия) + WSS (сигнализация)
                ▼
┌──────────────────────────── Node.js-сервер ─────────────────────────────┐
│ config → logger → database → migrations                                 │
│ http (health, /auth/*) → websocket → signaling                          │
│ auth: Discord OAuth2, сессии, Bloxlink, Roblox                          │
│ game: PRC poller → GameState                                            │
│ voice: mediasoup Worker/Router, транспорты, Producers/Consumers         │
│ proximity: spatial grid, squared distance, hysteresis, diff             │
│ radio: каналы, роли, занятость, один говорящий                          │
└───────────────┬───────────────────────────────┬─────────────────────────┘
                │                               │
                ▼                               ▼
        PostgreSQL                        PRC API V2
   пользователи, сессии,            координаты и состав
   служебные данные                 игрового сервера
```

Ключевые принципы:

- **Модульный монолит.** Один процесс, один Docker-образ, одна база. `server/src/index.js` только собирает компоненты.
- **Сервер — единственный источник правды.** Клиентские сообщения являются запросами, а не командами. Расстояние, роли, занятость канала и допустимость передачи проверяются на сервере.
- **Оперативные данные в памяти.** Координаты, граф близости и состояние передач не пишутся в PostgreSQL на каждом тике. В базе только пользователи, сессии и служебные таблицы.
- **Один голосовой узел.** Архитектура допускает будущее выделение voice node, но кластер сейчас не создаётся.

Подробнее: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 3. Структура проекта

```text
MoscowRoleplay Voice/
├── AGENTS.md
├── README.md
├── opencode.json
├── docker-compose.yml
├── docker-compose.dev.yml
├── .env.example
├── config/
│   └── radio-channels.json          # список радиоканалов
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DEPLOYMENT.md
│   └── DEVELOPMENT.md
├── server/
│   ├── Dockerfile
│   ├── package.json
│   ├── scripts/
│   │   ├── check-syntax.js
│   │   └── healthcheck.js
│   ├── src/
│   │   ├── index.js                 # сборка компонентов и запуск
│   │   ├── config/                  # загрузка и проверка .env
│   │   ├── http/                    # HTTP-сервер, /auth/*, ответы
│   │   ├── websocket/               # WebSocket-транспорт
│   │   ├── database/                # пул PostgreSQL и миграции
│   │   ├── auth/                    # OAuth2, сессии, репозиторий
│   │   ├── discord/                 # OAuth2-клиент и роли бота
│   │   ├── bloxlink/                # Discord → Roblox
│   │   ├── roblox/                  # Roblox Users API
│   │   ├── prc/                     # PRC ER:LC API V2
│   │   ├── game/                    # poller и GameState
│   │   ├── mediasoup/               # Worker и Router
│   │   ├── voice/                   # транспорты, Producers, Consumers
│   │   ├── proximity/               # граф слышимости
│   │   ├── radio/                   # каналы и передачи
│   │   ├── signaling/               # прикладной WebSocket-протокол
│   │   ├── monitoring/              # health-check
│   │   └── utils/                   # логи, cookies, crypto, shutdown
│   └── test/                        # unit-тесты Node.js
├── client/
│   ├── package.json
│   ├── client-config.example.json
│   ├── assets/                      # иконки приложения
│   ├── scripts/                     # проверка синтаксиса и иконка
│   ├── electron/
│   │   ├── main.js                  # окно, IPC, жизненный цикл
│   │   ├── preload.js               # whitelist API
│   │   ├── auth.js                  # Discord-вход и cookie
│   │   ├── config.js                # client-config.json
│   │   ├── http.js                  # HTTP-запросы главного процесса
│   │   ├── signaling.js             # WebSocket и переподключение
│   │   ├── settings.js              # settings.json
│   │   └── shortcuts.js             # глобальная клавиша радио
│   └── renderer/
│       ├── index.html
│       ├── styles.css
│       ├── dist/                    # собирается esbuild, не коммитится
│       └── src/
│           ├── main.js              # связывание интерфейса и голоса
│           ├── audio/               # захват, устройства, Web Audio
│           ├── mediasoup/           # mediasoup-client
│           ├── signaling/           # протокол и канал
│           ├── proximity/           # состояние близости
│           ├── radio/               # состояние радиоканалов
│           ├── settings/            # контроллер настроек
│           ├── core/                # store и клавиатура
│           └── ui/                  # DOM и уведомления
├── database/
│   ├── init/                        # создание роли приложения
│   └── migrations/
│       ├── 0001_bootstrap.sql
│       └── 0002_accounts_sessions.sql
└── shared/
    ├── package.json
    └── protocol.js                  # единый протокол клиента и сервера
```

## 4. Требования

### Windows 10 (разработка и клиент)

- Node.js 24 LTS (проверено на `24.13.1`).
- npm 11.x (проверено на `11.8.0`).
- Git (проверено на `2.47.0`).
- PowerShell 5.1 или новее.
- PostgreSQL 17 — локально или в Docker Desktop с Linux-контейнерами.
- Микрофон и наушники для реальной проверки голоса.

Если PowerShell блокирует `npm.ps1`, используйте `npm.cmd`. Это ограничение среды, а не проекта.

### Ubuntu Server 24.04 (сервер)

- Docker Engine и Docker Compose plugin.
- Минимум 1 vCPU и 2 GB RAM.
- Публичный IPv4 для `MEDIASOUP_ANNOUNCED_IP`.
- Открытые TCP-порт приложения и UDP-диапазон mediasoup.
- HTTPS reverse proxy (nginx, Caddy) для production-входа через Discord.

## 5. Быстрый старт на Windows

### 5.1. Создать `.env`

```powershell
Set-Location 'C:\Users\maksi\OneDrive\Рабочий стол\MoscowRoleplay Voice'
Copy-Item .env.example .env
notepad .env
```

Сгенерируйте два независимых пароля:

```powershell
function New-StrongPassword {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

"POSTGRES_SUPERUSER_PASSWORD: $(New-StrongPassword)"
"POSTGRES_PASSWORD: $(New-StrongPassword)"
```

Подставьте их в `.env`. Не используйте заглушки `change_me_*` в реальной работе. `POSTGRES_SUPERUSER_PASSWORD` нужен только контейнеру PostgreSQL при первом создании тома.

Для первого запуска без Discord и PRC можно оставить интеграционные переменные пустыми: сервер запустится, health-check будет работать, но вход, привязка Roblox, proximity и закрытые радиоканалы будут недоступны.

### 5.2. Подготовить PostgreSQL

**Вариант A. Docker Desktop:**

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
```

PostgreSQL будет доступен только на `127.0.0.1:5432`, роль приложения создаст init-скрипт.

**Вариант B. Локальный PostgreSQL 17:**

```sql
CREATE ROLE mrv_app LOGIN PASSWORD 'замените_на_сильный_пароль';
CREATE DATABASE moscowroleplay_voice OWNER mrv_app;
```

Укажите в `.env` фактические `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`.

### 5.3. Установить зависимости

```powershell
Set-Location .\server
npm.cmd install

Set-Location ..\client
npm.cmd install

Set-Location ..
```

### 5.4. Применить миграции

```powershell
Set-Location .\server
npm.cmd run migrate
```

При первом запуске применяются `0001_bootstrap.sql` и `0002_accounts_sessions.sql`. Повторный запуск безопасен: применённые миграции пропускаются, контрольные суммы проверяются.

### 5.5. Запустить сервер

```powershell
Set-Location .\server
npm.cmd run dev
```

Без режима наблюдения:

```powershell
npm.cmd start
```

Сервер запустится, даже если mediasoup не смог создать Worker: голос будет отключён, остальные функции продолжат работу. Причина будет в логах.

### 5.6. Проверить health-check

```powershell
curl.exe http://127.0.0.1:3000/health/live
curl.exe http://127.0.0.1:3000/health/ready
```

`/health/live` проверяет только процесс. `/health/ready` дополнительно проверяет PostgreSQL и возвращает `503` при недоступной базе. В readiness также выводятся информационные блоки `checks.game` (PRC) и `checks.voice` (mediasoup); они не влияют на готовность сервера.

### 5.7. Запустить клиент

```powershell
Set-Location .\client
npm.cmd start
```

Клиент соберёт renderer через esbuild и запустит Electron. По умолчанию он подключается к `http://localhost:3000`. Для другого сервера создайте `client/client-config.json`:

```json
{
  "serverUrl": "https://voice.example.com",
  "wsPath": "/ws"
}
```

Временно можно задать переменные окружения `MVR_SERVER_URL` и `MVR_WS_PATH`.

## 6. Настройка интеграций

### 6.1. Discord OAuth2

1. Создайте приложение в [Discord Developer Portal](https://discord.com/developers/applications).
2. В разделе **OAuth2** скопируйте **Client ID** и **Client Secret**.
3. Добавьте **Redirect URI**, например:
   - production: `https://voice.example.com/auth/discord/callback`;
   - локальная разработка: `http://localhost:3000/auth/discord/callback`.
4. Заполните в `.env`:

```dotenv
DISCORD_CLIENT_ID=123456789012345678
DISCORD_CLIENT_SECRET=...
DISCORD_REDIRECT_URI=https://voice.example.com/auth/discord/callback
DISCORD_GUILD_ID=123456789012345678
```

`DISCORD_REDIRECT_URI` должен совпадать с Developer Portal посимвольно. В production конфигурация требует `https`. Если задана только часть из трёх переменных `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, сервер не запустится.

Приложение запрашивает только scope `identify`: доступ к серверам, сообщениям и другим данным не нужен.

### 6.2. Discord-бот для закрытых радиоканалов

OAuth2 `identify` не возвращает роли. Для проверки доступа к каналам с непустым `roleIds` нужен бот:

1. В приложении создайте **Bot** и скопируйте токен в `DISCORD_BOT_TOKEN`.
2. Включите **Server Members Intent** в настройках бота: REST-метод получения участника требует этого намерения.
3. Пригласите бота на сервер `DISCORD_GUILD_ID` с правом просматривать участников.
4. Убедитесь, что ID ролей в `config/radio-channels.json` совпадают с ролями Discord.

Без бота открытые каналы (`roleIds: []`) продолжают работать, закрытые становятся недоступны. Это отражается предупреждением в логах при старте.

### 6.3. Bloxlink

Сервер использует Bloxlink Server API:

```dotenv
BLOXLINK_API_KEY=...
DISCORD_GUILD_ID=123456789012345678
```

Требования:

- бот Bloxlink установлен на Discord-сервере проекта;
- пользователь состоит на этом сервере и привязал Roblox в Bloxlink;
- ключ API выдан в панели Bloxlink.

Bloxlink возвращает только Roblox ID. Имя пользователя сервер уточняет через публичный Roblox Users API. Ключ Bloxlink может требовать платного тарифа Bloxlink — проверьте условия у поставщика. Без ключа вход через Discord работает, но `robloxId` остаётся пустым, поэтому Proximity Voice для пользователя недоступен. Повторная проверка привязки доступна кнопкой «Проверить привязку Roblox» в клиенте.

### 6.4. PRC ER:LC API V2

1. Получите ключ игрового сервера в панели PRC.
2. Укажите в `.env`:

```dotenv
PRC_SERVER_KEY=...
GAME_POLL_ENABLED=true
GAME_POLL_INTERVAL_MS=500
```

Сервер опрашивает `GET /v2/server?Players=true` и получает состав игроков с координатами X/Z. Координаты и граф близости хранятся только в памяти процесса.

Особенности опросчика:

- одновременно выполняется не более одного запроса;
- пропущенные циклы не накапливаются;
- `Retry-After` и заголовки лимитов соблюдаются;
- при ошибках применяется экспоненциальный backoff;
- при повторном отказе в ключе опрос останавливается, чтобы не заблокировать ключ;
- ошибка PRC не превращается в пустой снимок: устаревшие данные помечаются, связи разрываются.

Если `PRC_SERVER_KEY` пуст или `GAME_POLL_ENABLED=false`, proximity не работает. Это явно видно в логах и в `checks.game` health-check.

### 6.5. Радиоканалы

Файл по умолчанию: `config/radio-channels.json`.

```json
{
  "channels": [
    {
      "id": "police",
      "name": "Полиция",
      "description": "Канал сотрудников полиции",
      "roleIds": ["123456789012345678"],
      "priority": 1
    },
    {
      "id": "dispatch",
      "name": "Диспетчерская",
      "description": "Общий канал",
      "roleIds": [],
      "priority": 2
    }
  ]
}
```

Правила:

- `id` — `[a-z0-9_-]`, до 64 символов, уникален;
- `name` — до 64 символов;
- `description` — до 200 символов;
- `roleIds` — до 50 Discord ID; пустой массив означает открытый канал;
- `priority` — целое число, меньшие значения выше в списке.

Пример в репозитории содержит четыре открытых канала. Для реального проекта замените `roleIds` на ID ролей государственных структур. Файл можно переопределить через `RADIO_CHANNELS_FILE`; в Docker этот путь должен существовать внутри контейнера.

## 7. Клиент: конфигурация и сборка

### 7.1. Где клиент ищет сервер

Порядок приоритета:

1. переменные окружения `MVR_SERVER_URL` и `MVR_WS_PATH`;
2. `client-config.json` в папке пользовательских данных: `%APPDATA%\MoscowRoleplay Voice\client-config.json`;
3. `client-config.json` в папке ресурсов приложения: `...\resources\client-config.json`;
4. `client-config.json` рядом с приложением в режиме разработки;
5. значение по умолчанию `http://localhost:3000`.

Пример: `client/client-config.example.json`. В файле нет секретов — только адрес сервера. Токен сессии хранится в изолированной сессии Electron и недоступен renderer.

### 7.2. Сборка установщика

```powershell
Set-Location .\client
npm.cmd run dist
```

Результат: `client\release\MoscowRoleplay-Voice-Setup-0.5.0.exe`.

Другие команды:

```powershell
npm.cmd run build      # только renderer и иконка
npm.cmd run check      # проверка синтаксиса 23 файлов
npm.cmd run pack       # распакованная сборка без установщика
```

Установщик NSIS:

- не требует прав администратора;
- позволяет выбрать папку установки;
- создаёт ярлыки на рабочем столе и в меню «Пуск»;
- не удаляет пользовательские настройки при удалении приложения.

### 7.3. Настройки клиента

Хранятся в `%APPDATA%\MoscowRoleplay Voice\settings.json`:

- устройства ввода и вывода;
- усиление микрофона (0–200%) и громкость входящего голоса (0–100%);
- эхоподавление, шумоподавление, автогромкость;
- режим микрофона: открытый или Push-to-Talk;
- клавиша радио (по умолчанию `R`) и глобальный режим;
- клавиша proximity (по умолчанию `V`);
- приглушение окружения при радиопередаче;
- автоподключение при запуске.

Глобальная клавиша радио работает как переключатель, когда окно неактивно. Удержание клавиши proximity работает, когда окно клиента активно. Если глобальная клавиша занята другим приложением, клиент покажет предупреждение.

## 8. Docker и Ubuntu Server 24.04

### 8.1. Подготовка `.env`

```bash
cp .env.example .env
chmod 600 .env
```

Для production обязательно:

```dotenv
NODE_ENV=production
POSTGRES_SUPERUSER_PASSWORD=...
POSTGRES_PASSWORD=...
MEDIASOUP_ANNOUNCED_IP=203.0.113.10
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_REDIRECT_URI=https://voice.example.com/auth/discord/callback
DISCORD_GUILD_ID=...
DISCORD_BOT_TOKEN=...
BLOXLINK_API_KEY=...
PRC_SERVER_KEY=...
```

`MEDIASOUP_ANNOUNCED_IP` — публичный IPv4 VPS, который видят клиенты. Не указывайте `127.0.0.1` или внутренний адрес контейнера. Если оставить значение пустым, клиенты за пределами Docker-хоста не смогут подключиться к голосу.

`SESSION_COOKIE_SECURE` в Docker Compose по умолчанию `true`, а конфигурация запрещает `false` в production. Поэтому вход через Discord в Docker требует HTTPS. Без HTTPS можно запустить сервер без авторизации (пустые `DISCORD_*`) и проверить health-check, но не голосовой вход.

### 8.2. Запуск

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose exec server node server/src/database/migrate-cli.js
```

Проверка:

```bash
curl -fsS http://127.0.0.1:3000/health/live
curl -fsS http://127.0.0.1:3000/health/ready
docker compose logs -f server
```

### 8.3. Порты

| Порт | Протокол | Назначение | Публичный доступ |
|---|---|---|---|
| `3000` | TCP | HTTP и WebSocket | Да, лучше через TLS-прокси |
| `40000-40049` | UDP | mediasoup RTC | Да, для голосовых клиентов |
| `5432` | TCP | PostgreSQL | Нет |
| `22` | TCP | SSH | Да, ограничить по IP |
| `80`, `443` | TCP | Reverse proxy и TLS | Да, при использовании HTTPS |

Пример UFW:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 40000:40049/udp
sudo ufw enable
```

Docker может обходить правила UFW через iptables. Дополнительно настройте firewall/security group у провайдера. Не публикуйте PostgreSQL наружу.

### 8.4. Reverse proxy

Для HTTPS поставьте nginx или Caddy перед контейнером:

- проксируйте `https://voice.example.com` на `127.0.0.1:3000`;
- включите поддержку WebSocket (`Upgrade` и `Connection`);
- установите `TRUST_PROXY=true`, чтобы ограничение частоты и проверка Origin учитывали `X-Forwarded-For`/`X-Forwarded-Host`;
- не публикуйте `3000/tcp` всему интернету, если используете прокси.

UDP-диапазон mediasoup проксировать нельзя: клиенты подключаются к нему напрямую.

Подробная инструкция: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## 9. Переменные окружения

Полный список с комментариями — в `.env.example`. Основные группы:

| Группа | Переменные |
|---|---|
| Общие | `NODE_ENV`, `LOG_LEVEL`, `LOG_PRETTY`, `SHUTDOWN_TIMEOUT_MS` |
| HTTP/WebSocket | `SERVER_HOST`, `SERVER_PORT`, `WS_PATH`, `WS_MAX_PAYLOAD_BYTES`, `WS_HEARTBEAT_INTERVAL_MS`, `WS_MAX_CONNECTIONS`, `WS_RATE_LIMIT_*`, `WS_MAX_VIOLATIONS`, `TRUST_PROXY` |
| PostgreSQL | `POSTGRES_*`, `HEALTH_DB_TIMEOUT_MS` |
| Discord | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, `DISCORD_GUILD_ID`, `DISCORD_TIMEOUT_MS`, `DISCORD_BOT_TOKEN`, `DISCORD_ROLES_CACHE_TTL_MS` |
| Сессии | `SESSION_IDLE_TTL_SECONDS`, `SESSION_ABSOLUTE_TTL_SECONDS`, `SESSION_COOKIE_SECURE`, `SESSION_TOUCH_INTERVAL_SECONDS`, `SESSION_CLEANUP_INTERVAL_MS` |
| Авторизация | `AUTH_RATE_LIMIT_MAX_REQUESTS`, `AUTH_RATE_LIMIT_WINDOW_MS`, `AUTH_STATE_TTL_SECONDS`, `AUTH_POST_LOGIN_REDIRECT_URL` |
| Bloxlink | `BLOXLINK_API_KEY`, `BLOXLINK_API_BASE_URL`, `BLOXLINK_TIMEOUT_MS` |
| Roblox | `ROBLOX_USERS_API_BASE_URL`, `ROBLOX_TIMEOUT_MS` |
| PRC и игра | `PRC_SERVER_KEY`, `PRC_API_BASE_URL`, `PRC_TIMEOUT_MS`, `GAME_POLL_ENABLED`, `GAME_POLL_INTERVAL_MS`, `GAME_POLL_MAX_BACKOFF_MS`, `GAME_STATE_STALE_AFTER_MS` |
| Голос | `VOICE_ENABLED`, `MEDIASOUP_LISTEN_IP`, `MEDIASOUP_ANNOUNCED_IP`, `MEDIASOUP_RTC_MIN_PORT`, `MEDIASOUP_RTC_MAX_PORT`, `MEDIASOUP_WORKER_COUNT` |
| Proximity | `PROXIMITY_MAX_DISTANCE`, `PROXIMITY_HYSTERESIS`, `PROXIMITY_UPDATE_INTERVAL_MS`, `PROXIMITY_MAX_NEIGHBORS` |
| Радио | `RADIO_ENABLED`, `RADIO_CHANNELS_FILE`, `RADIO_MAX_TRANSMISSION_MS` |

В production приложение не запустится, если:

- `POSTGRES_PASSWORD` содержит заглушку или совпадает с `POSTGRES_USER`/`POSTGRES_DB`;
- `SESSION_COOKIE_SECURE=false`;
- `DISCORD_REDIRECT_URI` использует HTTP не для loopback-адреса;
- `DISCORD_*` заданы частично;
- `BLOXLINK_API_KEY` задан без `DISCORD_GUILD_ID`;
- `PROXIMITY_HYSTERESIS >= PROXIMITY_MAX_DISTANCE`;
- `GAME_STATE_STALE_AFTER_MS <= GAME_POLL_INTERVAL_MS`.

## 10. Как работает голос

### 10.1. Proximity

1. Пользователь входит через Discord. Сервер получает `robloxId` из Bloxlink.
2. PRC poller обновляет `GameState` каждые 500 мс.
3. После авторизации WebSocket клиент получает `server.authenticated` с игровым состоянием.
4. Если игрок находится на сервере ER:LC, клиент создаёт proximity Producer из захваченного микрофона.
5. Proximity Engine раз в 500 мс строит граф слышимости: spatial grid 3×3, сравнение по квадрату расстояния, гистерезис.
6. Для новых рёбер сервер создаёт входящие Consumers и отправляет `server.voice.consumerCreated`.
7. Клиент потребляет поток и выводит его на выбранное устройство.
8. При выходе из игры, устаревании снимка PRC или отключении клиента связи и Consumers закрываются.

Клиент не отправляет координаты. Он получает только публичные игровые данные (имя, фракция, позывной, почтовый индекс, улица, розыск) и количество слышимых игроков.

### 10.2. Радио

1. Клиент отправляет `client.radio.join` с `channelId`.
2. Сервер проверяет канал и роли через Discord Bot API (для закрытых каналов).
3. Если в канале уже кто-то говорит, новый участник слышит его; одновременно передавать может только один.
4. `client.radio.startTransmission` проверяет доступ и занятость, после чего создаёт radio Producer и Consumers для всех участников канала.
5. По `client.radio.stopTransmission`, истечении `RADIO_MAX_TRANSMISSION_MS` или отключении передача завершается, Consumers закрываются.
6. Выход из канала закрывает входящие radio-Consumers и освобождает место говорящего.

Режим `both-dual` означает, что proximity и radio — независимые Producers. Радиопередача не отключает голос по близости; приглушение окружения — необязательная настройка клиента.

### 10.3. Восстановление соединения

- Главный процесс переподключает WebSocket с экспоненциальной задержкой.
- При ошибке голосового транспорта renderer пересоздаёт транспорты и Producers (до 3 попыток за 60 секунд).
- После пересоздания транспорта сервер сбрасывает прежние Consumers и пересчитывает близость и радиостояние.
- При выходе из аккаунта PTT, захват микрофона и голосовые ресурсы освобождаются.

## 11. Проверки

Сервер:

```powershell
Set-Location .\server
npm.cmd run verify
```

Команда проверяет синтаксис всех файлов и запускает unit-тесты (58 тестов). Покрыты конфигурация, протокол, HTTP/health, shutdown, proximity и radio.

Клиент:

```powershell
Set-Location .\client
npm.cmd run check
npm.cmd run build
```

`check` проверяет синтаксис 23 файлов, `build` собирает renderer и иконку.

Сборка установщика:

```powershell
npm.cmd run dist
```

## 12. Диагностика

| Симптом | Вероятная причина | Что проверить |
|---|---|---|
| `ECONNREFUSED 127.0.0.1:5432` | PostgreSQL не запущен | `docker compose ps`, служба PostgreSQL, порт |
| `password authentication failed` | Неверный пароль или старый volume | `POSTGRES_PASSWORD`, пересоздание роли |
| `EADDRINUSE` | Порт занят | `SERVER_PORT`, `Get-NetTCPConnection` |
| health возвращает `503` | База недоступна | `/health/live`, логи `module=database` |
| Вход открывает страницу, но клиент не входит | Неверный redirect URI, HTTP вместо HTTPS или `SESSION_COOKIE_SECURE` | Developer Portal, `.env`, reverse proxy |
| `auth_disabled` | Не заданы `DISCORD_*` | Все три переменные OAuth2 |
| `bloxlink_disabled` | Нет `BLOXLINK_API_KEY` | Ключ и `DISCORD_GUILD_ID` |
| `not_linked` | Пользователь не привязал Roblox | Bloxlink на Discord-сервере |
| Proximity не работает | Нет `PRC_SERVER_KEY`, игрок не на сервере или Bloxlink не привязан | `checks.game`, логи poller, статус в клиенте |
| Закрытый радиоканал недоступен | Нет бота, прав или роли | `DISCORD_BOT_TOKEN`, Server Members Intent, `roleIds` |
| Голос не подключается | `MEDIASOUP_ANNOUNCED_IP` пуст или UDP закрыт | `.env`, firewall, `docker compose ps` |
| `voice_unavailable` | mediasoup Worker не запустился | Логи `module=mediasoup`, платформа, права |
| `npm.ps1 cannot be loaded` | Политика PowerShell | `npm.cmd` |
| Ошибка сборки mediasoup | Нет prebuilt-бинарника | Linux-контейнер или поддерживаемая платформа |

Кодировка консоли Windows:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

## 13. Ограничения и что не проверено

Реализация завершена, но следующие проверки невозможно выполнить без реальных внешних ресурсов:

- **Discord OAuth2, Bloxlink и PRC** не проверялись с настоящими ключами. Тестами покрыты разбор ответов, ошибки и конфигурация, но не реальные сетевые сценарии.
- **Голосовая передача** не проверялась двумя клиентами с микрофонами. Требуются два ПК, публичный IP и открытый UDP-диапазон.
- **Docker** в среде разработки отсутствовал: образ не собирался, контейнеры не запускались. Конфигурация Compose и Dockerfile проверены статически; исправлена передача переменных и копирование `config/`.
- **Ubuntu Server 24.04** не использовался: доставка POSIX-сигналов, работа UFW и UDP-диапазона требуют проверки на VPS.
- **HTTPS reverse proxy** не входит в комплект. Для production его нужно настроить отдельно.
- **`MEDIASOUP_WORKER_COUNT`** зарезервирован: текущая реализация создаёт один Worker на процесс.
- **OAuth state** хранится в памяти процесса, поэтому сервер рассчитан на один экземпляр. Горизонтальное масштабирование потребует общего хранилища.
- **Один голосовой узел.** Кластер, несколько Router и отдельные voice node не реализованы.
- **Bloxlink** может требовать платного тарифа. Бесплатной альтернативы в проекте нет; без ключа привязка Roblox недоступна.
- **Нет** записи голоса, модерации, админ-панели, автоматического обновления клиента и мобильной версии.

Проект не имитирует работу внешних сервисов: если ключ не задан, функция явно отключается и пишет предупреждение в лог.

## 14. Документация

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — модули, протокол, потоки данных, безопасность.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Ubuntu, Docker, HTTPS, firewall, backup.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — Windows, команды, тесты, Git, OpenCode/Kilo.
- [AGENTS.md](AGENTS.md) — обязательные правила для агентов и разработчиков.

## 15. Статус и лицензия

Проект приватный, лицензия не определена. Не распространяйте исходный код и конфигурацию без разрешения владельца MoscowRoleplay.
