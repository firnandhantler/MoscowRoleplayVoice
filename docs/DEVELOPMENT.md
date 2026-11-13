# Разработка на Windows

Документ описывает локальную разработку MoscowRoleplay Voice на Windows 10, обязательные проверки и правила совместной работы. Целевая серверная ОС — Ubuntu Server 24.04 LTS, поэтому все изменения должны оставаться совместимыми с Linux.

## 1. Требования к среде

Проверенные версии инструментов:

| Инструмент | Проверенная версия | Примечание |
|---|---|---|
| Node.js | `24.13.1` | Нужна LTS-ветка Node.js 24 |
| npm | `11.8.0` | Входит в Node.js |
| Git | `2.47.0` | Git for Windows |
| PowerShell | `5.1` | Достаточно для команд ниже |
| Docker Desktop | отсутствовал | Не обязателен для разработки без контейнеров |
| PostgreSQL | `17.11` (переносимый) | Использовался для реальной проверки без Docker |

Дополнительно:

- редактор с поддержкой EditorConfig (`.editorconfig` уже в проекте);
- терминал с кодировкой UTF-8;
- микрофон и наушники для проверки голоса.

### 1.1. Проблема с `npm.ps1`

В некоторых системах политика выполнения PowerShell блокирует `npm.ps1`:

```text
npm.ps1 cannot be loaded because running scripts is disabled on this system
```

Это ограничение среды, а не ошибка проекта. Используйте `npm.cmd`:

```powershell
npm.cmd --version
npm.cmd install
npm.cmd run verify
```

### 1.2. Кодировка консоли

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

Перенаправленные логи читайте явно:

```powershell
Get-Content .\server.out.log -Encoding UTF8
```

## 2. Первичная настройка

### 2.1. Перейти в корень проекта

```powershell
Set-Location 'C:\Users\maksi\OneDrive\Рабочий стол\MoscowRoleplay Voice'
```

### 2.2. Проверить состояние Git

```powershell
git status
git branch --show-current
```

Не удаляйте и не перезаписывайте чужие незакоммиченные изменения.

### 2.3. Создать `.env`

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

Файл `.env` исключён из Git. Никогда не выводите его содержимое в чат, логи и отчёты.

Для локальной разработки без интеграций можно оставить пустыми:

- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`;
- `DISCORD_BOT_TOKEN`;
- `BLOXLINK_API_KEY`;
- `PRC_SERVER_KEY`.

Сервер запустится, health-check будет работать, но вход, привязка Roblox, proximity и закрытые радиоканалы будут отключены с предупреждениями в логах.

### 2.4. Установить зависимости

```powershell
Set-Location .\server
npm.cmd install

Set-Location ..\client
npm.cmd install

Set-Location ..
```

Воспроизводимая установка по lock-файлам:

```powershell
Set-Location .\server
npm.cmd ci
```

### 2.5. Подготовить PostgreSQL

**Вариант A. Docker Desktop:**

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
```

Порт публикуется только на `127.0.0.1:5432`. Init-скрипт создаёт роль приложения при первом создании тома.

**Вариант B. Локальный PostgreSQL 17:**

```sql
CREATE ROLE mrv_app LOGIN PASSWORD 'сильный_пароль';
CREATE DATABASE moscowroleplay_voice OWNER mrv_app;
```

Укажите в `.env` фактические параметры подключения.

**Вариант C. Переносимый PostgreSQL без установки в систему:**

1. Скачайте официальные Windows-бинарники PostgreSQL 17.
2. Распакуйте архив во временный каталог.
3. Выполните `initdb` с паролем суперпользователя.
4. Запустите `pg_ctl start` на отдельном порту, например `55432`.
5. Создайте базу и роль приложения.
6. Укажите этот порт в `.env`.

Не храните временные пароли в проекте. Тестовые секреты должны находиться только во временном каталоге вне репозитория.

### 2.6. Применить миграции

```powershell
Set-Location .\server
npm.cmd run migrate
```

При первом запуске применяются две миграции. При повторном:

```json
{"appliedCount":0,"total":2,"msg":"Применение миграций завершено"}
```

Это подтверждает идемпотентность механизма миграций.

## 3. Команды запуска

### 3.1. Сервер

```powershell
Set-Location .\server
npm.cmd run dev
```

Без режима наблюдения:

```powershell
npm.cmd start
```

Сервер читает `.env` из корня проекта. Переменные окружения имеют приоритет над файлом.

### 3.2. Electron-клиент

```powershell
Set-Location .\client
npm.cmd start
```

`start` собирает renderer через esbuild и запускает Electron. Для подключения к локальному серверу дополнительная конфигурация не нужна: по умолчанию используется `http://localhost:3000`.

Для другого адреса создайте `client/client-config.json`:

```json
{
  "serverUrl": "https://voice.example.com",
  "wsPath": "/ws"
}
```

Или задайте `MVR_SERVER_URL` и `MVR_WS_PATH` в окружении.

### 3.3. Одновременный запуск

Откройте два терминала PowerShell:

- терминал 1: PostgreSQL и `npm.cmd run dev` в `server`;
- терминал 2: `npm.cmd start` в `client`.

Не запускайте два экземпляра сервера на одном порту: второй завершится с `EADDRINUSE`.

## 4. Команды проверки

### 4.1. Синтаксис сервера

```powershell
Set-Location .\server
npm.cmd run check
```

Скрипт `server/scripts/check-syntax.js` рекурсивно проверяет `server/src`, `server/test`, `server/scripts` и `shared` (46 файлов на этапе 5/5).

### 4.2. Тесты сервера

```powershell
Set-Location .\server
npm.cmd test
```

Проверяются:

- валидация конфигурации, включая production-запрет заглушек;
- протокол WebSocket и все типы сообщений;
- liveness/readiness и HTTP-маршруты;
- менеджер корректной остановки;
- Proximity Engine: grid, гистерезис, stale-снимок, diff Consumers;
- Radio Engine: открытые и закрытые каналы, занятость, выход, transport reset.

На этапе 5/5: **58 из 58 тестов**.

### 4.3. Полная проверка сервера

```powershell
Set-Location .\server
npm.cmd run verify
```

Команда последовательно запускает `check` и `test`.

### 4.4. Проверка клиента

```powershell
Set-Location .\client
npm.cmd run check
npm.cmd run build
```

`check` проверяет синтаксис 23 файлов (main, preload, renderer, scripts). `build` собирает иконку и `renderer/dist/app.js`.

### 4.5. Сборка установщика

```powershell
Set-Location .\client
npm.cmd run dist
```

Результат: `client\release\MoscowRoleplay-Voice-Setup-0.5.0.exe`.

Для быстрой проверки без установщика:

```powershell
npm.cmd run pack
```

### 4.6. Health-check

```powershell
curl.exe -i http://127.0.0.1:3000/health/live
curl.exe -i http://127.0.0.1:3000/health/ready
curl.exe -i http://127.0.0.1:3000/health
```

Readiness и `/health` возвращают `200` и `status: "ok"` при доступной базе. Если PostgreSQL недоступен — `503` и `status: "degraded"`. Liveness продолжает возвращать `200`, пока процесс жив.

В readiness есть информационные блоки:

- `checks.game` — состояние PRC и poller;
- `checks.voice` — mediasoup и signaling.

Они не влияют на готовность сервера.

### 4.7. Проверка WebSocket

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

### 4.8. Проверка Docker Compose

При установленном Docker:

```powershell
docker compose config
docker compose build
docker compose up -d
docker compose ps
```

В среде, где создавался проект, Docker отсутствовал. Конфигурация Compose проверялась статически: YAML, сервисы, healthcheck, volume, ограничения логов, TCP/UDP-порты и переменные из `.env.example`. Реальная сборка образа не выполнялась.

### 4.9. Проверка mediasoup

```powershell
Set-Location .\server
node --input-type=module -e "import { createWorker } from 'mediasoup'; const worker = await createWorker({ logLevel: 'warn' }); console.log('worker pid:', worker.pid); await worker.close();"
```

На Windows Worker запускался успешно. Пакет `mediasoup` при установке скачивает заранее собранный Worker для поддерживаемой платформы; если готового бинарника нет, может потребоваться локальная сборка C++. Python в проект не добавляется.

Полноценная проверка голоса требует двух клиентов, микрофонов и открытого UDP-диапазона.

## 5. Локальная проверка интеграций

### 5.1. Discord OAuth2

1. Создайте тестовое приложение Discord.
2. Добавьте redirect URI `http://localhost:3000/auth/discord/callback`.
3. Заполните `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`.
4. Установите `SESSION_COOKIE_SECURE=false` (допустимо в development).
5. Запустите сервер и клиент, нажмите «Войти через Discord».

Если вход не завершается, проверьте:

- точное совпадение redirect URI;
- что сервер доступен по `http://localhost:3000`;
- логи `module=auth-routes` и `module=auth`;
- что порт не занят другим процессом.

### 5.2. Bloxlink

Без реального ключа Bloxlink привязка недоступна. Не имитируйте её: сервер должен явно возвращать `bloxlink_disabled`. Для проверки используйте тестовый Discord-сервер с установленным Bloxlink и ключом Server API.

### 5.3. PRC

Без `PRC_SERVER_KEY` poller отключается. Не подменяйте его фиктивными координатами в рабочем коде. Для unit-тестов используйте mock `fetchImpl`, как это сделано в существующих тестах.

### 5.4. Голос

Минимальная проверка:

1. Запустите сервер с `MEDIASOUP_ANNOUNCED_IP`, равным локальному IP компьютера.
2. Запустите два клиента на разных ПК или в разных профилях.
3. Войдите двумя разными Discord-аккаунтами.
4. Убедитесь, что оба находятся на тестовом сервере ER:LC и привязаны к Roblox.
5. Проверьте proximity, радио, PTT и переподключение.

Один клиент не заменяет проверку двух участников.

## 6. Структура и правила кода

- Сервер: ES Modules, `import`/`export`, без `require`.
- Клиент: CommonJS для `main.js`, `preload.js` и модулей главного процесса.
- Renderer: ES Modules, сборка esbuild в IIFE.
- Отступы: 2 пробела.
- Точки с запятой обязательны.
- Строки: одинарные кавычки, кроме JSON и HTML.
- Комментарии и сообщения для пользователя — на русском.
- Идентификаторы, имена пакетов и API — на английском.
- Коды ошибок — `snake_case`.
- Логи — структурированные JSON через `pino`.

Не размещайте бизнес-логику в `server/src/index.js`. Точка входа только собирает компоненты.

Не создавайте фиктивные реализации mediasoup, Discord, Bloxlink или PRC API. Если функция не реализована, она должна отсутствовать и быть задокументирована.

Общий протокол хранится только в `shared/protocol.js`. Не дублируйте формат сообщений в клиенте и сервере.

## 7. Правила Git

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
7. Перед коммитом проверьте, что попадёт в индекс:

```powershell
git status
git diff --stat
git diff --cached --stat
```

8. Убедитесь, что `.env` игнорируется:

```powershell
git check-ignore -v .env
```

### 7.1. Проверка на секреты

Перед коммитом убедитесь, что в индекс не попали:

- `.env` и локальные варианты;
- `*.pem`, `*.key`, `*.p12`, `*.pfx`;
- `secrets/`, `credentials/`;
- дампы и архивы базы;
- логи и PID-файлы;
- `client/release/` и `client/renderer/dist/`.

Не выводите значения переменных окружения в терминал и отчёты.

## 8. Совместная работа OpenCode и Kilo CLI

Оба инструмента обязаны прочитать `AGENTS.md` перед изменениями.

Порядок работы:

1. Прочитать `AGENTS.md`.
2. Проверить `git status`.
3. Изучить существующие файлы, не перезаписывать их без проверки.
4. Внести изменения.
5. Запустить `npm.cmd run verify` в `server`, `npm.cmd run check` в `client`.
6. При изменении клиентской сборки выполнить `npm.cmd run build`.
7. Обновить документацию при изменении поведения.
8. Показать список изменённых файлов.
9. Подготовить отдельный коммит.
10. Не переходить к следующему этапу без команды владельца.

Правила для агентов:

- не изменять `opencode.json` и настройки Kilo Gateway без необходимости;
- не создавать конфликтующие конфигурации агентов;
- не имитировать результаты проверок;
- честно сообщать о недоступных инструментах;
- оставлять проект в запускаемом состоянии.

## 9. Отладка типовых проблем

| Симптом | Причина | Решение |
|---|---|---|
| `npm.ps1 cannot be loaded` | Политика PowerShell | Используйте `npm.cmd` |
| `ECONNREFUSED 127.0.0.1:5432` | PostgreSQL не запущен | Запустите базу или проверьте `POSTGRES_PORT` |
| `password authentication failed` | Неверный пароль или старый том | Проверьте `.env`; смените пароль роли |
| `EADDRINUSE` | Порт занят | Измените `SERVER_PORT` или остановите лишний процесс |
| `503 degraded` | База недоступна | Логи `module=database`; liveness через `/health/live` |
| Ошибка `POSTGRES_PASSWORD` | Заглушка или совпадение с ролью/базой | Задайте уникальный пароль |
| `auth_disabled` | Не заданы `DISCORD_*` | Задайте все три переменные |
| `bloxlink_disabled` | Нет ключа Bloxlink | Ключ и `DISCORD_GUILD_ID` |
| `voice_unavailable` | mediasoup не запустился | Логи `module=mediasoup` |
| `Cannot find package 'pino-pretty'` | Нет devDependencies | `npm.cmd install` или `LOG_PRETTY=false` |
| `ERR_MODULE_NOT_FOUND` для `shared/protocol.js` | Повреждена структура `shared` | Проверьте `shared/package.json` и `type: module` |
| Русский текст искажён | Кодировка консоли | `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` |
| `docker: command not found` | Docker не установлен | Установите Docker Desktop |
| Ошибка сборки mediasoup | Нет prebuilt-бинарника | Linux-контейнер или поддерживаемая платформа |

### 9.1. Проверка занятого порта

```powershell
Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue |
  Select-Object State, LocalAddress, LocalPort, OwningProcess
```

### 9.2. Остановка зависшего Node.js-процесса

```powershell
Get-Process node -ErrorAction SilentlyContinue |
  Select-Object Id, ProcessName, StartTime
```

Останавливайте только свой процесс:

```powershell
Stop-Process -Id <PID>
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
- [ ] `node_modules`, логи, `client/release`, `client/renderer/dist` не в индексе.
- [ ] `npm.cmd run verify` в `server` пройден.
- [ ] `npm.cmd run check` в `client` пройден.
- [ ] `npm.cmd run build` в `client` пройден, если менялся renderer.
- [ ] Документация обновлена на русском языке.
- [ ] Новые зависимости обоснованы и проверены в npm registry.
- [ ] Границы текущего этапа не нарушены.
- [ ] Изменения оставлены в запускаемом состоянии.
