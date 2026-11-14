# Разработка сервера на Windows

Документ описывает локальную разработку серверной части MoscowRoleplay Voice. Сервер находится в папке `server/` и устанавливается независимо от Electron-клиента.

Клиентская документация: [../../app/docs/DEVELOPMENT.md](../../app/docs/DEVELOPMENT.md).

## 1. Требования

| Инструмент | Проверенная версия | Примечание |
|---|---|---|
| Node.js | `24.13.1` | Нужна LTS-ветка Node.js 24 |
| npm | `11.8.0` | Входит в Node.js |
| Git | `2.47.0` | Git for Windows |
| PowerShell | `5.1` | Достаточно для команд ниже |
| Docker Desktop | отсутствовал | Не обязателен для разработки без контейнеров |
| PostgreSQL | `17.11` (переносимый) | Использовался для реальной проверки без Docker |

Дополнительно:

- редактор с поддержкой EditorConfig;
- терминал с кодировкой UTF-8;
- для реальной проверки голоса — два клиента и открытый UDP-диапазон.

### 1.1. Проблема с `npm.ps1`

Если PowerShell блокирует `npm.ps1`, используйте `npm.cmd`:

```powershell
npm.cmd --version
npm.cmd install
npm.cmd run verify
```

### 1.2. Кодировка консоли

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

## 2. Структура серверной части

```text
server/
├── config/                  # radio-channels.json
├── database/
│   ├── init/                # создание роли PostgreSQL в Docker
│   └── migrations/          # SQL-миграции
├── docs/                    # архитектура, развёртывание, разработка
├── scripts/
│   ├── check-syntax.js
│   ├── healthcheck.js
│   └── sync-shared.js
├── shared/                  # канонический protocol.js
├── src/
│   ├── auth/                # OAuth2, сессии, Bloxlink
│   ├── bloxlink/
│   ├── config/
│   ├── database/
│   ├── discord/
│   ├── game/
│   ├── http/
│   ├── mediasoup/
│   ├── monitoring/
│   ├── prc/
│   ├── proximity/
│   ├── radio/
│   ├── roblox/
│   ├── signaling/
│   ├── utils/
│   ├── voice/
│   ├── websocket/
│   └── index.js             # сборка компонентов
├── test/                    # unit-тесты Node.js
├── .dockerignore
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── docker-compose.dev.yml
├── package.json
└── package-lock.json
```

`server/src/index.js` только собирает компоненты и управляет жизненным циклом. Бизнес-логика находится в профильных модулях.

## 3. Первичная настройка

### 3.1. Перейти в папку сервера

```powershell
Set-Location 'C:\Users\maksi\OneDrive\Рабочий стол\MoscowRoleplay Voice\server'
```

### 3.2. Создать `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

Обязательно замените:

- `POSTGRES_SUPERUSER_PASSWORD` — пароль суперпользователя контейнера PostgreSQL;
- `POSTGRES_PASSWORD` — пароль роли приложения `mrv_app`.

Сгенерировать пароли:

```powershell
function New-StrongPassword {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

"POSTGRES_SUPERUSER_PASSWORD: $(New-StrongPassword)"
"POSTGRES_PASSWORD: $(New-StrongPassword)"
```

Файл `server/.env` исключён из Git. Никогда не выводите его содержимое в чат, логи и отчёты.

Для локальной разработки без интеграций можно оставить пустыми:

- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`;
- `DISCORD_GUILD_ID`, `DISCORD_ROLE_GUILD_IDS`;
- `DISCORD_BOT_TOKEN`;
- `BLOXLINK_API_KEY`;
- `PRC_SERVER_KEY`.

Сервер запустится, health-check будет работать, но вход, привязка Roblox, proximity и закрытые радиоканалы будут отключены с предупреждениями в логах.

Формат радиоканалов и групп доступа описан в `server/config/README.md`. Для ролей на нескольких Discord-серверах задайте `DISCORD_ROLE_GUILD_IDS`; бот должен состоять на каждом сервере из списка.

### 3.3. Установить зависимости

```powershell
Set-Location .\server
npm.cmd install
```

Воспроизводимая установка:

```powershell
npm.cmd ci
```

### 3.4. Подготовить PostgreSQL

**Вариант A. Docker Desktop (из папки `server`):**

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
```

Порт публикуется только на `127.0.0.1:5432`. Init-скрипт создаёт роль приложения при первом создании тома.

**Вариант B. Локальный PostgreSQL 17:**

```sql
CREATE ROLE mrv_app LOGIN PASSWORD 'сильный_пароль';
CREATE DATABASE moscowroleplay_voice OWNER mrv_app;
```

Укажите в `server/.env` фактические параметры подключения.

### 3.5. Применить миграции

```powershell
Set-Location .\server
npm.cmd run migrate
```

При первом запуске применяются две миграции. Повторный запуск безопасен: применённые миграции пропускаются, контрольные суммы проверяются.

## 4. Запуск сервера

```powershell
Set-Location .\server
npm.cmd run dev
```

Без режима наблюдения:

```powershell
npm.cmd start
```

Сервер читает `.env` из папки `server/`. Переменные окружения имеют приоритет над файлом.

Сервер запустится, даже если mediasoup не смог создать Worker: голос будет отключён, остальные функции продолжат работу. Причина будет в логах.

## 5. Проверки

### 5.1. Синтаксис

```powershell
Set-Location .\server
npm.cmd run check
```

Скрипт `server/scripts/check-syntax.js` проверяет `server/src`, `server/test`, `server/scripts` и `server/shared`.

### 5.2. Синхронизация протокола

```powershell
npm.cmd run shared:check
```

Канонический источник — `server/shared/protocol.js`, копия клиента — `app/shared/protocol.js`. Если копии различаются:

```powershell
npm.cmd run shared:sync
```

### 5.3. Тесты

```powershell
npm.cmd test
```

Проверяются:

- валидация конфигурации, включая production-запрет заглушек;
- протокол WebSocket и все типы сообщений;
- liveness/readiness и HTTP-маршруты;
- менеджер корректной остановки;
- Proximity Engine: grid, гистерезис, stale-снимок, diff Consumers;
- Radio Engine: открытые и закрытые каналы, занятость, выход, transport reset.

### 5.4. Полная проверка

```powershell
npm.cmd run verify
```

Команда последовательно запускает `check`, `shared:check` и `test`.

### 5.5. Health-check

```powershell
curl.exe -i http://127.0.0.1:3000/health/live
curl.exe -i http://127.0.0.1:3000/health/ready
curl.exe -i http://127.0.0.1:3000/health
```

Readiness и `/health` возвращают `200` и `status: "ok"` при доступной базе. Если PostgreSQL недоступен — `503` и `status: "degraded"`. Liveness продолжает возвращать `200`, пока процесс жив.

Информационные блоки:

- `checks.game` — состояние PRC и poller;
- `checks.voice` — mediasoup и signaling.

Они не влияют на готовность сервера.

### 5.6. Проверка WebSocket

```powershell
Set-Location .\server
node --input-type=module -e "import WebSocket from 'ws'; const ws = new WebSocket('ws://127.0.0.1:3000/ws'); ws.on('message', (data) => { console.log(data.toString()); ws.close(); });"
```

Ожидается `server.hello`.

Проверка ping/pong:

```powershell
node --input-type=module -e "import WebSocket from 'ws'; const ws = new WebSocket('ws://127.0.0.1:3000/ws'); ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'client.ping', id: 'test_1', data: { nonce: 'hello' } }))); ws.on('message', (data) => { console.log(data.toString()); ws.close(); });"
```

Ожидается `server.hello` и `server.pong` с тем же `id`.

### 5.7. Проверка mediasoup

```powershell
Set-Location .\server
node --input-type=module -e "import { createWorker } from 'mediasoup'; const worker = await createWorker({ logLevel: 'warn' }); console.log('worker pid:', worker.pid); await worker.close();"
```

На Windows Worker запускался успешно. Пакет `mediasoup` при установке скачивает заранее собранный Worker для поддерживаемой платформы; если готового бинарника нет, может потребоваться локальная сборка C++. Python в проект не добавляется.

## 6. Docker

Все команды выполняются из папки `server`:

```powershell
Set-Location .\server
docker compose config
docker compose build
docker compose up -d
docker compose ps
```

Контекст сборки — `server/`. Dockerfile не копирует `app/`, `node_modules` и клиентские зависимости.

Применение миграций в контейнере:

```powershell
docker compose exec server node src/database/migrate-cli.js
```

В среде, где создавался проект, Docker отсутствовал. Конфигурация Compose проверялась статически: YAML, сервисы, healthcheck, volume, ограничения логов, TCP/UDP-порты и переменные из `.env.example`. Реальная сборка образа не выполнялась.

## 7. Локальная проверка интеграций

### 7.1. Discord OAuth2

1. Создайте тестовое приложение Discord.
2. Добавьте redirect URI `http://localhost:3000/auth/discord/callback`.
3. Заполните `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI` в `server/.env`.
4. Установите `SESSION_COOKIE_SECURE=false` (допустимо в development).
5. Запустите сервер и клиент, нажмите «Войти через Discord».

Если вход не завершается, проверьте:

- точное совпадение redirect URI;
- что сервер доступен по `http://localhost:3000`;
- логи `module=auth-routes` и `module=auth`;
- что порт не занят другим процессом.

### 7.2. Bloxlink

Без реального ключа Bloxlink привязка недоступна. Не имитируйте её: сервер должен явно возвращать `bloxlink_disabled`. Для проверки используйте тестовый Discord-сервер с установленным Bloxlink и ключом Server API.

### 7.3. PRC

Без `PRC_SERVER_KEY` poller отключается. Не подменяйте его фиктивными координатами в рабочем коде. Для unit-тестов используйте mock `fetchImpl`, как это сделано в существующих тестах.

### 7.4. Голос

Минимальная проверка:

1. Запустите сервер с `MEDIASOUP_ANNOUNCED_IP`, равным локальному IP компьютера.
2. Запустите два клиента на разных ПК или в разных профилях.
3. Войдите двумя разными Discord-аккаунтами.
4. Убедитесь, что оба находятся на тестовом сервере ER:LC и привязаны к Roblox.
5. Проверьте proximity, радио, PTT и переподключение.

Один клиент не заменяет проверку двух участников.

## 8. Правила кода

- Сервер: ES Modules, `import`/`export`, без `require`.
- Отступы: 2 пробела.
- Точки с запятой обязательны.
- Строки: одинарные кавычки, кроме JSON и HTML.
- Комментарии и сообщения для пользователя — на русском.
- Идентификаторы, имена пакетов и API — на английском.
- Коды ошибок — `snake_case`.
- Логи — структурированные JSON через `pino`.

Не размещайте бизнес-логику в `server/src/index.js`.

Не создавайте фиктивные реализации mediasoup, Discord, Bloxlink или PRC API. Если функция не реализована, она должна отсутствовать и быть задокументирована.

Общий протокол хранится только в `server/shared/protocol.js`. Не дублируйте формат сообщений в сервере и клиенте. Копию `app/shared/protocol.js` синхронизируйте командой `npm run shared:sync`.

## 9. Правила Git

1. Перед изменениями выполните `git status`.
2. Не трогайте чужие незакоммиченные изменения.
3. Делайте осмысленные коммиты в формате Conventional Commits:

```text
feat: завершить интеграцию сервера и клиента
fix: исправить проверку конфигурации
docs: описать запуск на Ubuntu
```

4. Не коммитьте `.env`, секреты, `node_modules`, логи, дампы базы и временные файлы.
5. Не используйте `git reset --hard`, `git push --force` и rebase опубликованной истории без прямого согласия.
6. Не переписывайте историю Git.
7. Перед коммитом проверьте:

```powershell
git status
git diff --stat
git diff --cached --stat
```

8. Убедитесь, что `.env` игнорируется:

```powershell
git check-ignore -v server/.env
```

## 10. Ограничения локальной среды

- Docker Desktop может отсутствовать; тогда Compose проверяется только статически.
- WSL2 может отсутствовать; Linux-совместимость mediasoup локально не проверяется.
- Windows не доставляет POSIX-сигналы `SIGINT`/`SIGTERM` так же, как Linux. Graceful shutdown проверен unit-тестами; окончательная проверка нужна в Linux/Docker.
- Реальная доставка UDP и работа mediasoup за NAT требуют VPS.
- Discord, Bloxlink и PRC нельзя полноценно проверить без реальных ключей.
- Локальный запуск не заменяет проверку на Ubuntu Server 24.04.

## 11. Чек-лист перед коммитом

- [ ] `git status` просмотрен.
- [ ] `.env` и секреты не в индексе.
- [ ] `node_modules`, логи, `app/release`, `app/renderer/dist` не в индексе.
- [ ] `npm.cmd run verify` в `server` пройден.
- [ ] `npm.cmd run shared:sync` выполнен, если менялся протокол.
- [ ] Документация обновлена на русском языке.
- [ ] Новые зависимости обоснованы и проверены в npm registry.
- [ ] Изменения оставлены в запускаемом состоянии.
