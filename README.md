# MoscowRoleplay Voice

Специализированная голосовая система для Roblox ER:LC проекта MoscowRoleplay.

Текущий статус: **этап 1 — фундамент**. Реализованы запускаемый сервер, HTTP/WebSocket-слой, подключение к PostgreSQL, механизм миграций, health-check, безопасный каркас Electron-клиента и конфигурация Docker Compose. Голосовая передача, авторизация и игровые интеграции намеренно ещё не реализованы.

## 1. Назначение проекта

В целевой версии MoscowRoleplay Voice должен обеспечивать:

- голосовое общение по близости (Proximity Voice);
- радиоканалы, включая отдельные каналы государственных структур;
- авторизацию через Discord;
- связывание Discord-аккаунта с Roblox-аккаунтом;
- проверку нахождения игрока на сервере ER:LC через PRC API V2;
- Windows-клиент с графическим интерфейсом;
- серверную проверку прав и обработку голосовых соединений.

Проект рассчитан на небольшой VPS: 1 vCPU, 2 GB RAM, Ubuntu Server 24.04 LTS, Docker. Поэтому на первом этапе используется **модульный монолит**, а не микросервисы и не кластер.

## 2. Что уже реализовано

- Node.js-сервер на ES Modules.
- Загрузка `.env` и строгая проверка переменных без вывода секретов.
- В production отклоняются пароли-заглушки и совпадение `POSTGRES_PASSWORD` с `POSTGRES_USER` или `POSTGRES_DB`.
- Структурированные JSON-логи через `pino` с маскированием чувствительных полей.
- Подключение к PostgreSQL через пул `pg`.
- Механизм SQL-миграций с контрольными суммами и блокировкой от одновременного применения.
- HTTP-сервер с `GET /health`, `GET /health/live` (liveness) и `GET /health/ready` (readiness).
- WebSocket-сервер на `ws` с:
  - ограничением размера сообщений;
  - валидацией JSON и полей протокола;
  - ограничением частоты сообщений;
  - heartbeat и безопасной обработкой отключений;
  - базовыми сообщениями `server.hello`, `client.ping`, `server.pong`, `server.error`.
- Общий протокол клиента и сервера в `shared/protocol.js`.
- Корректное завершение работы через обработчики `SIGINT`/`SIGTERM` и общий менеджер остановки.
- Dockerfile сервера и Docker Compose с PostgreSQL, healthcheck, постоянным volume и ограничением логов.
- Безопасный каркас Electron-клиента:
  - `contextIsolation: true`;
  - `nodeIntegration: false`;
  - `sandbox: true`;
  - минимальный `preload.js`;
  - запрет внешних переходов, новых окон и разрешений браузера;
  - CSP без внешних источников.
- Документация на русском языке и правила для OpenCode/Kilo CLI в `AGENTS.md`.

## 3. Что намеренно не реализовано

На этом этапе запрещено и не реализовано:

- Discord OAuth2;
- Bloxlink API;
- PRC API V2;
- Proximity Engine;
- Radio Engine;
- PTT;
- mediasoup signaling;
- полноценный интерфейс Electron;
- передача голоса.

Модули `auth`, `game`, `voice`, `proximity`, `radio` содержат только документацию о будущем назначении. Фиктивных реализаций нет.

## 4. Архитектурная концепция

Сервер — модульный монолит. Компоненты разделены по ответственности и общаются через явные интерфейсы:

```text
Electron-клиент
      │
      │ HTTP / WebSocket
      ▼
┌─────────────────────────────────────────────┐
│              Node.js-сервер                 │
│                                             │
│  config ── logger ── monitoring             │
│     │                                       │
│  http-сервер ── websocket-шлюз              │
│     │                │                      │
│     │                └── shared/protocol.js │
│     │                                       │
│  database ── migrations                     │
│                                             │
│  auth / game / voice / proximity / radio    │
│  (зарезервированные границы)                │
└─────────────────────────────────────────────┘
      │
      ▼
PostgreSQL (только долговременные данные)
```

Позже голосовой модуль сможет быть выделен в отдельный узел mediasoup без переписывания всего сервера. Сейчас кластер не создаётся.

Подробнее: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 5. Структура проекта

```text
MoscowRoleplay Voice/
├── AGENTS.md
├── README.md
├── opencode.json
├── docker-compose.yml
├── docker-compose.dev.yml
├── .env.example
├── .gitignore
├── .dockerignore
├── .gitattributes
├── .editorconfig
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DEPLOYMENT.md
│   └── DEVELOPMENT.md
├── server/
│   ├── Dockerfile
│   ├── package.json
│   ├── package-lock.json
│   ├── scripts/
│   │   ├── check-syntax.js
│   │   └── healthcheck.js
│   ├── src/
│   │   ├── index.js
│   │   ├── config/index.js
│   │   ├── http/server.js
│   │   ├── websocket/server.js
│   │   ├── database/
│   │   │   ├── pool.js
│   │   │   ├── migrations.js
│   │   │   └── migrate-cli.js
│   │   ├── monitoring/health.js
│   │   ├── utils/
│   │   │   ├── logger.js
│   │   │   ├── errors.js
│   │   │   └── shutdown.js
│   │   ├── auth/README.md
│   │   ├── game/README.md
│   │   ├── voice/README.md
│   │   ├── proximity/README.md
│   │   └── radio/README.md
│   └── test/
│       ├── config.test.js
│       ├── protocol.test.js
│       ├── health.test.js
│       ├── http.test.js
│       └── shutdown.test.js
├── client/
│   ├── package.json
│   ├── package-lock.json
│   ├── electron/
│   │   ├── main.js
│   │   └── preload.js
│   ├── renderer/
│   │   ├── index.html
│   │   ├── styles.css
│   │   └── renderer.js
│   └── assets/README.md
├── database/
│   ├── init/
│   │   ├── 01-create-app-role.sh
│   │   └── README.md
│   └── migrations/
│       ├── 0001_bootstrap.sql
│       └── README.md
└── shared/
    ├── package.json
    └── protocol.js
```

## 6. Требования

### Windows 10 (среда разработки)

- Node.js 24 LTS. Проверено на Node.js `24.13.1`.
- npm 11.x. Проверено на npm `11.8.0`.
- Git. Проверено на Git `2.47.0`.
- PowerShell 5.1 или новее.
- Docker Desktop с Linux-контейнерами — **по желанию**, если планируется запускать PostgreSQL или весь сервер в контейнерах.
- PostgreSQL 17 — если Docker недоступен, но нужна реальная база для локальной проверки.

Важно: если PowerShell блокирует `npm.ps1` из-за политики выполнения, используйте `npm.cmd` вместо `npm`. Это не ошибка проекта.

### Ubuntu Server 24.04 (сервер)

- Docker Engine и Docker Compose plugin.
- 1 vCPU, 2 GB RAM (минимум для первого этапа).
- Открытые TCP/UDP-порты согласно разделу 12.
- Публичный IP для будущего `MEDIASOUP_ANNOUNCED_IP`.

## 7. Быстрый старт на Windows

### 7.1. Перейти в папку проекта

```powershell
Set-Location 'C:\Users\maksi\OneDrive\Рабочий стол\MoscowRoleplay Voice'
```

### 7.2. Создать `.env`

```powershell
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

Подставьте первый пароль в `POSTGRES_SUPERUSER_PASSWORD`, второй — в `POSTGRES_PASSWORD`. Не используйте значения `change_me_*` в реальной работе.

`POSTGRES_SUPERUSER_PASSWORD` нужен только контейнеру PostgreSQL при первом создании тома. Приложение подключается отдельной ролью `POSTGRES_USER` (по умолчанию `mrv_app`).

### 7.3. Подготовить PostgreSQL

**Вариант A. Docker Desktop (рекомендуется, если установлен):**

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
```

Этот вариант публикует PostgreSQL только на `127.0.0.1:5432` и создаёт роль приложения через init-скрипт.

**Вариант B. Локальный PostgreSQL 17:**

1. Установите PostgreSQL 17 для Windows.
2. Создайте роль и базу под суперпользователем `postgres`:

```sql
CREATE ROLE mrv_app LOGIN PASSWORD 'замените_на_сильный_пароль';
CREATE DATABASE moscowroleplay_voice OWNER mrv_app;
```

3. Убедитесь, что в `.env` указаны:

```dotenv
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_DB=moscowroleplay_voice
POSTGRES_USER=mrv_app
POSTGRES_PASSWORD=ваш_пароль_приложения
```

Если база создана с владельцем `mrv_app`, отдельные `GRANT` для схемы `public` не нужны.

### 7.4. Установить зависимости

```powershell
Set-Location .\server
npm.cmd install

Set-Location ..\client
npm.cmd install

Set-Location ..
```

### 7.5. Применить миграции

```powershell
Set-Location .\server
npm.cmd run migrate
```

Повторный запуск безопасен: уже применённые миграции пропускаются, их контрольные суммы проверяются.

### 7.6. Запустить сервер

```powershell
Set-Location .\server
npm.cmd run dev
```

Для запуска без режима наблюдения:

```powershell
npm.cmd start
```

Ожидаемые сообщения в логах:

- подключение к PostgreSQL проверено;
- HTTP- и WebSocket-серверы запущены;
- сервер слушает `127.0.0.1:3000` (или адрес из `.env`).

### 7.7. Проверить health-check

Readiness проверяет и HTTP-сервер, и доступность PostgreSQL:

```powershell
curl.exe http://127.0.0.1:3000/health/ready
```

Ожидается HTTP `200` и JSON:

```json
{
  "status": "ok",
  "service": "moscowroleplay-voice-server",
  "version": "0.1.0",
  "environment": "development",
  "checks": {
    "database": {
      "status": "ok",
      "latencyMs": 1
    }
  }
}
```

Liveness проверяет только процесс HTTP-сервера и не обращается к базе:

```powershell
curl.exe http://127.0.0.1:3000/health/live
```

Маршрут `GET /health` сохранён для совместимости с Docker healthcheck и работает как readiness-проверка. Если база недоступна, `/health` и `/health/ready` возвращают HTTP `503` и `status: "degraded"`, а `/health/live` продолжает возвращать HTTP `200`, пока процесс сервера жив.

### 7.8. Проверить WebSocket

Из папки `server`:

```powershell
node --input-type=module -e "import WebSocket from 'ws'; const ws = new WebSocket('ws://127.0.0.1:3000/ws'); ws.on('message', (data) => { console.log(data.toString()); ws.close(); });"
```

Сервер должен отправить `server.hello`. Для проверки ping/pong отправьте сообщение:

```json
{"v":1,"type":"client.ping","id":"test_1","data":{"nonce":"hello"}}
```

Ответ будет иметь тип `server.pong` и тот же `id`.

### 7.9. Запустить Electron-клиент

```powershell
Set-Location .\client
npm.cmd start
```

Клиент пока не подключается к серверу и не запрашивает микрофон. Это безопасный каркас для следующего этапа.

## 8. Запуск через Docker Compose

Docker должен быть установлен и запущен. В текущей среде разработки Docker отсутствовал, поэтому полный запуск Compose не выполнялся — проверена только статическая корректность конфигурации.

### 8.1. Подготовить `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

Обязательно замените оба пароля. Для локального запуска `MEDIASOUP_ANNOUNCED_IP` можно оставить пустым, пока голосовой модуль не реализован. На VPS укажите публичный IP сервера.

### 8.2. Собрать и запустить

```powershell
docker compose build
docker compose up -d
docker compose ps
```

### 8.3. Применить миграции

```powershell
docker compose exec server node server/src/database/migrate-cli.js
```

### 8.4. Проверить приложение

```powershell
curl.exe http://127.0.0.1:3000/health/live
curl.exe http://127.0.0.1:3000/health/ready
curl.exe http://127.0.0.1:3000/health
docker compose exec server node server/scripts/healthcheck.js
```

Docker healthcheck использует `/health` и тем самым проверяет readiness, включая PostgreSQL.

### 8.5. Смотреть логи

```powershell
docker compose logs -f server
docker compose logs -f postgres
```

### 8.6. Остановить и запустить снова

```powershell
docker compose stop
docker compose start
```

Полная остановка с сохранением данных:

```powershell
docker compose down
```

**Не используйте `docker compose down -v`, если не хотите удалить базу.** Флаг `-v` удаляет volume `moscowroleplay_voice_postgres_data`.

### 8.7. Локальная разработка только с PostgreSQL в Docker

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
```

Сервер при этом запускается на хосте через `npm.cmd run dev` и подключается к `127.0.0.1:5432`.

## 9. Подключение к PostgreSQL

Приложение использует отдельные параметры подключения:

- `POSTGRES_HOST`;
- `POSTGRES_PORT`;
- `POSTGRES_DB`;
- `POSTGRES_USER`;
- `POSTGRES_PASSWORD`;
- `POSTGRES_SSL`;
- `POSTGRES_SSL_REJECT_UNAUTHORIZED`;
- `POSTGRES_POOL_MAX`;
- `POSTGRES_CONNECTION_TIMEOUT_MS`;
- `POSTGRES_IDLE_TIMEOUT_MS`;
- `POSTGRES_QUERY_TIMEOUT_MS`.

Пароль не выводится в логи и не передаётся в аргументах командной строки init-скрипта: он читается через переменные окружения и `\getenv` в `psql`.

В Docker Compose PostgreSQL не публикуется наружу. Для локальной разработки используется `docker-compose.dev.yml`, который открывает порт только на `127.0.0.1`.

Проверить подключение вручную:

```powershell
psql -h 127.0.0.1 -p 5432 -U mrv_app -d moscowroleplay_voice -c "SELECT current_user;"
```

Пароль введите по запросу. Не добавляйте его в историю команд.

## 10. Переменные окружения

Полный список с безопасными примерами находится в `.env.example`.

### Общие

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `NODE_ENV` | `development`, `test` или `production` | `development` |
| `LOG_LEVEL` | Уровень логов `pino` | `info` |
| `LOG_PRETTY` | Человекочитаемые логи для разработки | `true` вне production |
| `SHUTDOWN_TIMEOUT_MS` | Таймаут корректного завершения | `10000` |

### HTTP и WebSocket

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `SERVER_HOST` | Адрес прослушивания | `127.0.0.1` в примере, `0.0.0.0` в Docker |
| `SERVER_PORT` | TCP-порт HTTP/WebSocket | `3000` |
| `WS_PATH` | Путь WebSocket | `/ws` |
| `WS_MAX_PAYLOAD_BYTES` | Максимальный размер сообщения | `16384` |
| `WS_HEARTBEAT_INTERVAL_MS` | Интервал heartbeat | `30000` |
| `WS_MAX_CONNECTIONS` | Лимит соединений | `200` |
| `WS_RATE_LIMIT_MAX_MESSAGES` | Лимит сообщений в окне | `30` |
| `WS_RATE_LIMIT_WINDOW_MS` | Окно ограничения | `10000` |
| `WS_MAX_VIOLATIONS` | Нарушений до закрытия | `5` |

### PostgreSQL

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `POSTGRES_SUPERUSER` | Суперпользователь контейнера PostgreSQL | `postgres` |
| `POSTGRES_SUPERUSER_PASSWORD` | Пароль суперпользователя (только init контейнера) | нет, обязателен для Compose |
| `POSTGRES_HOST` | Хост базы | `127.0.0.1` |
| `POSTGRES_PORT` | Порт базы | `5432` |
| `POSTGRES_DB` | Имя базы | `moscowroleplay_voice` |
| `POSTGRES_USER` | Роль приложения | `mrv_app` |
| `POSTGRES_PASSWORD` | Пароль роли приложения | нет, обязателен |
| `POSTGRES_SSL` | Использовать SSL | `false` |
| `POSTGRES_SSL_REJECT_UNAUTHORIZED` | Проверять сертификат | `true` |
| `POSTGRES_POOL_MAX` | Максимум соединений в пуле | `10` |
| `POSTGRES_CONNECTION_TIMEOUT_MS` | Таймаут подключения | `5000` |
| `POSTGRES_IDLE_TIMEOUT_MS` | Таймаут простоя | `30000` |
| `POSTGRES_QUERY_TIMEOUT_MS` | Таймаут запроса | `5000` |
| `HEALTH_DB_TIMEOUT_MS` | Таймаут проверки БД в health | `3000` |

В `production` приложение не запустится, если `POSTGRES_PASSWORD` содержит заглушку вида `change_me_*` или совпадает с `POSTGRES_USER` либо `POSTGRES_DB`. В `development` и `test` заглушки допустимы для локальной проверки. Сообщение об ошибке содержит только имя переменной, но не её значение.

### mediasoup (зарезервировано)

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `MEDIASOUP_LISTEN_IP` | Адрес прослушивания Worker | `0.0.0.0` |
| `MEDIASOUP_ANNOUNCED_IP` | Публичный IP для клиентов | пусто |
| `MEDIASOUP_RTC_MIN_PORT` | Начало UDP-диапазона | `40000` |
| `MEDIASOUP_RTC_MAX_PORT` | Конец UDP-диапазона | `40049` |
| `MEDIASOUP_WORKER_COUNT` | Количество Worker | `1` |

На текущем этапе mediasoup установлен как зависимость, но Worker ещё не создаётся. Перед реализацией голоса обязательно заполните `MEDIASOUP_ANNOUNCED_IP` публичным IP VPS.

## 11. Логи и диагностика

Сервер пишет структурированные JSON-логи в stdout. В разработке при `LOG_PRETTY=true` используется `pino-pretty`.

Просмотр логов Docker:

```powershell
docker compose logs -f server
```

Если вывод в PowerShell отображает русский текст некорректно, переключите кодировку консоли:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

Или читайте перенаправленный файл:

```powershell
Get-Content .\server.out.log -Encoding UTF8
```

Секреты маскируются в логах, но не передавайте их в сообщения и не добавляйте в код.

### Частые ошибки

| Симптом | Вероятная причина | Что проверить |
|---|---|---|
| `ECONNREFUSED 127.0.0.1:5432` | PostgreSQL не запущен | `docker compose ps`, служба PostgreSQL, порт |
| `password authentication failed` | Неверный пароль или старый volume | `POSTGRES_PASSWORD`, пересоздание роли |
| `EADDRINUSE` | Порт занят | `SERVER_PORT`, `Get-NetTCPConnection` |
| `npm.ps1 cannot be loaded` | Политика PowerShell | Используйте `npm.cmd` |
| `Cannot find package 'pino-pretty'` | Нет devDependencies | `npm.cmd install` или `LOG_PRETTY=false` |
| `ERR_MODULE_NOT_FOUND` для `shared/protocol.js` | Не хватает `shared/package.json` | Проверьте структуру и `type: module` |
| health возвращает `503` | База недоступна | Логи `module=database`, `docker compose ps`; liveness проверьте через `/health/live` |
| Сервер не запускается с ошибкой `POSTGRES_PASSWORD` | В production используется заглушка или пароль совпадает с ролью/базой | Задайте уникальный пароль в `.env` |
| Docker Compose не запускается | Docker Desktop не установлен | Установите Docker Desktop с Linux-контейнерами |
| Ошибка сборки mediasoup | Нет prebuilt-бинарника | Используйте Linux-контейнер; Python в проект не добавляется |

## 12. Порты

| Порт | Протокол | Назначение | Публичный доступ |
|---|---|---|---|
| `3000` | TCP | HTTP и WebSocket | Да, пока напрямую; в будущем через TLS-прокси |
| `40000-40049` | UDP | Диапазон mediasoup RTC (будущий этап) | Да, для голосовых клиентов |
| `5432` | TCP | PostgreSQL | Нет; только внутри Docker-сети или loopback для разработки |
| `22` | TCP | SSH-администрирование | Да, ограничить по IP |
| `80`, `443` | TCP | Будущий reverse proxy и TLS | Пока не используются |

На VPS откройте в firewall только необходимые порты. Не публикуйте PostgreSQL наружу.

## 13. Перенос на Ubuntu Server 24.04

Краткий порядок:

1. Установить Docker Engine и Docker Compose plugin.
2. Скопировать проект на сервер.
3. Создать `.env`, выставить права `600`.
4. Заполнить пароли; `MEDIASOUP_ANNOUNCED_IP` указать перед развёртыванием голосового модуля (на этапе фундамента допускается пустое значение).
5. Настроить firewall и UDP-диапазон.
6. Выполнить `docker compose build`, `docker compose up -d`.
7. Применить миграции.
8. Проверить `/health/live`, `/health/ready` и логи.

Подробная инструкция: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## 14. Ограничения текущего этапа

- Нет Discord OAuth2, Bloxlink, PRC API V2, Proximity, Radio, PTT и передачи голоса.
- Клиент — только безопасный каркас, без подключения к серверу и микрофону.
- Docker в среде разработки отсутствовал, поэтому `docker compose config`, сборка образа и запуск контейнеров не выполнялись. Конфигурация проверена статически.
- Локальная проверка PostgreSQL выполнена на переносимом PostgreSQL 17.11 для Windows. Образ `postgres:17-alpine` в Docker не запускался.
- Корректное завершение по `SIGINT`/`SIGTERM` проверено unit-тестами менеджера остановки. Реальная доставка POSIX-сигналов на Windows не проверялась; окончательная проверка нужна на Linux/Docker.
- mediasoup `3.32.2` установлен, Worker успешно запускался на Windows, но signaling и голосовой модуль не реализованы.
- TLS, reverse proxy и ограничение доступа к `3000` на публичном сервере ещё не настроены.
- Окончательная бизнес-схема базы данных не создавалась.

## 15. Документация

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — модули, взаимодействие, масштабирование.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Ubuntu, Docker, firewall, UDP, backup.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — Windows, команды, Git, OpenCode/Kilo.
- [AGENTS.md](AGENTS.md) — обязательные правила для агентов и разработчиков.

## 16. Статус и лицензия

Проект приватный, лицензия не определена. Не распространяйте исходный код и конфигурацию без разрешения владельца MoscowRoleplay.
